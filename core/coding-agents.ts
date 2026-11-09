/**
 * 本机 Coding Agent 注册表 + 实时探测。
 * 派工（cli.agent）与设置页共用：以探测结果为准，不手写「能调哪些」。
 * 加新后端 = 往 BUILTIN / registerCodingAgent 加一条（bin + agent 参数）。
 */
import { detectCli, type CliCapability, type CliName } from "./adapters/cli";
import { CLI_BINS, builtinCliBin } from "./cli-bins";

export type CodingAgentId = string;

export interface AgentArgOpts {
  /** 续我们记下的会话；不传则新开 */
  resumeId?: string;
  /** Claude 新开会话时指定 UUID，便于下次 --resume */
  createSessionId?: string;
}

export interface CodingAgentBackend {
  id: CodingAgentId;
  bin: string;
  label: string;
  chat: boolean;
  agent: boolean;
  buildAgentArgs?: (prompt: string, cwd: string, opts?: AgentArgOpts) => string[];
  order?: number;
}

export interface CodingAgentStatus {
  id: CodingAgentId;
  bin: string;
  label: string;
  /** PATH 上能跑 --version */
  installed: boolean;
  version?: string;
  account?: string;
  /** 可用于聊天 CLI Provider */
  chat: boolean;
  /** 注册表声明支持派工 */
  agent: boolean;
  /**
   * 适合真正派工：已安装、支持 agent、且未测出明确未登录。
   * （未探测到账号 ≠ 未登录；仅「未登录」等明确信号会把 ready 打 false）
   */
  ready: boolean;
}

const BUILTIN: CodingAgentBackend[] = [
  {
    id: "cursor",
    bin: CLI_BINS.cursor,
    label: "Cursor Agent",
    chat: true,
    agent: true,
    order: 10,
    buildAgentArgs: (prompt, cwd, opts) => [
      "-p",
      "--output-format",
      "json",
      "--trust",
      "--force",
      "--sandbox",
      "disabled",
      "--workspace",
      cwd,
      ...(opts?.resumeId ? ["--resume", opts.resumeId] : []),
      prompt,
    ],
  },
  {
    id: "claude",
    bin: CLI_BINS.claude,
    label: "Claude Code",
    chat: true,
    agent: true,
    order: 20,
    // 工程根靠 spawn cwd。--dangerously-skip-permissions 只跳过授权卡，不关 Bash 沙箱；
    // 必须再关 sandbox，否则碰 $HOME / 起面板仍会「沙箱里跑不通」再绕回 Harness。
    buildAgentArgs: (prompt, _cwd, opts) => [
      "-p",
      "--output-format",
      "text",
      "--dangerously-skip-permissions",
      "--settings",
      JSON.stringify({ sandbox: { enabled: false, allowUnsandboxedCommands: true } }),
      ...(opts?.resumeId ? ["--resume", opts.resumeId] : opts?.createSessionId ? ["--session-id", opts.createSessionId] : []),
      prompt,
    ],
  },
  {
    id: "codex",
    bin: CLI_BINS.codex,
    label: "Codex CLI",
    chat: true,
    agent: true,
    order: 30,
    buildAgentArgs: (prompt, cwd, opts) =>
      opts?.resumeId
        ? ["exec", "resume", opts.resumeId, "--skip-git-repo-check", "--json", prompt]
        : ["exec", "--skip-git-repo-check", "-s", "workspace-write", "-C", cwd, "--json", prompt],
  },
];

const extras: CodingAgentBackend[] = [];

export function registerCodingAgent(backend: CodingAgentBackend) {
  const i = extras.findIndex((x) => x.id === backend.id);
  if (i >= 0) extras[i] = backend;
  else extras.push(backend);
  cache = null;
}

export function resetCodingAgentExtrasForTests() {
  extras.length = 0;
  cache = null;
}

export function listCodingAgentBackends(): CodingAgentBackend[] {
  const map = new Map<string, CodingAgentBackend>();
  for (const b of [...BUILTIN, ...extras]) map.set(b.id, b);
  return [...map.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

export function getCodingAgent(id: string): CodingAgentBackend | undefined {
  return listCodingAgentBackends().find((b) => b.id === id);
}

export function agentBin(id: string): string | undefined {
  return getCodingAgent(id)?.bin ?? builtinCliBin(id);
}

export function buildCodingAgentArgs(id: string, prompt: string, cwd: string, opts?: AgentArgOpts): string[] {
  const b = getCodingAgent(id);
  if (!b?.buildAgentArgs) throw new Error(`Coding Agent「${id}」未配置派工参数`);
  return b.buildAgentArgs(prompt, cwd, opts);
}

let cache: { at: number; items: CodingAgentStatus[] } | null = null;
const TTL_MS = 45_000;

function isReady(cap: CliCapability, agentCapable: boolean): boolean {
  if (!cap.installed || !agentCapable) return false;
  if (cap.account && /未登录|not logged in/i.test(cap.account)) return false;
  return true;
}

let probeInFlight: Promise<CodingAgentStatus[]> | null = null;

export async function probeCodingAgents(opts?: { force?: boolean }): Promise<CodingAgentStatus[]> {
  if (!opts?.force && cache && Date.now() - cache.at < TTL_MS) return cache.items;
  // TTL 过期但还有旧结果：先返回旧的，后台刷新（详情栏别被 CLI 探测卡住）
  if (!opts?.force && cache?.items?.length) {
    if (!probeInFlight) {
      probeInFlight = refreshCodingAgentsProbe()
        .catch(() => cache!.items)
        .finally(() => {
          probeInFlight = null;
        });
    }
    return cache.items;
  }
  if (probeInFlight && !opts?.force) return probeInFlight;
  probeInFlight = refreshCodingAgentsProbe().finally(() => {
    probeInFlight = null;
  });
  return probeInFlight;
}

async function refreshCodingAgentsProbe(): Promise<CodingAgentStatus[]> {
  const items = await Promise.all(
    listCodingAgentBackends().map(async (b) => {
      const known = b.id === "cursor" || b.id === "claude" || b.id === "codex";
      const cap: CliCapability = known ? await detectCli(b.id as CliName) : await detectBinVersion(b.bin);
      const ready = isReady(cap, b.agent);
      return {
        id: b.id,
        bin: b.bin,
        label: b.label,
        installed: cap.installed,
        version: cap.version,
        account: cap.account,
        chat: b.chat && cap.installed,
        agent: b.agent,
        ready,
      } satisfies CodingAgentStatus;
    }),
  );
  cache = { at: Date.now(), items };
  return items;
}

async function detectBinVersion(bin: string): Promise<CliCapability> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    let out = "";
    const p = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    const t = setTimeout(() => {
      try {
        p.kill();
      } catch {
        /* */
      }
      resolve({ installed: false, chat: false });
    }, 3_500);
    p.stdout?.on("data", (d) => {
      out += String(d);
    });
    p.on("error", () => {
      clearTimeout(t);
      resolve({ installed: false, chat: false });
    });
    p.on("close", (code) => {
      clearTimeout(t);
      if (code === 0 && out.trim()) {
        resolve({ installed: true, version: out.trim().split("\n")[0], chat: true });
      } else resolve({ installed: false, chat: false });
    });
  });
}

export function codingAgentsSnapshot(): CodingAgentStatus[] {
  return cache?.items ?? [];
}

export function invalidateCodingAgentsCache() {
  cache = null;
}

/** 已 ready 可派工；偏好未 ready 则按注册表顺序回落 */
export async function pickCodingAgent(preferred?: string | null): Promise<CodingAgentId | null> {
  const items = await probeCodingAgents();
  const agents = items.filter((x) => x.ready);
  if (!agents.length) return null;
  if (preferred) {
    const hit = agents.find((x) => x.id === preferred);
    if (hit) return hit.id;
  }
  return agents[0]!.id;
}

export function parseCodingAgentId(raw: unknown): CodingAgentId | undefined {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return undefined;
  const ids = new Set(listCodingAgentBackends().map((b) => b.id));
  return ids.has(s) ? s : undefined;
}

export function formatCodingAgentsPromptLine(items?: CodingAgentStatus[]): string {
  const list = items ?? codingAgentsSnapshot();
  if (!list.length) {
    return "- 写代码派工：本机 Coding CLI 尚未探测；调用 cli.agent 时会现查已装项（不必手写名单）。";
  }
  const lines = list.map((x) => {
    if (!x.installed) return `  - ${x.id}（${x.bin}）：未安装`;
    const bits = [
      x.version ? `v${x.version.split(/\s+/)[0]}` : "已装",
      x.ready ? "可派工" : x.agent ? "已装但未就绪（未登录？）" : "仅聊天",
      x.account ?? "",
    ].filter(Boolean);
    return `  - ${x.id}（${x.bin}）：${bits.join(" · ")}`;
  });
  const ready = list.filter((x) => x.ready).map((x) => x.id);
  return [
    `- 写代码派工（cli.agent）：以下为本机实时探测，安装/卸载后刷新设置或下次派工会更新，不要背死名单。`,
    ...lines,
    ready.length
      ? `  可派工：${ready.join(" / ")}。参数 cli 可省略（按 bot 偏好→探测顺序）；未就绪的偏好会自动换。`
      : `  当前没有可派工的 Coding CLI，请先安装并登录其一。`,
  ].join("\n");
}

export function cliAgentToolDescription(items?: CodingAgentStatus[]): string {
  const list = items ?? codingAgentsSnapshot();
  const ready = list.filter((x) => x.ready).map((x) => x.id);
  const names = ready.length
    ? ready.join("|")
    : listCodingAgentBackends()
        .filter((b) => b.agent)
        .map((b) => b.id)
        .join("|");
  return `派本机 Coding CLI 改工程（上层动作）。终端底座是 shell：先用 term.open 也能开目录终端。cli.agent 会在该目录把终端切到 Coding CLI 并打进 task。一个目录一块终端，可同时留着几个；没写 cwd 用正在看的工程。屏幕和界面【终端】是同一块。参数: task, cwd?（或 PROJECT_ROOT / bot.agentCwd）, cli?（${names}；省略则自动选已就绪项）, timeoutMin?。该目录第一次要确认；点过「总是允许此目录」后，开终端、打字和派工都不再问，终端环境里可以用 $名字 读取普通配置和保险库密钥。用户拒绝后不要换 CLI 绕过。要再看/打字用 term.read|write|keys（或 cli.term）。`;
}
