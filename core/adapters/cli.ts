import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { contentText, type ChatMessage, type Provider } from "../types";
import { CLI_BINS, type BuiltinCliId } from "../cli-bins";

/** cursor-agent 工作目录：空沙箱，避免扫启动目录（harness 仓库）拖慢冷启动 */
function cliWorkspaceDir(): string {
  const dir = join(tmpdir(), "harness-cli-cwd");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export type CliName = BuiltinCliId;

const CLI_BIN: Record<CliName, string> = { ...CLI_BINS };

export interface CliCapability {
  installed: boolean;
  version?: string;
  chat: boolean;
  /** 当前 CLI 登录账号（cursor-agent status 等）；软件本身不存登录态 */
  account?: string;
}

export async function detectCli(name: CliName): Promise<CliCapability> {
  const v = await runQuiet(CLI_BIN[name], ["--version"]);
  if (v.code === 0 && v.stdout.trim()) {
    const account = await cliAccount(name);
    return { installed: true, version: v.stdout.trim().split("\n")[0], chat: true, account };
  }
  return { installed: false, chat: false };
}

/** cursor-agent login 写入的 CLI 身份；与 IDE 钥匙串里的 cursor-access-token 不是同一套 */
function readCursorCliAuthEmail(): string | undefined {
  try {
    const path = join(process.env.HOME ?? homedir(), ".cursor", "cli-config.json");
    const d = JSON.parse(readFileSync(path, "utf8")) as { authInfo?: { email?: string } | null };
    const email = d.authInfo?.email?.trim();
    return email || undefined;
  } catch {
    return undefined;
  }
}

/** 读本机 CLI 登录身份（每次现查；Electron 不缓存） */
async function cliAccount(name: CliName): Promise<string | undefined> {
  if (name !== "cursor") return undefined;
  const r = await runQuiet(CLI_BIN.cursor, ["status"], { timeoutMs: 10_000 });
  const text = `${r.stdout}\n${r.stderr}`.trim();
  if (/not logged in|未登录/i.test(text)) return "未登录";
  const m = text.match(/Logged in as\s+(\S+)/i) || text.match(/登录(?:为|成)\s*(\S+)/);
  const statusEmail = m?.[1]?.replace(/[。.]$/, "");
  const cliEmail = readCursorCliAuthEmail();
  if (cliEmail) return cliEmail;
  if (statusEmail) return `${statusEmail}（IDE 钥匙串，非 CLI login）`;
  return undefined;
}

/**
 * CLI 适配器：spawn 子进程调用。
 * 不同 CLI 参数差异封装在 cliArgs 中；失败抛出可读错误，由上层降级到 API。
 * 模型只取 provider.model：留空即沿用 CLI 本地配置（~/.codex/config.toml、claude/cursor 登录态等），
 * 不使用 bot.model，避免把 API 类模型名错误地塞给 CLI。
 */
export async function completeCli(
  p: Provider,
  user: string,
  system?: string,
  history?: ChatMessage[],
  onDelta?: (text: string) => void,
  signal?: AbortSignal,
  onThinking?: (text: string) => void,
): Promise<string> {
  const cli = p.cliName ?? "claude";
  const prompt = buildPrompt(cli, user, system, history);
  if (onDelta && cli !== "codex") return streamCli(cli, p, prompt, system, onDelta, signal, onThinking);
  const outDir = cli === "codex" ? mkdtempSync(join(tmpdir(), "harness-codex-")) : undefined;
  const outFile = outDir ? join(outDir, "last.txt") : undefined;
  try {
    const args = cliArgs(cli, prompt, system, p.model, outFile);
    const env = mergeCliEnv(cli, p);
    const r = await runQuiet(CLI_BIN[cli], args, { timeoutMs: 180_000, env });
    if (r.code !== 0) {
      throw new Error(formatCliError(cli, r.code, r.stderr.trim().slice(0, 300) || r.stdout.trim().slice(0, 300)));
    }
    const text = extractOutput(r.stdout, outFile);
    if (!text) throw new Error(`${cli} CLI 返回为空`);
    if (onDelta) onDelta(text);
    return text;
  } finally {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  }
}

/**
 * claude / cursor-agent 流式：stream-json 逐行解析文本增量。
 * claude 用轻量参数跳过 MCP、工具、斜杠命令与会话落盘，降低冷启动；思考强度压到 low。
 */
export function streamCliArgs(cli: "claude" | "cursor", prompt: string, system?: string, model?: string): string[] {
  if (cli === "cursor") {
    // 不用 --mode ask：Ask 人设会拒调 Harness 工具、让用户切不存在的 Agent 模式。
    // 隔离靠空沙箱 workspace + sandbox；改用户工程仍只经 Harness cli.agent / term.*。
    return [
      "-p", "--output-format", "stream-json", "--stream-partial-output",
      "--trust", "--sandbox", "enabled", "--workspace", cliWorkspaceDir(),
      ...(model ? ["--model", model] : []),
      prompt,
    ];
  }
  return [
    "-p", prompt,
    "--output-format", "stream-json", "--include-partial-messages", "--verbose",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--tools", "", "--disable-slash-commands", "--no-session-persistence",
    ...(system ? ["--system-prompt", system] : []),
    ...(model ? ["--model", model] : []),
  ];
}

/** 解析一行 stream-json，返回新增文本（cursor 最后会重发一次完整消息，需跳过）与最终结果 */
export function parseStreamLine(cli: "claude" | "cursor", line: string, acc: string): { delta?: string; result?: string; error?: string; thinking?: string } {
  let e: any;
  try { e = JSON.parse(line); } catch { return {}; }
  if (e.type === "result") {
    if (e.is_error) return { error: String(e.result || e.error || "CLI 返回错误") };
    return { result: typeof e.result === "string" ? e.result : undefined };
  }
  if (cli === "claude") {
    const d = e.type === "stream_event" ? e.event : null;
    if (d?.type === "content_block_delta" && d.delta?.type === "text_delta" && d.delta.text) return { delta: d.delta.text };
    return {};
  }
  if (e.type === "assistant") {
    const text = (e.message?.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text ?? "").join("");
    if (!text) return {};
    // --stream-partial-output 下 assistant 多为「本片增量」（春天/是/万物…）；
    // 偶发也会推全文快照或收尾重发。两种都要吃对，不能把短增量当成回退快照丢掉。
    if (acc && text === acc) return {};
    if (acc && text.startsWith(acc)) return { delta: text.slice(acc.length) }; // 全文快照：取后缀
    if (acc && acc.startsWith(text) && text.length < acc.length) return {}; // 更短回退快照
    return { delta: text }; // 碎片增量：直接追加
  }
  // cursor 思考增量（与正文分流；无 text 的 completed 忽略）
  if (e.type === "thinking" && e.subtype === "delta" && typeof e.text === "string" && e.text) {
    return { thinking: e.text };
  }
  return {};
}

function streamCli(
  cli: "claude" | "cursor",
  p: Provider,
  prompt: string,
  system: string | undefined,
  onDelta: (t: string) => void,
  signal?: AbortSignal,
  onThinking?: (t: string) => void,
): Promise<string> {
  const args = streamCliArgs(cli, prompt, system, p.model);
  const env = mergeCliEnv(cli, p);
  if (cli === "claude") Object.assign(env, { CLAUDE_CODE_EFFORT_LEVEL: "low", CLAUDE_EFFORT: "low" });
  return new Promise((resolve, reject) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(CLI_BIN[cli], args, {
        stdio: ["ignore", "pipe", "pipe"],
        env,
        cwd: cli === "cursor" ? cliWorkspaceDir() : undefined,
      });
    } catch (e) {
      reject(new Error(`${cli} CLI 启动失败: ${e}`));
      return;
    }
    let buf = "", acc = "", err = "", result: string | undefined, failure: string | undefined;
    const to = setTimeout(() => proc.kill(), 180_000);
    signal?.addEventListener("abort", () => proc.kill(), { once: true });
    const handle = (line: string) => {
      if (!line.trim()) return;
      const r = parseStreamLine(cli, line, acc);
      if (r.thinking) onThinking?.(r.thinking);
      if (r.delta) { acc += r.delta; onDelta(r.delta); }
      if (r.result !== undefined) result = r.result;
      if (r.error) failure = r.error;
    };
    proc.stdout!.on("data", (d) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    proc.stderr!.on("data", (d) => (err += d.toString()));
    proc.on("error", (e) => { clearTimeout(to); reject(new Error(`${cli} CLI 启动失败: ${e.message}`)); });
    proc.on("close", (code) => {
      clearTimeout(to);
      handle(buf);
      // cursor 的 result 往往是干净全文；若流式快照拼坏了，以 result 为准并补上缺口
      const final = (result || acc || "").trim();
      const streamed = acc.trim();
      if (failure && !final) return reject(new Error(formatCliError(cli, undefined, failure.slice(0, 300))));
      if (code !== 0 && !final) return reject(new Error(formatCliError(cli, code ?? undefined, err.trim().slice(0, 300))));
      if (!final) return reject(new Error(`${cli} CLI 返回为空`));
      if (result && result.trim() && result.trim() !== streamed) {
        if (!streamed) onDelta(result.trim());
        else if (result.trim().startsWith(streamed)) onDelta(result.trim().slice(streamed.length));
        // 分叉时上层仍拿 result；界面可能已有半段，会话落盘以 resolve 值为准由 runtime 用 r.text
      }
      resolve((result && result.trim()) ? result.trim() : final);
    });
  });
}

/** 对话用 cursor：纠正 CLI 默认人设，避免说 Ask/Agent、拒调 Harness 工具 */
const CURSOR_CHAT_PREAMBLE =
  "你是 Harness Bot 的对话脑（本机 cursor-agent 只负责生成回复）。本软件没有 Cursor IDE 的 Ask/Agent 切换，不要提、不要让用户去切。" +
  "需要看目录、开终端、改用户工程时，按系统设定输出 Harness 工具块（fs.list / term.* / cli.agent 等）；空沙箱里的文件操作对用户工程无效。" +
  "cli.agent 会另起可写的 Coding CLI，那才是改仓库的正路。";

/** CLI 是单轮调用：把最近历史折叠进 prompt；claude 有独立 system 参数，其余 CLI 把 system 也拼进去 */
function buildPrompt(cli: CliName, user: string, system?: string, history?: ChatMessage[]): string {
  const parts: string[] = [];
  // cursor 冷启动对超长 system 很敏感：截断到约 6k，保留人设与要点
  const sys = system && cli === "cursor" && system.length > 6000
    ? `${system.slice(0, 5500)}\n…（系统说明已截断以加快 CLI 响应）`
    : system;
  if (cli === "cursor") parts.push(`[Harness]\n${CURSOR_CHAT_PREAMBLE}`);
  if (sys && cli !== "claude") parts.push(`[系统设定]\n${sys}`);
  const histN = cli === "cursor" ? 6 : 10;
  const hist = (history ?? []).slice(-histN).map((m) => `${m.role === "assistant" ? "助手" : "用户"}: ${contentText(m.content)}`);
  if (hist.length) parts.push(`[对话历史]\n${hist.join("\n")}`);
  if (!parts.length) return user;
  parts.push(`[用户最新消息]\n${user}`);
  return parts.join("\n\n");
}

/** 额度耗尽等：提示本机登录态与换号方式（软件不缓存 Cursor 账号） */
export function formatCliError(cli: string, code: number | undefined, detail: string): string {
  const head = code == null ? `${cli} CLI 调用失败` : `${cli} CLI 调用失败(${code})`;
  const tip = /usage limit|ActionRequiredError|Spend Limit|月度|额度/i.test(detail)
    ? "\n本软件不存 Cursor 登录，每次现调本机 cursor-agent。IDE 换号 ≠ CLI 换号：终端执行 `cursor-agent logout` → `cursor-agent login`，再用 `cursor-agent status` 确认邮箱；或把 bot 模型切到 API（如 DeepSeek）。"
    : "";
  return `${head}: ${detail}${tip}`;
}

/**
 * 从 Cursor Agent / IDE 继承来的变量会劫持本机 CLI 登录（尤其 CURSOR_API_KEY），
 * 导致 logout/换号无效、一直打到 Agent 会话那个 Ultra 账号。spawn 前必须剥掉。
 */
const STRIP_CLI_ENV = [
  "CURSOR_API_KEY",
  "CURSOR_API_ENDPOINT",
  "CURSOR_AGENT",
  "CURSOR_AGENT_STORE_FILES_DIR",
  "CURSOR_AGENT_STORE_SHARED_PATHS",
  "CURSOR_CONVERSATION_ID",
  "CURSOR_REQUEST_ID",
  "CURSOR_EXTENSION_HOST_ROLE",
  "AGENT_TRANSCRIPTS",
  "CLAUDECODE",
  "CODEX_SANDBOX",
];

/** 派工/聊天 spawn 共用：剥掉会劫持本机 CLI 登录的变量。不注入 Vault。 */
export function strippedCliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of STRIP_CLI_ENV) delete env[k];
  return env;
}

/** 完整子进程 env：干净 process.env + 可选面板透传（仅聊天 Provider） */
function mergeCliEnv(cli: CliName, p: Provider): NodeJS.ProcessEnv {
  const env = strippedCliEnv();
  const extra = cliEnv(cli, p);
  if (extra) Object.assign(env, extra);
  return env;
}

/**
 * CLI 环境变量：把面板配置的 base url / api key 透传给 CLI 子进程。
 * codex 支持 OPENAI_BASE_URL + OPENAI_API_KEY（覆盖 ~/.codex 里的配置），
 * 这样面板统一管理 url/key，codex 只当「会写代码的工具外壳」。
 */
function cliEnv(cli: CliName, p: Provider): NodeJS.ProcessEnv | undefined {
  if (!p.baseUrl && !p.apiKey) return undefined;
  const env: NodeJS.ProcessEnv = {};
  if (p.baseUrl) {
    env.OPENAI_BASE_URL = p.baseUrl;
    env.CODEX_BASE_URL = p.baseUrl; // codex 也认这个
  }
  if (p.apiKey) {
    env.OPENAI_API_KEY = p.apiKey;
    env.CODEX_API_KEY = p.apiKey;
  }
  return env;
}

export function cliArgs(cli: CliName, prompt: string, system?: string, model?: string, outFile?: string): string[] {
  switch (cli) {
    case "codex":
      return ["exec", "--skip-git-repo-check", "--sandbox", "read-only", ...(model ? ["-m", model] : []), ...(outFile ? ["-o", outFile] : []), prompt];
    case "cursor":
      return [
        "-p", "--output-format", "text", "--trust", "--sandbox", "enabled",
        "--workspace", cliWorkspaceDir(),
        ...(model ? ["--model", model] : []),
        prompt,
      ];
    case "claude":
    default:
      return ["-p", prompt, ...(system ? ["--system-prompt", system] : []), ...(model ? ["--model", model] : [])];
  }
}

/** codex exec 的 stdout 混有运行日志，优先读 -o 写出的最终消息 */
function extractOutput(stdout: string, outFile?: string): string {
  if (outFile) {
    try {
      const last = readFileSync(outFile, "utf8").trim();
      if (last) return last;
    } catch {}
  }
  return stdout.trim();
}

function runQuiet(cmd: string, args: string[], opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      // opts.env 若已是完整 env（mergeCliEnv）直接用；否则在 process.env 上合并并剥掉 Agent 劫持变量
      let env = opts?.env;
      if (!env) {
        env = strippedCliEnv();
      } else if (!("PATH" in env) || !env.PATH) {
        env = { ...strippedCliEnv(), ...env };
        for (const k of STRIP_CLI_ENV) delete env[k];
      }
      proc = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env,
        cwd: cmd === CLI_BIN.cursor ? cliWorkspaceDir() : undefined,
      });
    } catch (e) {
      resolve({ code: -1, stdout: "", stderr: String(e) });
      return;
    }
    let out = "", err = "";
    const to = setTimeout(() => { proc.kill(); }, opts?.timeoutMs ?? 60_000);
    proc.stdout!.on("data", (d) => (out += d.toString()));
    proc.stderr!.on("data", (d) => (err += d.toString()));
    proc.on("close", (code) => { clearTimeout(to); resolve({ code: code ?? -1, stdout: out, stderr: err }); });
    proc.on("error", (e) => { clearTimeout(to); resolve({ code: -1, stdout: "", stderr: e.message }); });
  });
}
