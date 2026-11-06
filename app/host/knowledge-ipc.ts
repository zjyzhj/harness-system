/* 记忆、技能、定时任务、MCP 工具的管理接口（设置页用） */
import { ipcMain } from "electron";
import { memoryStats, memoRewriteMessages, type MemorySystem } from "../../core/memory-system";
import { draftSkillWithAI, BUILTIN_SKILL_TEMPLATES, parseSkill, type SkillRegistry } from "../../core/skill-registry";
import { skillFromText } from "../../core/bot-runtime";
import type { Store } from "../../core/store";
import type { Scheduler } from "../../core/scheduler";
import type { McpClient, McpServerConfig } from "../../core/mcp-client";
import { ensureBuiltinMcpServers, isBuiltinMcpId, mcpServersForClient } from "../../core/builtin-mcp";
import type { ProviderCenter } from "../../core/provider-center";
import type { ToolExecutor } from "../../core/tool-executor";
import type { AgentStatus } from "../../core/types";
import { registerCloudInboundTokens, unregisterCloudInboundTokens } from "../../core/share-bridge";

export function registerKnowledgeIpc(deps: { store: Store; memory: MemorySystem; skills: SkillRegistry; scheduler: Scheduler; mcp: McpClient; providers: ProviderCenter; executor: ToolExecutor; statuses: Map<string, AgentStatus>; home: string }) {
  const { store, memory, skills, scheduler, mcp, providers, executor, statuses, home } = deps;
  const syncRegister = (token?: string | null) => {
    if (!token) return;
    void registerCloudInboundTokens([token]).catch(() => {});
  };
  const syncUnregister = (token?: string | null) => {
    if (!token) return;
    void unregisterCloudInboundTokens([token]).catch(() => {});
  };
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
    return memory.rewriteMemo(ns, async (cur, recent) => {
      const msg = memoRewriteMessages(cur, recent);
      const r = await providers.complete(p, { system: msg.system, user: msg.user });
      return r.text.trim() || cur;
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
  /** 从其它助手导入记忆：每行一条，或 JSON 数组 [{kind,content}] */
  ipcMain.handle("memory:import", (_e, botId: string, payload: string | Array<{ kind?: string; content: string }>, opts?: { namespace?: string }) => {
    const ns = opts?.namespace;
    const items: Array<{ kind: string; content: string }> = [];
    if (typeof payload === "string") {
      const trimmed = payload.trim();
      if (trimmed.startsWith("[")) {
        try {
          const arr = JSON.parse(trimmed) as unknown;
          if (Array.isArray(arr)) {
            for (const x of arr) {
              if (x && typeof x === "object" && typeof (x as { content?: unknown }).content === "string") {
                const kind = String((x as { kind?: string }).kind || "fact");
                items.push({ kind: ["rule", "fact", "event", "note", "summary"].includes(kind) ? kind : "fact", content: (x as { content: string }).content.trim() });
              }
            }
          }
        } catch { /* fall through to lines */ }
      }
      if (!items.length) {
        for (const line of trimmed.split(/\n+/)) {
          const c = line.replace(/^[-*•\d.)\s]+/, "").trim();
          if (c.length >= 2) items.push({ kind: "fact", content: c });
        }
      }
    } else if (Array.isArray(payload)) {
      for (const x of payload) {
        const c = String(x?.content ?? "").trim();
        if (c.length < 2) continue;
        const kind = String(x?.kind || "fact");
        items.push({ kind: ["rule", "fact", "event", "note", "summary"].includes(kind) ? kind : "fact", content: c });
      }
    }
    let n = 0;
    for (const it of items.slice(0, 200)) {
      memory.add(botId, { kind: it.kind as any, content: it.content, tags: ["import"], source: "manual", namespace: ns });
      n++;
    }
    return { ok: true, count: n };
  });
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
  ipcMain.handle("skills:templates", () =>
    Object.entries(BUILTIN_SKILL_TEMPLATES).map(([key, md]) => {
      const parsed = parseSkill(key, key, md);
      return {
        key,
        name: parsed?.name ?? key,
        description: parsed?.description ?? "",
        installed: !!skills.get(key),
      };
    }),
  );
  ipcMain.handle("skills:installTemplate", (_e, key: string, botId?: string) => {
    const md = BUILTIN_SKILL_TEMPLATES[key];
    if (!md) throw new Error(`没有模板「${key}」`);
    const parsed = parseSkill(key, key, md);
    if (!parsed) throw new Error(`模板「${key}」格式无效`);
    if (botId) {
      return skills.save({
        name: parsed.name,
        description: parsed.description,
        body: parsed.body,
        owner: botId,
      });
    }
    const existing = skills.get(key);
    if (existing) return existing;
    return skills.create(key, md);
  });
  ipcMain.handle("tasks:list", (_e, botId?: string) => botId ? scheduler.listForBot(botId) : scheduler.list());
  ipcMain.handle("tasks:create", (_e, input: any) => {
    const t = scheduler.create(input);
    syncRegister(t.webhookToken);
    return t;
  });
  ipcMain.handle("tasks:update", (_e, id: string, patch: Record<string, unknown>) => scheduler.patchPublic(id, patch));
  ipcMain.handle("tasks:delete", (_e, id: string) => {
    const prev = scheduler.get(id)?.webhookToken;
    scheduler.delete(id);
    syncUnregister(prev);
  });
  ipcMain.handle("tasks:setEnabled", (_e, id: string, enabled: boolean) => scheduler.setEnabled(id, enabled));
  // 立刻返回「执行中」，避免 UI 等整轮对话（可长达数分钟）把界面卡住
  ipcMain.handle("tasks:runNow", async (_e, id: string) => scheduler.runNow(id, { wait: false }));
  ipcMain.handle("tasks:ensureWebhook", (_e, id: string) => {
    const t = scheduler.ensureWebhookToken(id);
    syncRegister(t?.webhookToken);
    return t;
  });
  ipcMain.handle("tasks:rotateWebhook", (_e, id: string) => {
    const prev = scheduler.get(id)?.webhookToken;
    const t = scheduler.rotateWebhookToken(id);
    syncUnregister(prev);
    syncRegister(t?.webhookToken);
    return t;
  });
  ipcMain.handle("tasks:clearWebhook", (_e, id: string) => {
    const prev = scheduler.get(id)?.webhookToken;
    const t = scheduler.clearWebhookToken(id);
    syncUnregister(prev);
    return t;
  });
}
