import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPUTER_MCP_ID, ensureBuiltinMcpServers, isBuiltinMcpId, mcpServersForClient, resolveComputerUseMcp } from "../core/builtin-mcp";

describe("内置电脑操控 MCP", () => {
  test("darwin 下能解析启动命令", () => {
    if (process.platform !== "darwin") return;
    const s = resolveComputerUseMcp();
    expect(s?.id).toBe(COMPUTER_MCP_ID);
    expect(s?.builtin).toBe(true);
    expect(s?.command).toBeTruthy();
  });

  test("ensure 会补回 computer；关掉时 client 列表不含它", () => {
    const home = mkdtempSync(join(tmpdir(), "harness-cu-"));
    const out = ensureBuiltinMcpServers([{ id: "git", name: "Git", command: "npx", args: ["-y", "mcp-git"] }], home);
    if (process.platform !== "darwin") return;
    expect(out.some((s) => s.id === COMPUTER_MCP_ID)).toBe(true);
    const off = out.map((s) => (s.id === COMPUTER_MCP_ID ? { ...s, enabled: false } : s));
    expect(mcpServersForClient(off, home).every((s) => s.id !== COMPUTER_MCP_ID)).toBe(true);
  });

  test("isBuiltinMcpId", () => {
    expect(isBuiltinMcpId("computer")).toBe(true);
    expect(isBuiltinMcpId("git")).toBe(false);
  });
});
