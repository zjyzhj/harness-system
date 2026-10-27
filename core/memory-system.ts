import { randomUUID } from "node:crypto";
import type { MemoryEntry } from "./types";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { HashVectorEmbedder, cosine, keywordScore, type Embedder } from "./embedders";

/**
 * G2 持久记忆系统（对齐 CowAgent + OpenClaw memory 模型）
 * - namespace：bot:<id> | group:<name> | global（级联检索 bot → group → global）
 * - 检索：哈希向量 + 关键词 BM25-lite 双通道（可注入 OpenAI 嵌入升级）
 * - MEMORY.md：每 namespace 权威总结，常驻注入，LLM 增量重写
 * - 维护：mergeDuplicate（内容相似合并）+ evict（容量淘汰）
 * 旧路径 memory/<botId>.json 自动兼容映射到 bot:<botId>。
 */
const nsFile = (ns: string) => ns.replace(/[^a-zA-Z0-9:_-]/g, "_");

export class MemorySystem {
  private mem: Record<string, MemoryEntry[]> = {};
  private memoNames: Record<string, string> = {};
  private dir: string;
  private embedder: Embedder = new HashVectorEmbedder();

  constructor(private home: string) {
    this.dir = join(home, "memory");
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    this.loadAll();
    this.migrateLegacy();
  }

  // ---- 存储 ----

  private fileFor(ns: string) {
    return join(this.dir, `${nsFile(ns)}.json`);
  }
  private memoFile(ns: string) {
    return join(this.dir, nsFile(ns), "MEMORY.md");
  }

  private loadAll() {
    for (const f of readdirSync(this.dir).filter((f) => f.endsWith(".json"))) {
      const key = basename(f, ".json");
      try {
        const arr = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as MemoryEntry[];
        const ns = key.startsWith("bot:") || key.startsWith("group:") || key === "global" ? key : `bot:${key}`;
        this.mem[ns] = arr;
      } catch {
        // ignore corrupt
      }
    }
    // MEMORY.md
    for (const d of readdirSync(this.dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const ns = d.name === "global" ? "global" : d.name.startsWith("bot:") || d.name.startsWith("group:") ? d.name : `bot:${d.name}`;
      const mf = join(this.dir, d.name, "MEMORY.md");
      if (existsSync(mf)) this.memoNames[ns] = readFileSync(mf, "utf8");
    }
  }

  /** 旧格式 memory/<botId>.json → bot:<botId>（幂等，已有 bot: 前缀则跳过） */
  private migrateLegacy() {
    let changed = false;
    for (const f of readdirSync(this.dir).filter((f) => f.endsWith(".json"))) {
      const key = basename(f, ".json");
      if (key.startsWith("bot:") || key.startsWith("group:") || key === "global") continue;
      const legacyPath = join(this.dir, f);
      const ns = `bot:${key}`;
      const dest = this.fileFor(ns);
      if (!existsSync(dest)) {
        try {
          const arr = JSON.parse(readFileSync(legacyPath, "utf8")) as MemoryEntry[];
          arr.forEach((e) => (e.namespace = `bot:${key}`));
          this.mem[ns] = arr;
          writeFileSync(dest, JSON.stringify(arr, null, 2), "utf8");
          rmSync(legacyPath, { force: true });
          changed = true;
        } catch { /* ignore */ }
      }
    }
    if (changed) { /* mem already updated */ }
  }

  private persist(ns: string) {
    writeFileSync(this.fileFor(ns), JSON.stringify(this.mem[ns] ?? [], null, 2), "utf8");
  }

  // ---- CRUD（namespace 感知，兼容旧 botId 签名） ----

  private normNs(nsOrBotId: string, entryNamespace?: string): string {
    if (entryNamespace) return entryNamespace;
    if (nsOrBotId.startsWith("bot:") || nsOrBotId.startsWith("group:")) return nsOrBotId;
    // 兼容旧 botId / 显式 global
    return nsOrBotId === "global" ? "global" : `bot:${nsOrBotId}`;
  }

  list(nsOrBotId: string, namespace?: string): MemoryEntry[] {
    const ns = this.normNs(nsOrBotId, namespace);
    return this.mem[ns] ?? [];
  }

  add(botId: string, entry: Omit<MemoryEntry, "id" | "botId" | "createdAt" | "updatedAt"> & { id?: string; namespace?: string }): MemoryEntry {
    const ns = this.normNs(botId, entry.namespace);
    const arr = this.mem[ns] || (this.mem[ns] = []);
    const now = Date.now();
    const e: MemoryEntry = {
      id: entry.id ?? randomUUID(),
      botId,
      kind: entry.kind,
      content: entry.content,
      tags: entry.tags,
      source: entry.source,
      namespace: ns,
      createdAt: now,
      updatedAt: now,
      vectorKind: "hash",
    };
    // 缓存向量（懒：hash 立即算，openai 异步由 ensureVector 补）
    if (this.embedder instanceof HashVectorEmbedder) {
      e.vector = this.embedder.embed(entry.content);
    }
    arr.push(e);
    this.mem[ns] = dedupe(arr);
    this.persist(ns);
    return e;
  }

  update(botId: string, id: string, content: string): MemoryEntry | null {
    const ns = this.normNs(botId);
    const arr = this.mem[ns];
    const e = arr?.find((x) => x.id === id);
    if (!e) return null;
    e.content = content;
    e.updatedAt = Date.now();
    if (this.embedder instanceof HashVectorEmbedder) e.vector = this.embedder.embed(content);
    this.persist(ns);
    return e;
  }

  delete(botId: string, id: string) {
    const ns = this.normNs(botId);
    this.mem[ns] = (this.mem[ns] ?? []).filter((x) => x.id !== id);
    this.persist(ns);
  }

  setEmbedder(e: Embedder) { this.embedder = e; }
  getEmbedder(): Embedder { return this.embedder; }

  // ---- 检索（哈希向量 + 关键词双通道） ----

  /** 语义检索：单 namespace；开向量缓存，无缓存时现算 */
  async retrieve(nsOrBotId: string, query: string, limit = 8, namespace?: string): Promise<MemoryEntry[]> {
    const ns = this.normNs(nsOrBotId, namespace);
    const arr = this.list(ns);
    if (!arr.length || !query.trim()) return [];
    const qv = (await this.embedder.embed(query)) as number[];
    // 补向量缓存（openai 场景）
    const ranked = arr.map((e) => {
      if (!e.vector || e.vectorKind !== "hash" && this.embedder.constructor.name === "HashVectorEmbedder") {
        if (this.embedder instanceof HashVectorEmbedder && !e.vector) e.vector = this.embedder.embed(e.content);
      }
      const vec = e.vector ?? [];
      const sim = vec.length && qv.length ? cosine(vec, qv) : 0;
      const kw = keywordScore(e.content, query);
      const recency = e.updatedAt / Date.now();
      return { e, score: sim * 4 + kw * 2 + recency * 0.5 };
    });
    ranked.sort((a, b) => b.score - a.score);
    return ranked.slice(0, limit).map((x) => x.e);
  }

  /** 级联检索：bot → 其 group → global（合并去重，按分排序） */
  async retrieveCascade(botId: string, groups: string[], query: string, limit = 8): Promise<MemoryEntry[]> {
    const nsList = [`bot:${botId}`, ...groups.map((g) => `group:${g}`), "global"];
    const seen = new Set<string>();
    const out: MemoryEntry[] = [];
    for (const ns of nsList) {
      const hits = await this.retrieve(ns, query, Math.max(3, limit));
      for (const h of hits) {
        if (seen.has(h.id)) continue;
        seen.add(h.id);
        out.push(h);
      }
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  }

  /** 关键词检索（旧接口，namespace 兼容） */
  search(botId: string, query: string, limit = 8): MemoryEntry[] {
    const ns = this.normNs(botId);
    const arr = this.list(ns);
    const q = query.toLowerCase();
    return arr
      .map((e) => {
        const tagScore = (e.tags ?? []).filter((t) => q.includes(t.toLowerCase())).length * 3;
        const contentScore = e.content.toLowerCase().includes(q) ? 2 : 0;
        const recency = e.updatedAt / Date.now();
        return { e, score: tagScore + contentScore + recency * 0.5 };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.e);
  }

  // ---- MEMORY.md（权威总结，常驻） ----

  memoOf(nsOrBotId: string, namespace?: string): string {
    const ns = this.normNs(nsOrBotId, namespace);
    return this.memoNames[ns] ?? "";
  }

  async rewriteMemo(nsOrBotId: string, summarize: (current: string, recent: MemoryEntry[]) => Promise<string> | string, namespace?: string): Promise<string> {
    const ns = this.normNs(nsOrBotId, namespace);
    const recent = (this.mem[ns] ?? []).slice(-30);
    const text = await summarize(this.memoNames[ns] ?? "", recent);
    this.memoNames[ns] = text;
    const d = join(this.dir, nsFile(ns));
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    writeFileSync(this.memoFile(ns), text, "utf8");
    return text;
  }

  setMemo(nsOrBotId: string, text: string, namespace?: string) {
    const ns = this.normNs(nsOrBotId, namespace);
    this.memoNames[ns] = text;
    const d = join(this.dir, nsFile(ns));
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    writeFileSync(this.memoFile(ns), text, "utf8");
  }

  /** 触发条件：新 fact 数 ≥ 5 或距上次 ≥24h 且有变更 */
  shouldRewriteMemo(nsOrBotId: string, namespace?: string): boolean {
    const ns = this.normNs(nsOrBotId, namespace);
    const arr = this.mem[ns] ?? [];
    const facts = arr.filter((e) => e.kind === "fact");
    const lastSummaryAt = arr.filter((e) => e.kind === "summary").sort((a, b) => b.createdAt - a.createdAt)[0]?.createdAt ?? 0;
    const recent = facts.filter((e) => e.createdAt > lastSummaryAt);
    return recent.length >= 5 || (recent.length > 0 && Date.now() - lastSummaryAt > 24 * 3600 * 1000);
  }

  // ---- 构建注入上下文（含 memo + 级联） ----

  buildContext(botId: string, query?: string, groups: string[] = []): string {
    const parts: string[] = [];
    const botNs = `bot:${botId}`;
    // 1) MEMORY.md 权威总结常驻
    const memo = this.memoOf(botId);
    if (memo.trim()) parts.push(`【长期记忆·权威总结】\n${memo.trim().slice(0, 3200)}`);
    // 2) facts / summaries（bot 私有）
    const all = this.list(botNs);
    const facts = all.filter((e) => e.kind === "fact").slice(-6);
    const summaries = all.filter((e) => e.kind === "summary").slice(-3);
    if (facts.length) parts.push("【长期记忆·事实】\n" + facts.map((f) => `- ${f.content}`).join("\n"));
    if (summaries.length) parts.push("【长期记忆·过往摘要】\n" + summaries.map((s) => `- ${s.content}`).join("\n"));
    // 3) 语义级联命中（bot → group → global）
    if (query && query.trim()) {
      const allHits = this.list(botNs).filter((e) => e.kind !== "fact" && e.kind !== "summary");
      void allHits;
      // 用关键词快速兜底 + 级联语义（异步不阻塞：这里用同步关键词先给，完整语义在 retrieveCascade 供工具用）
      const hits = this.search(botId, query, 4);
      if (hits.length) parts.push("【相关记忆】\n" + hits.map((h) => `- ${h.content}`).join("\n"));
    }
    return parts.join("\n\n");
  }

  // ---- 会话摘要（旧接口保留） ----

  async summarizeConversation(botId: string, messages: { role: string; content: string }[], summarize: (msgs: { role: string; content: string }[]) => Promise<string>): Promise<MemoryEntry> {
    const text = await summarize(messages);
    return this.add(botId, { kind: "summary", content: text, source: "auto-summarize" });
  }

  // ---- 维护：合并相似 + 容量淘汰 ----

  /** 合并内容相似（余弦 > 0.9）或完全相同的条目；返回合并数 */
  mergeDuplicate(nsOrBotId: string, namespace?: string): number {
    const ns = this.normNs(nsOrBotId, namespace);
    const arr = this.mem[ns] ?? [];
    const kept: MemoryEntry[] = [];
    let merged = 0;
    for (const e of arr) {
      const dup = kept.find((k) => {
        if (k.content === e.content) return true;
        if (k.vector && e.vector) return cosine(k.vector, e.vector) > 0.9;
        return false;
      });
      if (dup) {
        merged++;
        dup.updatedAt = Math.max(dup.updatedAt, e.updatedAt);
      } else {
        kept.push(e);
      }
    }
    if (merged) {
      this.mem[ns] = kept;
      this.persist(ns);
    }
    return merged;
  }

  /** 容量淘汰：超 budget 时淘汰最久远 + 低分条目；返回淘汰数 */
  evict(nsOrBotId: string, budget: number, namespace?: string): number {
    const ns = this.normNs(nsOrBotId, namespace);
    const arr = this.mem[ns] ?? [];
    if (arr.length <= budget) return 0;
    const sorted = [...arr].sort((a, b) => {
      const aScore = (a.tags?.length ?? 0) + (a.kind === "fact" ? 2 : 0);
      const bScore = (b.tags?.length ?? 0) + (b.kind === "fact" ? 2 : 0);
      return bScore - aScore || b.updatedAt - a.updatedAt;
    });
    const keep = sorted.slice(0, budget);
    const removed = arr.length - keep.length;
    this.mem[ns] = keep;
    this.persist(ns);
    return removed;
  }

  // ---- 元数据 ----

  namespaces(): string[] {
    const set = new Set<string>();
    for (const f of Object.keys(this.mem)) set.add(f);
    return [...set];
  }
}

function dedupe(arr: MemoryEntry[]): MemoryEntry[] {
  const seen = new Map<string, MemoryEntry>();
  for (const e of arr) seen.set(e.id, e);
  return [...seen.values()];
}

// ---- 兼容旧导出 ----

export interface MemoryRetriever {
  retrieve(botId: string, query: string, limit?: number): Promise<MemoryEntry[]>;
}

export class KeywordRetriever implements MemoryRetriever {
  constructor(private mem: MemorySystem) {}
  async retrieve(botId: string, query: string, limit = 8): Promise<MemoryEntry[]> {
    return this.mem.search(botId, query, limit);
  }
}

export function memoryStats(mem: MemoryEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of mem) out[e.kind] = (out[e.kind] ?? 0) + 1;
  return out;
}
