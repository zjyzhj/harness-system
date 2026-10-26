import { spawn } from "node:child_process";
import type { Provider } from "../types";

export type CliName = "codex" | "cursor" | "claude";

export interface CliCapability {
  installed: boolean;
  version?: string;
  chat: boolean;
}

export async function detectCli(name: CliName): Promise<CliCapability> {
  const v = await runQuiet(name, ["--version"]);
  if (v.code === 0 && v.stdout.trim()) {
    return { installed: true, version: v.stdout.trim().split("\n")[0], chat: true };
  }
  return { installed: false, chat: false };
}

/**
 * CLI 适配器：spawn 子进程调用。
 * 不同 CLI 参数差异封装在 cliArgs 中；失败抛出可读错误，由上层降级到 API。
 */
export async function completeCli(p: Provider, user: string, system?: string, model?: string): Promise<string> {
  const cli = p.cliName ?? "claude";
  const args = cliArgs(cli, user, system, model ?? p.model);
  const env = cliEnv(cli, p);
  const r = await runQuiet(cli, args, { timeoutMs: 120_000, env });
  if (r.code !== 0) {
    throw new Error(`${cli} CLI 调用失败(${r.code}): ${r.stderr.trim().slice(0, 300) || r.stdout.trim().slice(0, 300)}`);
  }
  const text = extractOutput(cli, r.stdout);
  if (!text) throw new Error(`${cli} CLI 返回为空`);
  return text;
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

function cliArgs(cli: CliName, user: string, system?: string, model?: string): string[] {
  switch (cli) {
    case "codex":
      return ["exec", "--skip-git-repo-check", "--sandbox", "read-only", ...(model ? ["--model", model] : []), "-f", `system: ${system ?? ""}`, `user: ${user}`];
    case "cursor":
      return ["--spawn", user];
    case "claude":
    default:
      return ["-p", user, ...(system ? ["--system-prompt", system] : [])];
  }
}

function extractOutput(cli: CliName, stdout: string): string {
  switch (cli) {
    case "codex":
      // codex exec 输出首行可能包含状态摘要，取后续正文
      return stdout.trim();
    default:
      return stdout.trim();
  }
}

function runQuiet(cmd: string, args: string[], opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: opts?.env ? { ...process.env, ...opts.env } : undefined });
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
