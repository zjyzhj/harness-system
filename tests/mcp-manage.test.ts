import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import { MemorySystem } from "../core/memory-system";
import { SkillRegistry } from "../core/skill-registry";
import { BotRuntime } from "../core/bot-runtime";
import { ProviderCenter } from "../core/provider-center";
import type { Bot } from "../core/types";

describe("对话里管理 MCP", () => {
  const home = mkdtempSync(join(tmpdir(), "harness-mcp-manage-"));
  const store = new Store(home);
  afterAll(() => store.close());
  const bot: Bot = { id: "a", name: "助手", role: "通用", persona: "", providerId: "", petEnabled: false, createdAt: 1 };
  store.saveBot(bot);

  test("mcp.list / mcp.add / mcp.remove 走 mcpManage，并通知界面", async () => {
    const servers: Array<{ id: string; name: string; command?: string; args?: string[]; tools: number; error?: string }> = [];
    const changes: string[] = [];
    let resyncCalls = 0;
    const rt = new BotRuntime({
      store,
      providers: new ProviderCenter(store),
      memory: new MemorySystem(home),
      skills: new SkillRegistry(join(home, "skills")),
      onAppChanged: (w) => changes.push(w),
      mcpManage: {
        list: () => servers,
        resync: async () => {
          resyncCalls++;
          // 模拟手改 config：磁盘多了 fetch，list 时补进内存
          if (!servers.some((s) => s.id === "fetch")) {
            servers.push({ id: "fetch", name: "网页抓取", command: "npx", args: ["-y", "mcp-fetch-server"], tools: 3 });
            return { reloaded: true, count: servers.length };
          }
          return { reloaded: false, count: servers.length };
        },
        add: async (input) => {
          const id = input.id || "git";
          const row = { id, name: input.name, command: input.command, args: input.args, tools: 15 };
          servers.push(row);
          return row;
        },
        remove: async (key) => {
          const i = servers.findIndex((s) => s.id === key || s.name === key);
          if (i < 0) return { error: "没有" };
          const [hit] = servers.splice(i, 1);
          return { removed: hit.name };
        },
      },
    });
    const run = (tool: string, args: Record<string, unknown>) =>
      (rt as any).executeBuiltin(bot, { tool, args }, "", 0, "s1");

    const listed = await run("mcp.list", {});
    expect(resyncCalls).toBe(1);
    expect(listed.output).toContain("网页抓取");
    expect(listed.output).toContain("热加载");
    expect(changes).toContain("mcp");

    servers.length = 0;
    expect((await run("mcp.list", {})).output).toContain("网页抓取"); // resync 再补一次
    const added = await run("mcp.add", { name: "Git", command: "npx -y mcp-git" });
    expect(added.output).toContain("已接入 MCP「Git」");
    expect(added.output).toContain("mcp:git/");
    expect(servers.some((s) => s.id === "git")).toBe(true);

    expect((await run("mcp.remove", { name: "Git" })).output).toContain("已移除");
    expect(servers.every((s) => s.id !== "git")).toBe(true);

    // HTTP MCP 指向本机且无授权中心 → 拒绝（防 SSRF）
    const local = await run("mcp.add", { name: "内网", url: "http://127.0.0.1:9999/mcp" });
    expect(local.output).toMatch(/未允许|拒绝/);
  });
});
