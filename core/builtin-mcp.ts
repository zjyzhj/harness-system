/**
 * 软件内置 MCP：电脑操控 = macos-computer-use-kit（不自研点击栈）。
 * 运行时由 computer-use-setup 一键装到软件数据目录，用户不必自己装 uv。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { McpServerConfig } from "./mcp-client";

export const COMPUTER_MCP_ID = "computer";

export function managedBinDir(home: string): string {
  return join(home, "bin");
}
export function managedUvx(home: string): string {
  return join(managedBinDir(home), "uvx");
}
export function managedUv(home: string): string {
  return join(managedBinDir(home), "uv");
}

function firstBin(names: string[], extraDirs: string[] = []): string | null {
  const home = homedir();
  const dirs = [...extraDirs, join(home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", ...(process.env.PATH ?? "").split(delimiter)];
  for (const d of dirs) {
    for (const n of names) {
      const p = join(d, n);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** macOS 上解析电脑操控 MCP；优先软件自管 uvx */
export function resolveComputerUseMcp(home?: string): McpServerConfig | null {
  if (process.platform !== "darwin") return null;
  const managed = home ? managedUvx(home) : "";
  const cu = firstBin(["macos-cu"], home ? [join(home, "bin")] : []);
  if (cu) {
    return { id: COMPUTER_MCP_ID, name: "电脑操控", command: cu, args: ["mcp"], builtin: true, enabled: true };
  }
  const uvx = (managed && existsSync(managed) ? managed : null) || firstBin(["uvx"], home ? [join(home, "bin")] : []);
  if (uvx) {
    return { id: COMPUTER_MCP_ID, name: "电脑操控", command: uvx, args: ["macos-computer-use-kit", "mcp"], builtin: true, enabled: true };
  }
  // 尚未安装运行时：仍登记条目，enabled 默认 false，等用户一键开启
  return {
    id: COMPUTER_MCP_ID,
    name: "电脑操控",
    command: managed || "uvx",
    args: ["macos-computer-use-kit", "mcp"],
    builtin: true,
    enabled: false,
  };
}

export function isBuiltinMcpId(id: string): boolean {
  return id === COMPUTER_MCP_ID;
}

/** 合并内置项；保留用户的 enabled；实际连接时再 filter enabled !== false */
export function ensureBuiltinMcpServers(servers: McpServerConfig[], home?: string): McpServerConfig[] {
  const computer = resolveComputerUseMcp(home);
  if (!computer) return servers.map((s) => (isBuiltinMcpId(s.id) ? { ...s, builtin: true } : s));
  const rest = servers.filter((s) => s.id !== COMPUTER_MCP_ID);
  const prev = servers.find((s) => s.id === COMPUTER_MCP_ID);
  const merged: McpServerConfig = prev
    ? {
        ...computer,
        ...prev,
        id: COMPUTER_MCP_ID,
        name: computer.name,
        builtin: true,
        // 有可用 command 时沿用解析结果（自管 uvx），否则保留 prev
        command: computer.command || prev.command,
        args: computer.args?.length ? computer.args : prev.args,
        enabled: prev.enabled ?? computer.enabled,
      }
    : computer;
  return [merged, ...rest];
}

/** 交给 McpClient 连接的列表（关掉的内置不连） */
export function mcpServersForClient(servers: McpServerConfig[], home?: string): McpServerConfig[] {
  return ensureBuiltinMcpServers(servers, home).filter((s) => s.enabled !== false);
}
