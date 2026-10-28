import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpClient } from "../core/mcp-client";

const dir = mkdtempSync(join(tmpdir(), "harness-mcp-"));
const server = join(dir, "fake-mcp.js");
// 按规范：没 initialize 之前拒绝其他请求；tools/list 返回一个很大的结果，逼出分块输出
writeFileSync(server, `
let ready = false, buf = "";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
    else if (msg.method === "notifications/initialized") ready = true;
    else if (!ready) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32002, message: "not initialized" } });
    else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: Array.from({ length: 400 }, (_, k) => ({ name: "t" + k, description: "x".repeat(300), inputSchema: { type: "object" } })) } });
    else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo:" + msg.params.arguments.v }] } });
  }
});
`);

const clients: McpClient[] = [];
afterAll(() => clients.forEach((c) => c.close()));

describe("MCP stdio", () => {
  test("先握手再列工具，大结果分块到达也能解析，工具能调用", async () => {
    const c = new McpClient([{ id: "fake", name: "fake", command: process.execPath, args: [server] }]);
    clients.push(c);
    await c.init();
    expect(c.status()[0].error).toBeUndefined();
    expect(c.listTools().length).toBe(400);
    expect(await c.callTool("fake", "t1", { v: 42 })).toBe("echo:42");
  });

  test("进程一启动就退出：马上报错，不用等超时", async () => {
    const c = new McpClient([{ id: "bad", name: "bad", command: "/usr/bin/false" }]);
    clients.push(c);
    const t0 = Date.now();
    await c.init();
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(c.status()[0].error).toContain("进程已退出");
  });

  test("命令不存在：给出清楚的提示", async () => {
    const c = new McpClient([{ id: "nope", name: "nope", command: "definitely-not-a-command-xyz" }]);
    clients.push(c);
    await c.init();
    expect(c.status()[0].error).toContain("找不到命令");
  });
});
