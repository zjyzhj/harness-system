/**
 * G10：把写工程外包给本机 Coding CLI（Agent 模式）。
 * 与 adapters/cli.ts 的「聊天 ask」分离——本模块只服务工具 cli.agent。
 * 可用后端见 coding-agents 注册表（探测驱动，不手写死名单）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { strippedCliEnv } from "./adapters/cli";
import {
  agentBin,
  buildCodingAgentArgs,
  getCodingAgent,
  parseCodingAgentId,
  pickCodingAgent,
  probeCodingAgents,
  type AgentArgOpts,
  type CodingAgentId,
} from "./coding-agents";
import { parseAgentOutput } from "./coding-thread";

/** @deprecated 使用 CodingAgentId；保留别名以兼容旧测例 */
export type CliName = CodingAgentId;
export type { CodingAgentId };

export interface CliAgentRequest {
  task: string;
  cwd: string;
  cli: CodingAgentId;
  /** 派工 bot 名，写入给 CLI 的提示 */
  botName?: string;
  /** 可选短约束（记忆规则摘录等），限长由调用方裁 */
  constraints?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 运行中进度（stdout/stderr 尾部摘要） */
  onProgress?: (tail: string) => void;
  /** 续我们记下的 CLI 会话。失败且提供了 fallbackPrompt 时只新开一次 */
  resumeId?: string;
  /** Claude 新开时指定的 UUID */
  createSessionId?: string;
  /** 续会话失败时改用的提示（含工作线） */
  fallbackPrompt?: string;
  /** 已拼好的提示。不传则按 resumeId 现拼 */
  promptText?: string;
  /** 测试可注入 */
  spawnImpl?: typeof spawn;
  home?: string;
  harnessHome?: string;
}

export interface CliAgentResult {
  ok: boolean;
  cli: CodingAgentId;
  cwd: string;
  output: string;
  exitCode: number;
  cancelled?: boolean;
  timedOut?: boolean;
  /** 解析到的或我们指定的 CLI 会话号 */
  sessionId?: string;
  /** 这次是续会话失败后新开的 */
  resumedThenFresh?: boolean;
  /** 退出码非 0 且输出像是会话不存在 */
  resumeMissing?: boolean;
}

export class CliAgentPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliAgentPathError";
  }
}

/** 解析并校验工程根：拒绝 /、家目录本身、Harness 数据目录 */
export function resolveAgentCwd(raw: string, opts?: { home?: string; harnessHome?: string }): string {
  const home = opts?.home ?? homedir();
  const text = raw.trim();
  if (!text) throw new CliAgentPathError("需要工程目录 cwd（或先 env.set PROJECT_ROOT）");
  if (!isAbsolute(text)) throw new CliAgentPathError("工程目录必须是绝对路径，不要用相对路径");
  const abs = resolve(text);
  if (!existsSync(abs)) throw new CliAgentPathError(`目录不存在：${abs}`);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw new CliAgentPathError(`无法解析路径：${abs}`);
  }
  if (!statSync(real).isDirectory()) throw new CliAgentPathError(`不是目录：${real}`);
  const homeReal = safeReal(home);
  if (real === "/" || real === homeReal) {
    throw new CliAgentPathError("不能对系统根目录或用户家目录整棵树派工，请指定具体工程目录");
  }
  const harness = opts?.harnessHome?.trim();
  if (harness) {
    const h = safeReal(harness);
    if (h && (real === h || real.startsWith(h + sep))) {
      throw new CliAgentPathError("不能对 Harness 数据目录派工（含密钥与配置）");
    }
  }
  return real;
}

function safeReal(p: string): string {
  try {
    return existsSync(p) ? realpathSync(p) : resolve(p);
  } catch {
    return resolve(p);
  }
}

export function buildAgentPrompt(req: Pick<CliAgentRequest, "task" | "cwd" | "botName" | "constraints"> & { brief?: string; resume?: boolean }): string {
  const task = req.task.trim();
  if (req.resume) {
    const parts = [`【任务】${task}`];
    if (req.constraints?.trim()) parts.push(`【约束】${req.constraints.trim().slice(0, 800)}`);
    parts.push("【交付】沿用本会话已有上下文，只完成这次任务。用简洁中文说明改了哪些文件、怎么验证。");
    return parts.join("\n");
  }
  const who = req.botName?.trim() || "Harness bot";
  const parts = [
    `【角色】你是用户本机工程上的 coding agent，由 Harness bot「${who}」派来完成任务。`,
    `【工程】工作目录（cwd）= ${req.cwd}`,
  ];
  if (req.brief?.trim()) parts.push(`【进行中】\n${req.brief.trim().slice(0, 4096)}`);
  parts.push(`【任务】${task}`);
  if (req.constraints?.trim()) parts.push(`【约束】${req.constraints.trim().slice(0, 2000)}`);
  parts.push("【交付】改完后用简洁中文说明改了哪些文件、怎么验证；不要索要 Harness 内部工具或向用户要 API Key。");
  return parts.join("\n");
}

/** Agent 模式参数（注册表驱动） */
export function agentCliArgs(cli: CodingAgentId, prompt: string, cwd: string, opts?: AgentArgOpts): string[] {
  return buildCodingAgentArgs(cli, prompt, cwd, opts);
}

export async function pickInstalledCli(preferred?: CodingAgentId | null): Promise<CodingAgentId | null> {
  return pickCodingAgent(preferred);
}

const busyBots = new Set<string>();

export function isCliAgentBusy(botId: string): boolean {
  return busyBots.has(botId);
}

export async function runCliAgent(botId: string, req: CliAgentRequest): Promise<CliAgentResult> {
  if (busyBots.has(botId)) {
    return {
      ok: false,
      cli: req.cli,
      cwd: req.cwd,
      output: "❌ 该 bot 已有一个 cli.agent 在跑，等它结束再派（每 bot 同时只跑 1 个）",
      exitCode: -1,
    };
  }
  const cwd = resolveAgentCwd(req.cwd, { home: req.home, harnessHome: req.harnessHome });
  const bin = agentBin(req.cli);
  if (!bin || !getCodingAgent(req.cli)?.agent) {
    return {
      ok: false,
      cli: req.cli,
      cwd,
      output: `❌ 未知或不支持派工的 Coding Agent：${req.cli}。以设置 → 模型里的实时探测为准。`,
      exitCode: -1,
    };
  }
  // 测试注入 spawnImpl 时跳过本机探测
  if (!req.spawnImpl) {
    const items = await probeCodingAgents();
    const cap = items.find((x) => x.id === req.cli);
    if (!cap?.ready) {
      return {
        ok: false,
        cli: req.cli,
        cwd,
        output: `❌ ${req.cli} 未就绪（未安装、未登录或不支持派工，bin: ${bin}）。到设置 → 模型刷新探测，或省略 cli 让系统自动选已就绪项。`,
        exitCode: -1,
      };
    }
  }
  const prompt = req.promptText ?? buildAgentPrompt({ ...req, cwd, resume: !!req.resumeId });
  const timeoutMs = Math.min(Math.max(req.timeoutMs ?? 20 * 60_000, 60_000), 60 * 60_000);
  const spawnFn = req.spawnImpl ?? spawn;
  const useProcessGroup = !req.spawnImpl;

  busyBots.add(botId);
  try {
    const first = await spawnAgent({
      cli: req.cli,
      bin,
      cwd,
      args: agentCliArgs(req.cli, prompt, cwd, { resumeId: req.resumeId, createSessionId: req.createSessionId }),
      timeoutMs,
      signal: req.signal,
      spawnFn,
      onProgress: req.onProgress,
      useProcessGroup,
      resumeId: req.resumeId,
      createSessionId: req.createSessionId,
    });
    if (first.resumeMissing && req.resumeId && req.fallbackPrompt && !req.signal?.aborted) {
      const freshId = req.cli === "claude" ? randomUUID() : undefined;
      const second = await spawnAgent({
        cli: req.cli,
        bin,
        cwd,
        args: agentCliArgs(req.cli, req.fallbackPrompt, cwd, { createSessionId: freshId }),
        timeoutMs,
        signal: req.signal,
        spawnFn,
        onProgress: req.onProgress,
        useProcessGroup,
        createSessionId: freshId,
      });
      return { ...second, resumedThenFresh: true, output: `（上次 CLI 会话续不上，已新开并带上工作线）\n${second.output}` };
    }
    return first;
  } finally {
    busyBots.delete(botId);
  }
}

/** 测试用：清 busy 锁 */
export function resetCliAgentBusyForTests() {
  busyBots.clear();
}

function spawnAgent(opts: {
  cli: CodingAgentId;
  bin: string;
  cwd: string;
  args: string[];
  timeoutMs: number;
  signal?: AbortSignal;
  spawnFn: typeof spawn;
  onProgress?: (tail: string) => void;
  useProcessGroup?: boolean;
  resumeId?: string;
  createSessionId?: string;
}): Promise<CliAgentResult> {
  const { cli, bin, cwd, args, timeoutMs, signal, spawnFn, onProgress, useProcessGroup, resumeId, createSessionId } = opts;
  return new Promise((resolvePromise) => {
    let proc: ChildProcess;
    try {
      const env = strippedCliEnv();
      proc = spawnFn(bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env,
        cwd,
        // 独立进程组：停止/超时时整组杀掉（含 CLI 拉起的子 agent）
        detached: !!useProcessGroup,
      });
    } catch (e) {
      resolvePromise({
        ok: false,
        cli,
        cwd,
        output: `❌ 启动 ${cli} 失败：${e instanceof Error ? e.message : String(e)}`,
        exitCode: -1,
      });
      return;
    }

    let out = "";
    let err = "";
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let lastProgressAt = 0;

    const pushProgress = () => {
      if (!onProgress) return;
      const now = Date.now();
      if (now - lastProgressAt < 1200) return;
      lastProgressAt = now;
      const tail = (out.trim() || err.trim()).slice(-400);
      if (tail) onProgress(tail);
    };

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const raw = (out.trim() || err.trim()).slice(-12_000);
      const parsed = parseAgentOutput(raw, exitCode);
      const sessionId = parsed.sessionId || (!resumeId ? createSessionId : resumeId);
      const body = (parsed.text || raw).slice(-12_000);
      const ok = exitCode === 0 && !timedOut && !cancelled;
      let output = body || (cancelled ? "（已取消）" : timedOut ? "（超时，无输出）" : `（无输出，退出码 ${exitCode}）`);
      if (cancelled) output = `⏹ 已停止 ${cli} 派工。\n${output}`;
      else if (timedOut) output = `⏱ ${cli} 派工超时（${Math.round(timeoutMs / 60000)} 分钟）。\n${output}`;
      else if (!ok) output = `❌ ${cli} 退出码 ${exitCode}\n${output}`;
      else output = `✅ ${cli} 已在 ${cwd} 完成派工。\n${output}`;
      resolvePromise({ ok, cli, cwd, output, exitCode, cancelled, timedOut, sessionId, resumeMissing: parsed.resumeMissing });
    };

    const onAbort = () => {
      cancelled = true;
      killAgentTree(proc, !!useProcessGroup);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      finish(-1);
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killAgentTree(proc, !!useProcessGroup);
    }, timeoutMs);

    proc.stdout?.on("data", (d) => {
      out += d.toString();
      if (out.length > 400_000) out = out.slice(-200_000);
      pushProgress();
    });
    proc.stderr?.on("data", (d) => {
      err += d.toString();
      if (err.length > 200_000) err = err.slice(-100_000);
      pushProgress();
    });
    proc.on("error", (e) => {
      err += e.message;
      finish(-1);
    });
    proc.on("close", (code) => finish(code ?? -1));
  });
}

/** 与 bash.run 对齐：优先杀进程组，再回落单进程 */
function killAgentTree(proc: ChildProcess, processGroup: boolean) {
  const pid = proc.pid;
  if (processGroup && pid) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }, 1500);
    return;
  }
  try {
    proc.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      if (!proc.killed) proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }, 1500);
}

/** 解析 cwd：显式 → PROJECT_ROOT 环境可见值 → bot 绑定 */
export function resolveCwdInput(args: Record<string, unknown>, fallbacks: { projectRoot?: string; agentCwd?: string }): string {
  const fromArgs = typeof args.cwd === "string" ? args.cwd.trim() : "";
  if (fromArgs) return fromArgs;
  if (fallbacks.projectRoot?.trim()) return fallbacks.projectRoot.trim();
  if (fallbacks.agentCwd?.trim()) return fallbacks.agentCwd.trim();
  return "";
}

export function parseCliName(raw: unknown): CodingAgentId | undefined {
  return parseCodingAgentId(raw);
}
