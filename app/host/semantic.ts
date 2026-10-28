/* 语义回想：记忆 + 历史对话的真语义向量（本地模型 / 在线接口） */
import { join } from "node:path";
import { homedir } from "node:os";
import { ApiEmbedder, LocalEmbedder } from "../../core/embedders";
import { SemanticIndex, recallSection, type RecallItem, type RecallStatus } from "../../core/semantic-recall";
import { contentText, type Bot } from "../../core/types";
import type { Store } from "../../core/store";
import type { MemorySystem } from "../../core/memory-system";

export type EmbeddingConfig = { mode: "local" | "api" | "off"; baseUrl?: string; model?: string; apiKey?: string };

const BACKGROUND_SESSION = /^(eval|plan|sched)-/;

export function createSemanticRecall(deps: {
  home: string;
  store: Store;
  memory: MemorySystem;
  cipher: { encrypt(s: string): string; decrypt(s: string): string };
  /** bot 所在群聊的名字（群聊记忆也算它能回想的） */
  groupsOf: (botId: string) => string[];
  log: (msg: string) => void;
}) {
  const { home, store, memory, cipher } = deps;
  const config = (): EmbeddingConfig => (store.readConfig().embedding as EmbeddingConfig | undefined) ?? { mode: "local" };

  const items = (): RecallItem[] => {
    const out: RecallItem[] = [];
    for (const ns of memory.namespaces()) {
      for (const e of memory.list(ns)) {
        if (e.kind === "rule" || !e.content.trim()) continue;
        out.push({ key: `mem:${e.id}`, kind: "memory", text: e.content.slice(0, 1000), at: e.updatedAt, namespace: ns });
      }
    }
    const msgs: RecallItem[] = [];
    for (const s of store.listSessions()) {
      if (BACKGROUND_SESSION.test(s.id)) continue;
      store.listMessages(s.id).forEach((m, i) => {
        if (m.role === "system") return;
        const text = contentText(m.content).replace(/\s+/g, " ").trim();
        if (text.length < 6) return;
        msgs.push({ key: `msg:${s.id}:${m.id ?? `${m.createdAt}-${i}`}`, kind: "message", text: text.slice(0, 600), at: m.createdAt, botId: s.botId, sessionId: s.id, role: m.role });
      });
    }
    return [...out, ...msgs.sort((a, b) => b.at - a.at).slice(0, 4000)];
  };

  let index: SemanticIndex | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (delay = 5000) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void index?.sync().then(() => deps.log(JSON.stringify(index?.status()))); }, delay);
  };
  const setup = () => {
    const c = config();
    let key: string | undefined;
    try { key = c.apiKey ? cipher.decrypt(c.apiKey) : undefined; } catch { key = undefined; }
    index = c.mode === "off" ? null
      : c.mode === "api" && c.baseUrl && c.model ? new SemanticIndex(join(home, "vectors"), new ApiEmbedder({ baseUrl: c.baseUrl, model: c.model, apiKey: key }), items)
      : new SemanticIndex(join(home, "vectors"), new LocalEmbedder(join(homedir(), "Library", "Caches", "harness-bot", "models")), items);
    if (index) schedule(3000);
  };
  const status = (): RecallStatus | null => index?.status() ?? null;

  return {
    setup,
    schedule,
    status,
    /** 给 runtime 的回想：这个 bot 能看到的记忆 + 它在别的会话里的对话 */
    recall: async (bot: Bot, query: string, excludeSession?: string): Promise<string> => {
      if (!index) return "";
      schedule(20_000);
      const groupNs = new Set(deps.groupsOf(bot.id).map((g) => `group:${g}`));
      const hits = await index.search(query, (i) => i.kind === "memory"
        ? i.namespace === `bot:${bot.id}` || i.namespace === "global" || groupNs.has(i.namespace ?? "")
        : i.botId === bot.id && i.sessionId !== excludeSession, 6);
      return recallSection(hits, (id) => store.getBot(id)?.name ?? id);
    },
    getConfig: () => {
      const c = config();
      return { ...c, apiKey: c.apiKey ? "***" : "", status: status() };
    },
    setConfig: async (value: EmbeddingConfig) => {
      const prev = config();
      const mode = (["local", "api", "off"] as const).includes(value.mode) ? value.mode : "local";
      const apiKey = value.apiKey === "__keep__" ? prev.apiKey : value.apiKey ? cipher.encrypt(value.apiKey) : undefined;
      const next: EmbeddingConfig = mode === "api" ? { mode, baseUrl: value.baseUrl?.trim(), model: value.model?.trim(), apiKey } : { mode };
      if (mode === "api") {
        if (!next.baseUrl || !next.model) throw new Error("填 Base URL 和向量模型");
        const test = new ApiEmbedder({ baseUrl: next.baseUrl, model: next.model, apiKey: apiKey ? cipher.decrypt(apiKey) : undefined });
        await test.embedMany(["连接测试"], "query");
      }
      store.writeConfig({ ...store.readConfig(), embedding: next });
      setup();
      return status();
    },
  };
}
