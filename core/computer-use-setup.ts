/**
 * 电脑操控一键就绪：把 uv 装到软件数据目录，热身 macos-computer-use-kit，不要求用户自己装工具链。
 */
import { createWriteStream, existsSync, mkdirSync, chmodSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { McpServerConfig } from "./mcp-client";
import { COMPUTER_MCP_ID, managedBinDir, managedUv, managedUvx } from "./builtin-mcp";

const UV_VERSION = "0.11.7";

export { managedBinDir, managedUv, managedUvx };

function uvAssetName(): string {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  return `uv-${arch}-apple-darwin.tar.gz`;
}

function run(cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: opts?.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, opts?.timeoutMs ?? 120_000);
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: 1, stdout, stderr: e.message }); });
  });
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}`);
  // Node fetch body → file via tar extract below; write gz first
  const tmp = `${dest}.partial`;
  const file = createWriteStream(tmp);
  // @ts-expect-error undici body is web stream
  await pipeline(Readable.fromWeb(res.body), file);
  renameSync(tmp, dest);
}

/** 确保 ~/…/harness-bot/bin 里有 uv + uvx（没有就下载官方包） */
export async function ensureManagedUv(home: string, onProgress?: (msg: string) => void): Promise<{ uv: string; uvx: string }> {
  const bin = managedBinDir(home);
  mkdirSync(bin, { recursive: true });
  const uv = managedUv(home);
  const uvx = managedUvx(home);
  if (existsSync(uv) && existsSync(uvx)) {
    onProgress?.("运行时已就绪");
    return { uv, uvx };
  }
  onProgress?.("正在下载电脑操控运行时（uv）…");
  const asset = uvAssetName();
  const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}`;
  const tgz = join(bin, asset);
  try {
    await download(url, tgz);
  } catch (e) {
    // 备用：官方安装脚本装到 managed bin（仅当 GitHub 失败）
    onProgress?.("改用官方安装脚本…");
    const r = await run("/bin/bash", ["-lc", `curl -LsSf https://astral.sh/uv/${UV_VERSION}/install.sh | env UV_INSTALL_DIR=${JSON.stringify(bin)} sh`], { timeoutMs: 180_000 });
    if (!existsSync(uvx)) throw new Error(`安装 uv 失败：${e instanceof Error ? e.message : e}; ${r.stderr.slice(-300)}`);
    return { uv, uvx };
  }
  onProgress?.("正在解压…");
  const extract = await run("tar", ["-xzf", tgz, "-C", bin], { timeoutMs: 60_000 });
  try { unlinkSync(tgz); } catch { /* ignore */ }
  // tarball 可能是 uv-ARCH/uv 扁平或带目录
  if (!existsSync(uvx)) {
    const nested = join(bin, asset.replace(/\.tar\.gz$/, ""), "uvx");
    const nestedUv = join(bin, asset.replace(/\.tar\.gz$/, ""), "uv");
    if (existsSync(nested)) {
      renameSync(nested, uvx);
      if (existsSync(nestedUv)) renameSync(nestedUv, uv);
    }
  }
  if (!existsSync(uvx)) throw new Error(`解压 uv 失败：${extract.stderr.slice(-400)}`);
  try { chmodSync(uv, 0o755); chmodSync(uvx, 0o755); } catch { /* ignore */ }
  return { uv, uvx };
}

/** 预拉 macos-computer-use-kit，避免第一次对话才冷启动很久 */
export async function warmComputerUseKit(uvx: string, onProgress?: (msg: string) => void): Promise<void> {
  onProgress?.("正在准备电脑操控工具包…");
  const env = { ...process.env, PATH: `${join(uvx, "..")}:${process.env.PATH ?? ""}` };
  const r = await run(uvx, ["macos-computer-use-kit", "--help"], { env, timeoutMs: 180_000 });
  if (r.code !== 0) throw new Error(`准备工具包失败：${(r.stderr || r.stdout).slice(-400)}`);
}

export function computerMcpConfig(home: string): McpServerConfig {
  const uvx = existsSync(managedUvx(home)) ? managedUvx(home) : (existsSync(join(homedir(), ".local/bin/uvx")) ? join(homedir(), ".local/bin/uvx") : managedUvx(home));
  return {
    id: COMPUTER_MCP_ID,
    name: "电脑操控",
    command: uvx,
    args: ["macos-computer-use-kit", "mcp"],
    builtin: true,
    enabled: true,
  };
}

export type ComputerUseStatus = {
  platformOk: boolean;
  enabled: boolean;
  runtimeReady: boolean;
  tools: number;
  error?: string;
  permissions: { accessibility: boolean; screen: boolean };
  needsPermission: boolean;
  uvx?: string;
  /** 给界面的分步清单 */
  steps: Array<{ id: string; label: string; ok: boolean; detail?: string }>;
  /** doctor 原文摘要（可选） */
  doctor?: string;
};

export function readComputerEnabled(servers: McpServerConfig[]): boolean {
  const s = servers.find((x) => x.id === COMPUTER_MCP_ID);
  if (!s) return false;
  return s.enabled !== false;
}

/** 把连接失败说成人话 */
export function humanizeComputerError(err?: string): string | undefined {
  if (!err) return undefined;
  const e = err.toLowerCase();
  if (/enoent|找不到命令|uvx|spawn/i.test(err)) return "运行时还没装好，请再开一次开关自动安装";
  if (/timeout|超时/i.test(err)) return "连接超时，多半是首次拉包较慢，再开一次开关即可";
  if (/accessib|辅助功能|tcc/i.test(e)) return "缺少「辅助功能」权限，请在系统设置里勾选本软件";
  if (/screen|录制|capture/i.test(e)) return "缺少「屏幕录制」权限，请在系统设置里勾选本软件";
  return err.slice(0, 200);
}

export function buildComputerSteps(input: {
  enabled: boolean;
  runtimeReady: boolean;
  tools: number;
  permissions: { accessibility: boolean; screen: boolean };
  error?: string;
}): ComputerUseStatus["steps"] {
  return [
    { id: "runtime", label: "运行时", ok: input.runtimeReady || input.tools > 0, detail: input.runtimeReady || input.tools > 0 ? "uv + 工具包已就绪" : "打开开关后自动安装" },
    { id: "connect", label: "已连接", ok: input.enabled && input.tools > 0 && !input.error, detail: input.tools > 0 ? `${input.tools} 个工具` : (input.error ? humanizeComputerError(input.error) : input.enabled ? "连接中…" : "尚未开启") },
    { id: "accessibility", label: "辅助功能", ok: input.permissions.accessibility, detail: input.permissions.accessibility ? "已授权" : "系统设置 → 隐私 → 辅助功能" },
    { id: "screen", label: "屏幕录制", ok: input.permissions.screen, detail: input.permissions.screen ? "已授权" : "系统设置 → 隐私 → 屏幕录制" },
  ];
}
