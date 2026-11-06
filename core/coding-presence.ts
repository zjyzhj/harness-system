/**
 * Bot 终端：每个工程目录一块常驻 PTY。
 * 默认开 shell；派 Coding CLI 时同槽切到 agent 程序。
 * 当前看着的是其中一个；换目录只切换视线，不关掉别的工程。
 * 屏幕字节同时进 xterm（界面）和这里的 XtermScreen（Bot 读到的文字）。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strippedCliEnv } from "./adapters/cli";
import { agentBin, pickCodingAgent, probeCodingAgents } from "./coding-agents";
import type { CliAgentRequest, CliAgentResult } from "./cli-agent";
import { FrameDecoder, XtermScreen, encodeFrame } from "./term-screen";

export const PRESENCE_IDLE_MS = 30 * 60_000;
/** 一直停在 starting（桥接挂了 / 没起来）就收尸，避免空面板僵尸 */
export const STARTING_TIMEOUT_MS = 8_000;
export const TERM_COLS = 100;
export const TERM_ROWS = 30;
/** 一个 Bot 同时留着的活终端上限。再开新的就关掉最久没用、且不是正在看的那块。 */
export const MAX_LIVE_TERMINALS = 4;

/** 本机 python3；没有就没法起 PTY 桥 */
export function resolvePython3(): string | null {
  for (const c of ["/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"]) {
    if (existsSync(c)) return c;
  }
  try {
    const r = spawnSync("which", ["python3"], { encoding: "utf8" });
    const p = r.stdout?.trim();
    if (r.status === 0 && p && existsSync(p)) return p;
  } catch { /* ignore */ }
  return null;
}

export type PresencePhase = "starting" | "busy" | "idle" | "exited";
/** 进程开着时，屏幕在干什么。composing = 字停在输入框还没跑。 */
export type TerminalPosture = "composing" | "prompt" | "running";
/** 这块终端里跑的是 shell，还是某家 Coding CLI。 */
export type TermProgram = { kind: "shell" } | { kind: "agent"; cli: string };

export interface CodingPresenceView {
  botId: string;
  /** 显示名：shell 或 claude / cursor / codex */
  cli: string;
  program: TermProgram;
  cwd: string;
  phase: PresencePhase;
  resident: boolean;
  pid?: number;
  startedAt: number;
  lastActiveAt: number;
  task?: string;
  exitReason?: string;
  /** 当前屏幕全文，界面和工具结果用同一份 */
  screen: string;
  /** 给易变上下文的短尾 */
  screenTail: string;
  /** 这个 Bot 另外还开着的工程 */
  others?: Array<{ cwd: string; cli: string; program: TermProgram; phase: PresencePhase; posture?: TerminalPosture }>;
  /** 进程开着时屏幕的姿态。退出后没有。 */
  posture?: TerminalPosture;
  /** 非错误提示：如「打开」撞上活着的 Coding CLI、视线在冷目录等 */
  notice?: string;
}

/** 登录壳；没有 $SHELL 就试 zsh/bash/sh。 */
export function resolveShellBin(): string {
  const env = process.env.SHELL?.trim();
  if (env && existsSync(env)) return env;
  for (const c of ["/bin/zsh", "/bin/bash", "/bin/sh"]) if (existsSync(c)) return c;
  return "/bin/sh";
}

export function programLabel(program: TermProgram): string {
  return program.kind === "shell" ? "shell" : program.cli;
}

export function formatPresenceLine(view: CodingPresenceView | null, now = Date.now()): string {
  if (!view) return "";
  if (view.phase === "exited" && now - view.lastActiveAt > PRESENCE_IDLE_MS && !view.others?.length && !view.notice) return "";
  const state =
    view.phase === "busy" ? "刚往终端里输入，正在看屏幕"
    : view.phase === "starting" ? "正在打开"
    : view.phase === "exited" ? `已关掉${view.exitReason ? `（${view.exitReason}）` : ""}。需要时再用 term.open 或 cli.agent 打开`
    : "开着，可以继续输入";
  const prog = view.program?.kind === "agent" ? view.cli : "shell";
  const head = `【终端】${prog} · ${view.cwd} · ${state}`;
  const note = view.notice ? `\n${view.notice}` : "";
  const extra = view.others?.length
    ? `\n另外还开着：${view.others.map((o) => `${o.cwd}（${programLabel(o.program ?? { kind: "agent", cli: o.cli })} · ${faceWord(o.phase, o.posture)}）`).join("、")}`
    : "";
  const seen = (view.screen || view.screenTail || "").trim();
  const body = seen.length > 4000 ? seen.slice(seen.length - 4000) : seen;
  const alive = view.phase !== "exited";
  const pose = alive ? postureSentence(view.posture ?? terminalPosture(seen)) : "";
  const hand = alive
    ? `\n${pose}\n按键用 term.keys（或 cli.term keys：down、up、enter、tab、esc、ctrl-c），按这一屏决定，不要套固定顺序。`
    : "";
  return body ? `${head}${note}${extra}${hand}\n${body}` : `${head}${note}${extra}${hand}`;
}

/** 从眼前这一屏判断：字在框里、空着等输入，还是已经在跑。 */
export function terminalPosture(screen: string): TerminalPosture {
  const text = screen
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
  // 明确「还在跑」信号优先
  if (/esc to interrupt/i.test(text) || /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(text)) return "running";
  const nonempty = text.split("\n").map((l) => l.replace(/\s+$/g, "")).filter((l) => l.trim());
  const tail = nonempty.slice(-10);
  const last = tail.at(-1) ?? "";
  const recent = tail.join("\n");
  // Cursor：已停在 follow-up，不算正在跑（有无后续字都当等输入）
  if (/Add a follow-up/i.test(recent)) return "prompt";
  if (/^[>❯]\s+\S/.test(last) || tail.some((l) => /^[>❯]\s+\S/.test(l))) return "composing";
  if (/^[>❯]\s*$/.test(last) || !nonempty.length) return "prompt";
  // 尾部像路径提示（~/… 或绝对路径单独一行）→ 等下一句，不要默认「正在跑」
  if (/^~\//.test(last) || /^\/[\w./-]+$/.test(last)) return "prompt";
  // 无打断/转圈信号时默认当空闲等输入，避免 Cursor 收尾后 UI 卡住「正在跑」
  return "prompt";
}

export function postureSentence(posture: TerminalPosture): string {
  if (posture === "composing") {
    return "进程开着。字停在输入框里，还没开始跑。下一步用 term.keys（或 cli.term keys），data 填 enter，把已经打好的字送出去。不要说终端不在线，也不要重新打开。";
  }
  if (posture === "prompt") {
    return "进程开着，停在空的输入行。要做事就打进这一句再 enter。不要说终端不在线，也不要重新打开。";
  }
  return "进程开着，屏幕在往下走。看下面的内容再决定下一步。不要说终端不在线，也不要重新打开。";
}

function faceWord(phase: PresencePhase, posture?: TerminalPosture): string {
  if (phase === "starting") return "正在打开";
  if (phase === "exited") return "已关掉";
  // 屏幕姿态优先：busy 等待安静时若屏上已是 follow-up/空闲，不要仍报「正在跑」
  if (posture === "composing") return "等送出";
  if (posture === "prompt") return "等下一句";
  if (posture === "running" || phase === "busy") return "正在跑";
  return "等下一句";
}

function taskLine(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, 500);
}

const TERM_KEYS: Record<string, string> = {
  down: "\u001b[B", arrowdown: "\u001b[B", "下": "\u001b[B", "向下": "\u001b[B",
  up: "\u001b[A", arrowup: "\u001b[A", "上": "\u001b[A", "向上": "\u001b[A",
  left: "\u001b[D", arrowleft: "\u001b[D", "左": "\u001b[D",
  right: "\u001b[C", arrowright: "\u001b[C", "右": "\u001b[C",
  enter: "\r", return: "\r", "回车": "\r",
  tab: "\t",
  esc: "\u001b", escape: "\u001b",
  space: " ",
  backspace: "\u007f",
  "ctrl-c": "\u0003", "ctrl+c": "\u0003", "c-c": "\u0003",
};

/** 把 down、enter 这类名字变成终端真的能认的按键。已经是控制字节就原样送。 */
export function decodeTermKeys(raw: string): { data: string } | { error: string } {
  const text = raw.trim();
  if (!text) return { error: "keys 需要 data，例如 down、enter，或 down enter" };
  if (/[\u0000-\u001b]/.test(text)) return { data: text };
  const decoded = text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\e/g, "\u001b");
  if (decoded !== text && /[\u0000-\u001b]/.test(decoded)) return { data: decoded };
  const parts = decoded.split(/[\s,]+/).filter(Boolean);
  const out: string[] = [];
  const unknown: string[] = [];
  for (const p of parts) {
    const key = TERM_KEYS[p.toLowerCase()] ?? TERM_KEYS[p];
    if (key) out.push(key);
    else if ([...p].length === 1) out.push(p);
    else unknown.push(p);
  }
  if (unknown.length) return { error: `不认识的按键：${unknown.join("、")}。用 down、up、left、right、enter、tab、esc、space、ctrl-c，或单个字母。` };
  return { data: out.join("") };
}

export function canonCodingCwd(cwd: string): string {
  const abs = resolve(cwd);
  try {
    return existsSync(abs) ? realpathSync(abs) : abs;
  } catch {
    return abs;
  }
}

/** 一个 Bot 记住的工程目录上限。开着的终端另有上限，记在名单里不等于已经打开。 */
export const MAX_CODING_DIRS = 8;

export function codingDirList(bot: { agentCwd?: string; agentDirs?: string[] }): string[] {
  const out: string[] = [];
  const push = (raw?: string) => {
    const t = raw?.trim();
    if (!t) return;
    const c = canonCodingCwd(t);
    if (!out.includes(c)) out.push(c);
  };
  push(bot.agentCwd);
  for (const d of bot.agentDirs ?? []) push(d);
  return out.slice(0, MAX_CODING_DIRS);
}

/** 把这个目录记进名单，并当成正在看的那一个。原来的目录留着。 */
export function gazeCodingDir(bot: { agentCwd?: string; agentDirs?: string[] }, cwd: string): { agentCwd: string; agentDirs: string[] } {
  const current = canonCodingCwd(cwd);
  const rest = codingDirList({ agentCwd: current, agentDirs: codingDirList(bot) }).filter((d) => d !== current);
  return { agentCwd: current, agentDirs: [current, ...rest].slice(0, MAX_CODING_DIRS) };
}

/** 从名单拿掉。正在看的被拿掉时，视线落到剩下的第一个。 */
export function dropCodingDir(bot: { agentCwd?: string; agentDirs?: string[] }, cwd: string): { agentCwd?: string; agentDirs?: string[] } {
  const drop = canonCodingCwd(cwd);
  const rest = codingDirList(bot).filter((d) => d !== drop);
  const looking = bot.agentCwd ? canonCodingCwd(bot.agentCwd) : rest[0];
  const agentCwd = !rest.length ? undefined : looking === drop || !rest.includes(looking ?? "") ? rest[0] : looking;
  return { agentCwd, agentDirs: rest.length ? rest : undefined };
}

export function formatCodingDirLine(bot: { agentCwd?: string; agentDirs?: string[] }): string {
  const dirs = codingDirList(bot);
  if (!dirs.length) return "【工程目录】还没有。这个 bot 可以有多个工程，一个目录一块终端（默认 shell）。用户点「选择目录」添加；term.open / cli.agent 带上 cwd 也会记进名单。没写 cwd 就用正在看的那一个。";
  const looking = bot.agentCwd ? canonCodingCwd(bot.agentCwd) : dirs[0];
  const lines = dirs.map((d) => `- ${d}${d === looking ? "（正在看。没写 cwd 就用这里）" : ""}`);
  return `【工程目录】这个 bot 的工程可以有多个，下面每一个都能单独开一块终端。换目录不会关掉别的。\n${lines.join("\n")}`;
}

type SpawnLike = (
  bin: string,
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcess;

interface Slot extends CodingPresenceView {
  session?: TermSession;
  timer?: ReturnType<typeof setTimeout>;
  startWatch?: ReturnType<typeof setTimeout>;
  onProgress?: (tail: string) => void;
}

/** 握住一个真终端。stdin 是帧，屏幕是 Bot 和界面共用的那一块。 */
class TermSession {
  readonly screen = new XtermScreen(TERM_COLS, TERM_ROWS);
  private raw: string[] = [];
  private rawLen = 0;
  private seq = 0;
  private child: ChildProcess | null = null;
  private decoder = new FrameDecoder();
  private textDec = new TextDecoder("utf-8", { fatal: false });
  private aliveFlag = false;
  pid?: number;
  onOutput?: (text: string) => void;
  onExit?: (reason: string) => void;

  get alive(): boolean {
    return this.aliveFlag;
  }

  start(opts: { bin: string; cwd: string; bridge: string; python?: string; spawnFn?: SpawnLike }): void {
    const env: NodeJS.ProcessEnv = {
      ...strippedCliEnv(),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      PTY_BIN: opts.bin,
      PTY_CWD: opts.cwd,
      PTY_COLS: String(TERM_COLS),
      PTY_ROWS: String(TERM_ROWS),
    };
    const spawnFn = opts.spawnFn ?? (spawn as unknown as SpawnLike);
    const py = opts.python || "python3";
    const child = spawnFn(py, ["-u", opts.bridge], { cwd: opts.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.pid = child.pid;
    this.aliveFlag = true;
    child.stdout?.on("data", (d: Buffer | string) => {
      const buf = Buffer.isBuffer(d) ? d : Buffer.from(d);
      for (const frame of this.decoder.push(buf)) {
        if (frame.type === 1) {
          const text = this.textDec.decode(frame.payload, { stream: true });
          if (text) this.onOutput?.(text);
        } else if (frame.type === 2) {
          this.aliveFlag = false;
          this.onExit?.("进程自己退出了");
        }
      }
    });
    child.stderr?.on("data", (d: Buffer | string) => {
      const msg = (Buffer.isBuffer(d) ? d.toString("utf8") : String(d)).trim();
      if (msg) this.onOutput?.(`\n[桥接] ${msg.slice(0, 200)}\n`);
    });
    child.on("error", (err: Error) => {
      this.aliveFlag = false;
      this.onExit?.(`启动失败：${err.message}`);
    });
    child.on("close", () => {
      if (!this.aliveFlag) return;
      this.aliveFlag = false;
      this.onExit?.("进程自己退出了");
    });
  }

  write(data: string): void {
    if (!this.aliveFlag || !this.child?.stdin) return;
    this.child.stdin.write(encodeFrame(1, data));
  }

  note(text: string): number {
    this.seq += 1;
    this.raw.push(text);
    this.rawLen += text.length;
    while (this.rawLen > 200_000 && this.raw.length > 1) {
      this.rawLen -= this.raw[0].length;
      this.raw.shift();
    }
    return this.seq;
  }

  replay(): { data: string; seq: number } {
    return { data: this.raw.join(""), seq: this.seq };
  }

  resize(cols: number, rows: number): void {
    this.screen.resize(cols, rows);
    const buf = Buffer.alloc(4);
    buf.writeUInt16BE(Math.max(20, cols), 0);
    buf.writeUInt16BE(Math.max(8, rows), 2);
    try { this.child?.stdin?.write(encodeFrame(2, buf)); } catch { /* 已经关了 */ }
  }

  /** force：应用退出时立刻 SIGKILL，不等异步收尸 */
  stop(force = false): void {
    const child = this.child;
    this.aliveFlag = false;
    this.child = null;
    if (!child) return;
    try { child.stdin?.write(encodeFrame(3, "")); } catch { /* 已经关了 */ }
    try { child.stdin?.end(); } catch { /* 已经关了 */ }
    try { child.kill("SIGTERM"); } catch { /* 已经退出 */ }
    const killHard = () => {
      try { child.kill("SIGKILL"); } catch { /* 已经退出 */ }
    };
    if (force) killHard();
    else {
      const t = setTimeout(killHard, 500);
      t.unref?.();
    }
  }
}

function slotKey(botId: string, cwd: string): string {
  return `${botId}\0${cwd}`;
}

export class CodingPresence {
  private slots = new Map<string, Slot>();
  /** 这个 Bot 此刻看着的目录。没有进程也可以指着它。 */
  private current = new Map<string, string>();
  private listener: ((view: CodingPresenceView) => void) | null = null;
  private bytesListener: ((e: { botId: string; cwd: string; data: string; seq: number }) => void) | null = null;
  private pendingEmit = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private opts: {
    idleMs?: number;
    quietMs?: number;
    tapMs?: number;
    settleMs?: number;
    /** starting 超时（默认 STARTING_TIMEOUT_MS） */
    startingTimeoutMs?: number;
    bridgePath?: string;
    home?: string;
    now?: () => number;
  } = {}) {}

  setScreenListener(fn: ((view: CodingPresenceView) => void) | null): void {
    this.listener = fn;
  }

  setBytesListener(fn: ((e: { botId: string; cwd: string; data: string; seq: number }) => void) | null): void {
    this.bytesListener = fn;
  }

  snapshot(botId: string): CodingPresenceView | null {
    const cwd = this.current.get(botId);
    const s = cwd ? this.slots.get(slotKey(botId, cwd)) : undefined;
    if (!s) return null;
    return this.decorate(s);
  }

  /**
   * 给提示词 / actionGrounding：视线目录无槽时仍带上其它活终端，避免「冷 gaze 全盲」。
   * UI 仍用 snapshot（冷目录返回 null，好显示「点打开」）。
   */
  groundingSnapshot(botId: string): CodingPresenceView | null {
    const cwd = this.current.get(botId);
    const s = cwd ? this.slots.get(slotKey(botId, cwd)) : undefined;
    if (s) return this.decorate(s);
    const live = this.slotsFor(botId)
      .filter((x) => x.phase !== "exited" && x.session?.alive)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    if (!live.length) return null;
    const primary = this.decorate(live[0]!);
    if (cwd && cwd !== primary.cwd) {
      return {
        ...primary,
        notice: `正在看 ${cwd}（这目录还没开终端）。下面是另一块还开着的终端；要用 ${cwd} 先 term.open，或 focus 到已开目录。`,
      };
    }
    return primary;
  }

  list(botId: string): CodingPresenceView[] {
    return this.slotsFor(botId).filter((s) => s.phase !== "exited" || this.current.get(botId) === s.cwd).map((s) => this.decorate(s));
  }

  line(botId: string): string {
    return formatPresenceLine(this.groundingSnapshot(botId), this.opts.now?.() ?? Date.now());
  }

  screenText(botId: string, cwd?: string): string {
    const slot = this.slotOf(botId, cwd);
    return slot?.screen ?? "";
  }

  replay(botId: string, cwd?: string): { data: string; seq: number } {
    return this.slotOf(botId, cwd)?.session?.replay() ?? { data: "", seq: 0 };
  }

  /**
   * 打开这块终端。默认 shell，不依赖 Coding CLI。
   * mode=agent 时开/切到 Coding CLI（给人从 UI 直接派工或测试用）。
   * 已经开着且同类型：只切过去看；要从 shell 换成 agent 由 dispatch/cli.agent 负责停掉再起。
   */
  async openShell(botId: string, cwd: string, opts?: {
    mode?: "shell" | "agent";
    cli?: string;
    spawnImpl?: CliAgentRequest["spawnImpl"];
  }): Promise<CodingPresenceView | { error: string }> {
    const dir = canonCodingCwd(cwd);
    const mode = opts?.mode === "agent" ? "agent" : "shell";
    const existing = this.slots.get(slotKey(botId, dir));
    if (existing?.session?.alive && existing.phase !== "exited") {
      const same = mode === "shell"
        ? existing.program.kind === "shell"
        : existing.program.kind === "agent" && (!opts?.cli || existing.cli === opts.cli);
      if (same) {
        this.current.set(botId, dir);
        this.emit(existing, true);
        return this.decorate(existing);
      }
      // 要 shell 但槽上是 Coding CLI：切视线并返回现有屏（带 notice），不谎称已开 shell，也不停掉 agent
      if (mode === "shell" && existing.program.kind === "agent") {
        this.current.set(botId, dir);
        this.emit(existing, true);
        return {
          ...this.decorate(existing),
          notice: `这块终端正在跑 ${existing.cli}，没有换成 shell。要回到 shell 先 term.stop 再 term.open；或继续用 term.read / term.write / term.keys。`,
        };
      }
      this.stopSlot(existing, "这一步要换成 Coding CLI");
    }
    const opened = mode === "shell"
      ? await this.openProgram(botId, { kind: "shell", cwd: dir, spawnImpl: opts?.spawnImpl })
      : await this.openAgentSlot(botId, dir, opts?.cli, opts?.spawnImpl);
    if (!opened.ok) return { error: opened.output };
    const slot = this.slots.get(slotKey(botId, dir));
    if (!slot?.session?.alive) {
      if (slot && slot.phase !== "exited") this.markExited(slot, opened.output || "终端没有留下来");
      if (slot) this.emit(slot, true);
      return { error: opened.output || "终端没有留下来。" };
    }
    if (slot.phase === "starting") this.armIdle(slot);
    return this.decorate(slot);
  }

  /** 换看着的目录。不关别的工程里已经开着的终端。 */
  focus(botId: string, cwd: string): CodingPresenceView | null {
    const c = canonCodingCwd(cwd);
    this.current.set(botId, c);
    const s = this.slots.get(slotKey(botId, c));
    if (s) this.emit(s, true);
    return s ? this.decorate(s) : null;
  }

  resize(botId: string, cols: number, rows: number, cwd?: string): void {
    const slot = this.slotOf(botId, cwd);
    if (!slot?.session?.alive) return;
    slot.session.resize(Math.min(220, Math.max(40, cols)), Math.min(80, Math.max(8, rows)));
  }

  /** 界面上的按键。不占「正在输入」锁，打进看着的那块终端。 */
  writeRaw(botId: string, data: string, cwd?: string): boolean {
    const slot = this.slotOf(botId, cwd);
    if (!slot?.session?.alive || slot.phase === "exited" || !data) return false;
    slot.session.write(data);
    slot.lastActiveAt = this.opts.now?.() ?? Date.now();
    if (slot.phase === "idle") this.armIdle(slot);
    return true;
  }

  /** 用户或 Bot 往看着的那块终端里送字节。raw 为假时补一个回车。 */
  async type(botId: string, data: string, req: { raw?: boolean; cwd?: string; timeoutMs?: number; signal?: AbortSignal; onProgress?: (tail: string) => void }): Promise<CliAgentResult> {
    const busy = this.busySlot(botId);
    const slot = this.slotOf(botId, req.cwd);
    if (!slot?.session?.alive || slot.phase === "exited") {
      return { ok: false, cli: (slot?.cli ?? "shell") as CliAgentResult["cli"], cwd: slot?.cwd ?? "", output: "看着的这个目录还没有开着的终端。先用 term.open 打开。", exitCode: -1 };
    }
    if (busy && busy !== slot) {
      return { ok: false, cli: slot.cli as CliAgentResult["cli"], cwd: slot.cwd, output: `❌ ${busy.cwd} 的终端还在处理上一轮输入，等它结束再打`, exitCode: -1 };
    }
    if (slot.phase === "busy" || slot.phase === "starting") {
      return { ok: false, cli: slot.cli as CliAgentResult["cli"], cwd: slot.cwd, output: "❌ 正在往这个终端里输入，等这一轮结束再打", exitCode: -1 };
    }
    if (req.raw) return this.typeInto(slot, data, req);
    return this.submitLine(slot, data, req);
  }

  /** 按键。和用户在黑底上打字同一条路，不占派工的锁，下一键不用等上一键结束。 */
  async tap(botId: string, data: string, cwd?: string): Promise<CliAgentResult> {
    const slot = this.slotOf(botId, cwd);
    if (!slot?.session?.alive || slot.phase === "exited" || !data) {
      return { ok: false, cli: (slot?.cli ?? "shell") as CliAgentResult["cli"], cwd: slot?.cwd ?? "", output: "看着的这个目录还没有开着的终端。先用 term.open 打开。", exitCode: -1 };
    }
    slot.session.write(data);
    slot.lastActiveAt = this.opts.now?.() ?? Date.now();
    if (slot.phase === "idle") this.armIdle(slot);
    const wait = this.opts.tapMs ?? Math.min(this.opts.quietMs ?? 350, 500);
    if (wait > 0) await sleep(wait);
    return {
      ok: true,
      cli: slot.cli as CliAgentResult["cli"],
      cwd: slot.cwd,
      output: this.screenBlock(slot, "按键已经打进这块终端。下面是你眼前的屏幕，下一步按你看见的来。"),
      exitCode: 0,
      keptAlive: !!slot.session?.alive,
    };
  }

  stop(botId: string, reason = "已结束", cwd?: string): void {
    const s = cwd ? this.slots.get(slotKey(botId, canonCodingCwd(cwd))) : this.slotOf(botId);
    if (!s) return;
    this.stopSlot(s, reason);
  }

  stopAll(): void {
    for (const [, t] of this.pendingEmit) clearTimeout(t);
    this.pendingEmit.clear();
    for (const s of [...this.slots.values()]) this.stopSlot(s, "应用退出", true);
    this.slots.clear();
    this.current.clear();
  }

  async dispatch(botId: string, req: CliAgentRequest): Promise<CliAgentResult> {
    const cwd = canonCodingCwd(req.cwd);
    const busy = this.busySlot(botId);
    if (busy && busy.cwd !== cwd) {
      return {
        ok: false,
        cli: req.cli,
        cwd,
        output: `❌ ${busy.cwd} 的终端还在处理上一轮输入，等它结束再派别的工程`,
        exitCode: -1,
      };
    }
    if (busy && (busy.phase === "busy" || busy.phase === "starting")) {
      return {
        ok: false,
        cli: req.cli,
        cwd,
        output: "❌ 这个目录的终端正在处理上一轮输入，等它结束再打",
        exitCode: -1,
      };
    }
    const key = slotKey(botId, cwd);
    const cur = this.slots.get(key);
    // shell → agent，或换另一家 CLI：同槽停掉再起
    if (cur?.session?.alive && (cur.program.kind === "shell" || cur.cli !== req.cli)) {
      this.stopSlot(cur, cur.program.kind === "shell" ? "这一步要开 Coding CLI" : "这个目录换了 CLI");
    } else if (cur && (cur.phase === "exited" || !cur.session?.alive)) this.slots.delete(key);
    const live = this.slots.get(key);
    if (live?.session?.alive && live.phase === "idle" && live.program.kind === "agent" && live.cli === req.cli) {
      this.current.set(botId, cwd);
      const result = await this.submitLine(live, req.task, req);
      return { ...result, reused: true };
    }
    const opened = await this.openProgram(botId, { kind: "agent", cli: req.cli, cwd, task: req.task, spawnImpl: req.spawnImpl, signal: req.signal });
    if (!opened.ok || opened.cancelled) return opened;
    const slot = this.slots.get(key);
    if (!slot?.session?.alive) return opened;
    const first = req.promptText?.trim() ? req.promptText : req.task;
    const result = await this.submitLine(slot, first, req);
    return { ...result, reused: false };
  }

  /** 任务打成一行，回车单独送。规范不进输入框。 */
  private async submitLine(
    slot: Slot,
    raw: string,
    req: { timeoutMs?: number; signal?: AbortSignal; onProgress?: (tail: string) => void },
  ): Promise<CliAgentResult> {
    const text = taskLine(raw);
    if (!text) {
      // 避免 starting 僵尸：空任务也落到 idle/exited
      if (slot.phase === "starting" && slot.session?.alive) this.armIdle(slot);
      else if (slot.phase === "starting") this.markExited(slot, "没有要打进终端的任务");
      return { ok: false, cli: slot.cli as CliAgentResult["cli"], cwd: slot.cwd, output: "没有要打进终端的任务。", exitCode: -1 };
    }
    const typed = await this.typeInto(slot, text, req);
    if (typed.cancelled || !slot.session?.alive) return typed;
    await this.tap(slot.botId, "\r", slot.cwd);
    this.refreshScreen(slot);
    const pose = terminalPosture(slot.screen);
    const note = pose === "composing"
      ? "字已经打进输入框，回车也按了，屏幕上看字还在框里。进程开着。不要说终端不在线。再按一次 enter，或让用户点「送出」。"
      : "任务已按一行送出，进程开着。看下面的屏幕决定下一步。不要说终端不在线，也不要重新打开。";
    return {
      ...typed,
      output: this.screenBlock(slot, note),
      keptAlive: !!slot.session?.alive && !typed.timedOut,
    };
  }

  private async openAgentSlot(
    botId: string,
    cwd: string,
    preferCli?: string,
    spawnImpl?: CliAgentRequest["spawnImpl"],
  ): Promise<CliAgentResult> {
    const cli = spawnImpl ? (preferCli || "claude") : await pickCodingAgent(preferCli);
    if (!cli) {
      return { ok: false, cli: (preferCli || "claude") as CliAgentResult["cli"], cwd, output: "❌ 没有就绪的编码 CLI。到设置 → 模型刷新探测。", exitCode: -1 };
    }
    return this.openProgram(botId, { kind: "agent", cli: cli as CliAgentRequest["cli"], cwd, spawnImpl });
  }

  private async openProgram(botId: string, req: {
    kind: "shell" | "agent";
    cli?: string;
    cwd: string;
    task?: string;
    spawnImpl?: CliAgentRequest["spawnImpl"];
    signal?: AbortSignal;
  }): Promise<CliAgentResult> {
    const cwd = canonCodingCwd(req.cwd);
    const program: TermProgram = req.kind === "shell" ? { kind: "shell" } : { kind: "agent", cli: req.cli || "claude" };
    const label = programLabel(program);
    let bin: string;
    if (program.kind === "shell") {
      bin = resolveShellBin();
    } else {
      const agent = agentBin(program.cli);
      if (!agent) {
        return { ok: false, cli: program.cli as CliAgentResult["cli"], cwd, output: `❌ 没有 ${program.cli} 可执行文件`, exitCode: -1 };
      }
      if (!req.spawnImpl) {
        const items = await probeCodingAgents();
        const cap = items.find((x) => x.id === program.cli);
        if (!cap?.ready) {
          return {
            ok: false,
            cli: program.cli as CliAgentResult["cli"],
            cwd,
            output: `❌ ${program.cli} 未就绪（未安装、未登录或不支持派工，bin: ${agent}）。到设置 → 模型刷新探测，或省略 cli 让系统自动选已就绪项。`,
            exitCode: -1,
          };
        }
      }
      bin = agent;
    }
    this.reap(botId, cwd);
    const now = this.opts.now?.() ?? Date.now();
    const session = new TermSession();
    const slot: Slot = {
      botId,
      cli: label,
      program,
      cwd,
      phase: "starting",
      resident: true,
      startedAt: now,
      lastActiveAt: now,
      task: req.task,
      screen: "",
      screenTail: "",
      session,
    };
    const key = slotKey(botId, cwd);
    session.onOutput = (text) => this.onSessionOutput(slot, session, text);
    session.onExit = (reason) => this.onSessionExit(slot, session, reason);
    this.slots.set(key, slot);
    this.current.set(botId, cwd);
    try {
      if (!req.spawnImpl) {
        const py = resolvePython3();
        if (!py) {
          this.stopSlot(slot, "没有 python3");
          return {
            ok: false,
            cli: label as CliAgentResult["cli"],
            cwd,
            output: "❌ 本机没有 python3，终端桥接起不来。请安装 Python 3（macOS 可用 xcode-select / brew install python）。",
            exitCode: -1,
          };
        }
        const bridge = this.bridgeFile();
        session.start({ bin, cwd, bridge, python: py });
      } else {
        session.start({
          bin,
          cwd,
          bridge: "",
          spawnFn: req.spawnImpl as unknown as SpawnLike | undefined,
        });
      }
    } catch (e) {
      this.stopSlot(slot, "启动失败", true);
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, cli: label as CliAgentResult["cli"], cwd, output: `❌ 终端启动失败：${msg}`, exitCode: -1 };
    }
    slot.pid = session.pid;
    this.armStartWatch(slot);
    this.emit(slot, true);
    const settle = this.opts.settleMs ?? 350;
    if (settle > 0) await sleep(settle, req.signal);
    if (req.signal?.aborted) {
      if (session.alive) this.armIdle(slot);
      return { ok: true, cli: label as CliAgentResult["cli"], cwd, output: this.screenBlock(slot, "已停止等待，终端还开着"), exitCode: 0, cancelled: true, keptAlive: session.alive };
    }
    // 桥接异步失败时 settle 后可能已经 exited
    if (!session.alive || slot.phase === "exited") {
      const reason = slot.exitReason || "终端没有留下来";
      return { ok: false, cli: label as CliAgentResult["cli"], cwd, output: `❌ ${reason}`, exitCode: -1, keptAlive: false };
    }
    return { ok: true, cli: label as CliAgentResult["cli"], cwd, output: "", exitCode: 0, keptAlive: true };
  }

  private async typeInto(slot: Slot, data: string, req: { timeoutMs?: number; signal?: AbortSignal; onProgress?: (tail: string) => void }): Promise<CliAgentResult> {
    const session = slot.session;
    if (!session?.alive) {
      return { ok: false, cli: slot.cli as CliAgentResult["cli"], cwd: slot.cwd, output: "终端已经不在了", exitCode: -1 };
    }
    this.clearStartWatch(slot);
    slot.phase = "busy";
    slot.task = data.replace(/\s+/g, " ").trim().slice(0, 80);
    slot.lastActiveAt = this.opts.now?.() ?? Date.now();
    if (slot.timer) clearTimeout(slot.timer);
    this.emit(slot, true);
    const quietMs = this.opts.quietMs ?? 1600;
    const timeoutMs = Math.min(Math.max(req.timeoutMs ?? 20 * 60_000, 60_000), 60 * 60_000);
    const started = Date.now();
    let last = started;
    const mark = () => { last = Date.now(); };
    const prev = session.onOutput;
    slot.onProgress = req.onProgress;
    session.onOutput = (text) => {
      mark();
      prev?.(text);
    };
    session.write(data);
    let cancelled = false;
    let timedOut = false;
    while (Date.now() - started < timeoutMs) {
      if (req.signal?.aborted) {
        cancelled = true;
        break;
      }
      if (!session.alive) break;
      if (Date.now() - last >= quietMs && Date.now() - started >= Math.min(quietMs, 400)) break;
      await sleep(40, req.signal);
    }
    session.onOutput = prev;
    slot.onProgress = undefined;
    if (Date.now() - started >= timeoutMs) timedOut = !cancelled && session.alive;
    slot.lastActiveAt = this.opts.now?.() ?? Date.now();
    const keptAlive = session.alive;
    if (keptAlive) this.armIdle(slot);
    else this.markExited(slot, "进程已退出");
    const note = cancelled
      ? "已停止等待，终端还开着。屏幕如下。"
      : timedOut
        ? "还在跑，先把当前屏幕给你。要用 cli.term 再看或继续输入。"
        : "下面是此刻的屏幕，和界面上是同一块。终端还开着；它若还在跑，用 cli.term 再看。";
    return {
      ok: !timedOut || keptAlive,
      cli: slot.cli as CliAgentResult["cli"],
      cwd: slot.cwd,
      output: this.screenBlock(slot, note),
      exitCode: keptAlive ? 0 : 1,
      cancelled,
      timedOut,
      keptAlive,
    };
  }

  private onSessionOutput(slot: Slot, session: TermSession, text: string): void {
    if (this.slots.get(slotKey(slot.botId, slot.cwd)) !== slot || slot.session !== session) return;
    const seq = session.note(text);
    this.bytesListener?.({ botId: slot.botId, cwd: slot.cwd, data: text, seq });
    session.screen.write(text, () => {
      if (slot.session !== session) return;
      this.refreshScreen(slot);
      slot.lastActiveAt = this.opts.now?.() ?? Date.now();
      slot.onProgress?.(slot.screenTail);
      if (slot.phase === "idle") this.armIdle(slot);
      this.emit(slot, false);
    });
  }

  private onSessionExit(slot: Slot, session: TermSession, reason: string): void {
    if (this.slots.get(slotKey(slot.botId, slot.cwd)) !== slot || slot.phase === "exited") return;
    if (slot.session && slot.session !== session) return;
    // busy：typeInto 还在等，只记原因，由 typeInto 收尾 markExited
    if (slot.phase === "busy") {
      slot.exitReason = reason;
      this.refreshScreen(slot);
      this.emit(slot, false);
      return;
    }
    // starting/idle：进程没了就正式 exited，避免僵尸「打开中」空面板
    this.markExited(slot, reason || "进程已退出");
    this.emit(slot, true);
  }

  private refreshScreen(slot: Slot): void {
    const text = slot.session?.screen.text() ?? slot.screen;
    slot.screen = text;
    slot.screenTail = slot.session?.screen.tail() ?? text.slice(-700);
  }

  private screenBlock(slot: Slot, note: string): string {
    this.refreshScreen(slot);
    const alive = slot.phase !== "exited" && !!slot.session?.alive;
    const pose = alive ? postureSentence(terminalPosture(slot.screen)) : "";
    const body = slot.screen.trim() || "（屏幕还是空的）";
    return `【终端屏幕 · ${slot.cli} · ${slot.cwd}】\n${note}${pose ? `\n${pose}` : ""}\n${body}`;
  }

  private armIdle(slot: Slot): void {
    this.clearStartWatch(slot);
    slot.phase = "idle";
    if (!slot.exitReason || slot.session?.alive) slot.exitReason = undefined;
    if (slot.timer) clearTimeout(slot.timer);
    const ms = this.opts.idleMs ?? PRESENCE_IDLE_MS;
    slot.timer = setTimeout(() => this.stopSlot(slot, "空闲太久，终端已关掉"), ms);
    slot.timer.unref?.();
    this.emit(slot, false);
  }

  private armStartWatch(slot: Slot): void {
    this.clearStartWatch(slot);
    const ms = this.opts.startingTimeoutMs ?? STARTING_TIMEOUT_MS;
    if (ms <= 0) return;
    slot.startWatch = setTimeout(() => {
      if (slot.phase !== "starting") return;
      this.stopSlot(slot, "打开超时，终端没起来");
    }, ms);
    slot.startWatch.unref?.();
  }

  private clearStartWatch(slot: Slot): void {
    if (slot.startWatch) clearTimeout(slot.startWatch);
    slot.startWatch = undefined;
  }

  private markExited(slot: Slot, reason: string): void {
    this.clearStartWatch(slot);
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = undefined;
    slot.session = undefined;
    slot.phase = "exited";
    slot.exitReason = reason;
  }

  private emit(slot: Slot, immediate: boolean): void {
    if (!this.listener) return;
    const key = slotKey(slot.botId, slot.cwd);
    const fire = () => {
      this.pendingEmit.delete(key);
      const cur = this.slots.get(key);
      if (cur) this.listener?.(this.decorate(cur));
    };
    if (immediate) {
      const prev = this.pendingEmit.get(key);
      if (prev) clearTimeout(prev);
      fire();
      return;
    }
    if (this.pendingEmit.has(key)) return;
    const t = setTimeout(fire, 80);
    t.unref?.();
    this.pendingEmit.set(key, t);
  }

  private stopSlot(slot: Slot, reason: string, force = false): void {
    this.clearStartWatch(slot);
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = undefined;
    slot.phase = "exited";
    slot.exitReason = reason;
    slot.lastActiveAt = this.opts.now?.() ?? Date.now();
    const session = slot.session;
    slot.session = undefined;
    session?.stop(force);
    this.refreshScreen(slot);
    const wasCurrent = this.current.get(slot.botId) === slot.cwd;
    if (wasCurrent) {
      const next = this.slotsFor(slot.botId)
        .filter((s) => s.cwd !== slot.cwd && s.phase !== "exited" && s.session?.alive)
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
      if (next) this.current.set(slot.botId, next.cwd);
    }
    this.emit(slot, true);
    if (!wasCurrent) return;
    const now = this.current.get(slot.botId);
    const live = now && now !== slot.cwd ? this.slots.get(slotKey(slot.botId, now)) : undefined;
    if (live) this.emit(live, true);
  }

  private reap(botId: string, keep: string): void {
    const idle = this.slotsFor(botId).filter((s) => s.session?.alive && s.phase === "idle" && s.cwd !== keep);
    idle.sort((a, b) => {
      const looking = this.current.get(botId);
      const ar = a.cwd === looking ? 1 : 0;
      const br = b.cwd === looking ? 1 : 0;
      if (ar !== br) return ar - br;
      return a.lastActiveAt - b.lastActiveAt;
    });
    while (this.slotsFor(botId).filter((s) => s.session?.alive).length >= MAX_LIVE_TERMINALS) {
      const victim = idle.shift();
      if (!victim) break;
      this.stopSlot(victim, "同时开着的工程太多，先关掉最久没用的");
    }
  }

  private busySlot(botId: string): Slot | undefined {
    return this.slotsFor(botId).find((s) => s.phase === "busy" || s.phase === "starting");
  }

  private slotOf(botId: string, cwd?: string): Slot | undefined {
    const c = cwd ? canonCodingCwd(cwd) : this.current.get(botId);
    if (!c) return undefined;
    return this.slots.get(slotKey(botId, c));
  }

  private slotsFor(botId: string): Slot[] {
    return [...this.slots.values()].filter((s) => s.botId === botId);
  }

  private decorate(s: Slot): CodingPresenceView {
    const others = this.slotsFor(s.botId)
      .filter((o) => o.cwd !== s.cwd && o.phase !== "exited" && o.session?.alive)
      .map((o) => ({
        cwd: o.cwd,
        cli: o.cli,
        program: o.program,
        phase: o.phase,
        posture: o.phase === "exited" ? undefined : terminalPosture(o.screen),
      }));
    return { ...publicView(s), others };
  }

  private bridgeFile(): string {
    const src = this.opts.bridgePath;
    if (!src) throw new Error("缺少终端桥接脚本（bridgePath）");
    if (!existsSync(src)) throw new Error(`终端桥接脚本不存在：${src}`);
    const dir = this.opts.home || tmpdir();
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, "pty-bridge.py");
    copyFileSync(src, dest);
    return dest;
  }
}

function publicView(s: Slot): CodingPresenceView {
  return {
    botId: s.botId,
    cli: s.cli,
    program: s.program,
    cwd: s.cwd,
    phase: s.phase,
    resident: true,
    pid: s.pid,
    startedAt: s.startedAt,
    lastActiveAt: s.lastActiveAt,
    task: s.task,
    exitReason: s.exitReason,
    screen: s.screen,
    screenTail: s.screenTail,
    posture: s.phase === "exited" ? undefined : terminalPosture(s.screen),
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
