/* 记忆、技能、定时任务、MCP 工具的管理接口（设置页用） */
import { ipcMain } from "electron";
import { memoryStats, type MemorySystem } from "../../core/memory-system";
import { draftSkillWithAI, type SkillRegistry } from "../../core/skill-registry";
import { skillFromText } from "../../core/bot-runtime";
import type { Store } from "../../core/store";
import type { Scheduler } from "../../core/scheduler";
import type { McpClient, McpServerConfig } from "../../core/mcp-client";
import { ensureBuiltinMcpServers, isBuiltinMcpId, mcpServersForClient } from "../../core/builtin-mcp";
import type { ProviderCenter } from "../../core/provider-center";
import type { ToolExecutor } from "../../core/tool-executor";
import type { AgentStatus } from "../../core/types";

export function registerKnowledgeIpc(deps: { store: Store; memory: MemorySystem; skills: SkillRegistry; scheduler: Scheduler; mcp: McpClient; providers: ProviderCenter; executor: ToolExecutor; statuses: Map<string, AgentStatus>; home: string }) {
  const { store, memory, skills, scheduler, mcp, providers, executor, statuses, home } = deps;
  ipcMain.handle("memory:list", (_e, botId: string) => memory.list(botId));
  ipcMain.handle("memory:stats", (_e, botId: string) => {
    return memoryStats(memory.list(botId));
  });
  ipcMain.handle("memory:search", (_e, botId: string, q: string) => memory.search(botId, q, 10));
  ipcMain.handle("memory:retrieve", async (_e, botId: string, q: string) => { const r = await memory.retrieve(botId, q, 10); return r; });
  ipcMain.handle("memory:namespaces", () => memory.namespaces());
  ipcMain.handle("memory:memo", (_e, ns: string) => memory.memoOf(ns));
  ipcMain.handle("memory:setMemo", (_e, ns: string, text: string) => memory.setMemo(ns, text));
  ipcMain.handle("memory:rewriteMemo", async (_e, ns: string) => {
    const p = providers.getDefault();
    if (!p) throw new Error("无默认 provider，无法生成总结");
    return memory.rewriteMemo(ns, async (_cur, recent) => {
      const r = await providers.complete(p, {
        system: "把以下记忆压缩为 3-8 条要点权威总结（中文，保留关键事实与偏好）。",
        user: recent.map((e) => `- ${e.content}`).join("\n"),
      });
      return r.text;
    });
  });
  ipcMain.handle("memory:merge", (_e, ns: string) => memory.mergeDuplicate(ns));
  ipcMain.handle("memory:evict", (_e, ns: string, budget: number) => memory.evict(ns, budget));
  ipcMain.handle("tools:run", async (_e, tool: string, args: any) => executor.run(tool, args));
  ipcMain.handle("mcp:list", () => mcp.listTools());
  ipcMain.handle("mcp:servers", () => mcp.status());
  /** 保存 MCP server 列表到 config 并重连 */
  ipcMain.handle("mcp:saveServers", async (_e, servers: McpServerConfig[]) => {
    // 内置电脑操控不可删：UI 若漏传也会被补回
    const next = ensureBuiltinMcpServers(servers.filter((s) => !isBuiltinMcpId(s.id) || s.builtin !== false), home);
    store.writeConfig({ ...store.readConfig(), mcpServers: next });
    await mcp.reload(mcpServersForClient(next, home));
    return mcp.status();
  });
  ipcMain.handle("mcp:call", async (_e, serverId: string, tool: string, args: any) => mcp.callTool(serverId, tool, args));
  ipcMain.handle("mcp:serversAll", () => {
    const cfg = (store.readConfig().mcpServers as McpServerConfig[] | undefined) ?? [];
    const all = ensureBuiltinMcpServers(cfg, home);
    const live = mcp.status();
    return all.map((s) => {
      const st = live.find((x) => x.id === s.id);
      return { ...s, tools: st?.tools ?? 0, error: s.enabled === false ? undefined : st?.error, connected: s.enabled !== false && !!st && !st.error };
    });
  });
  ipcMain.handle("status:list", () => [...statuses.values()]);
  ipcMain.handle("memory:add", (_e, botId: string, entry: any) => memory.add(botId, entry));
  ipcMain.handle("memory:delete", (_e, botId: string, id: string) => memory.delete(botId, id));
  ipcMain.handle("skills:list", () => skills.list());
  ipcMain.handle("skills:create", async (_e, text: string) => {
    const ask = text.replace(/^\s*(?:创建|新增|加一个|做一个)\s*(?:技能|skill)\s*[:：为是]?\s*/, "").trim() || text;
    const p = providers.get(store.listBots().find((b) => b.isMaster)?.providerId ?? "") ?? providers.getDefault();
    if (p) {
      const draft = await draftSkillWithAI(ask, (req) => providers.complete(p, req)).catch(() => null);
      if (draft) return skills.save(draft);
    }
    const parsed = skillFromText(`创建技能：${ask}`);
    if (!parsed) throw new Error("没听懂要创建的技能，试试：自动周报，每周五总结本周工作");
    return skills.create(parsed.key, parsed.markdown);
  });
  ipcMain.handle("skills:createRaw", (_e, key: string, markdown: string) => skills.create(key, markdown));
  ipcMain.handle("skills:setEnabled", (_e, key: string, enabled: boolean) => skills.setEnabled(key, enabled));
  ipcMain.handle("skills:delete", (_e, key: string) => skills.delete(key));
  ipcMain.handle("skills:forBot", (_e, botId: string) => skills.visibleTo(botId));
  ipcMain.handle("skills:save", (_e, input: { key?: string; name: string; description: string; body: string; owner?: string; enabled?: boolean }) => skills.save(input));
  ipcMain.handle("tasks:list", (_e, botId?: string) => botId ? scheduler.listForBot(botId) : scheduler.list());
  ipcMain.handle("tasks:create", (_e, input: any) => scheduler.create(input));
  ipcMain.handle("tasks:delete", (_e, id: string) => scheduler.delete(id));
  ipcMain.handle("tasks:setEnabled", (_e, id: string, enabled: boolean) => scheduler.setEnabled(id, enabled));
  ipcMain.handle("tasks:runNow", async (_e, id: string) => { const t = scheduler.list().find((x) => x.id === id); if (t && scheduler.onRun) await scheduler.onRun(t); return scheduler.list().find((x) => x.id === id); });
}
