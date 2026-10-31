import { randomUUID } from "node:crypto";
import type { MemoryEntry } from "./types";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { readJsonSafe, writeFileAtomic, writeJsonAtomic } from "./atomic-fs";
import { join, basename } from "node:path";
import { HashVectorEmbedder, cosine, keywordScore, type Embedder } from "./embedders";

/**
 * G2 持久记忆系统（对齐 CowAgent / Grok Build memory 模型）
 * - namespace：bot:<id> | group:<name> | global（级联检索 bot → group → global）
 * - 检索：哈希向量 + 关键词 BM25-lite 双通道（可注入 OpenAI 嵌入升级）
 * - MEMORY.md：每 namespace 权威总结，后台增量重写；仅在问记忆/内容相关时注入（避免每轮臃肿）
 * - 维护：mergeDuplicate + evict
 * 旧路径 memory/<botId>.json 自动兼容映射到 bot:<botId>。
 */
const nsFile = (ns: string) => ns.replace(/[^a-zA-Z0-9:_-]/g, "_");
const MEMO_REWRITE_SOURCE = "memo-rewrite";
const MEMO_REWRITE_DEBOUNCE_MS = 2_000;

/** 宿主注入：用 LLM 把当前 MEMORY.md + 最近 durable 记忆压成权威总结 */
export type MemoRewriter = (ns: string, current: string, recent: MemoryEntry[]) => Promise<string> | string;

/** 两段文字共有的相邻两字（去空白、标点）个数 */
function bigramHits(text: string, query: string): number {
  const clean = (s: string) => Array.from(s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ""));
  const t = clean(text).join("");
  const q = clean(query);
  const seen = new Set<string>();
  for (let i = 0; i < q.length - 1; i++) {
    const g = q[i] + q[i + 1];
    if (t.includes(g)) seen.add(g);
  }
  return seen.size;
}

export class MemorySystem {
  private mem: Record<string, MemoryEntry[]> = {};
  private memoNames: Record<string, string> = {};
  private dir: string;
  private embedder: Embedder = new HashVectorEmbedder();
  private memoRewriter: MemoRewriter | null = null;
  private rewriteTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private rewriteInFlight = new Set<string>();

  constructor(private home: string) {
    this.dir = join(home, "memory");
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    this.loadAll();
    this.migrateLegacy();
  }

  /** 挂上后：新增 fact/rule 满足条件时后台重写 MEMORY.md（不挡对话） */
  setMemoRewriter(fn: MemoRewriter | null) {
    this.memoRewriter = fn;
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
      const arr = readJsonSafe<MemoryEntry[] | null>(join(this.dir, f), null);
      if (!Array.isArray(arr)) continue;
      const ns = key.startsWith("bot:") || key.startsWith("group:") || key === "global" ? key : `bot:${key}`;
      this.mem[ns] = arr;
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
          writeJsonAtomic(dest, arr);
          rmSync(legacyPath, { force: true });
          changed = true;
        } catch { /* ignore */ }
      }
    }
    if (changed) { /* mem already updated */ }
  }

  private persist(ns: string) {
    writeJsonAtomic(this.fileFor(ns), this.mem[ns] ?? []);
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
    const key = normText(entry.content);
    const same = arr.findIndex((x) => x.kind === entry.kind && normText(x.content) === key);
    if (same >= 0) {
      // 同一句话再说一遍：不新增，只把它挪到最新（冲突时以新的为准）
      const [old] = arr.splice(same, 1);
      old.updatedAt = now;
      arr.push(old);
      this.persist(ns);
      if (isDurableKind(old.kind)) this.scheduleMemoRewrite(ns);
      return old;
    }
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
    if (isDurableKind(e.kind) && e.source !== MEMO_REWRITE_SOURCE) this.scheduleMemoRewrite(ns);
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
    if (isDurableKind(e.kind)) this.scheduleMemoRewrite(ns);
    return e;
  }

  delete(botId: string, id: string) {
    const ns = this.normNs(botId);
    const hit = (this.mem[ns] ?? []).find((x) => x.id === id);
    this.mem[ns] = (this.mem[ns] ?? []).filter((x) => x.id !== id);
    this.persist(ns);
    if (hit && isDurableKind(hit.kind)) this.scheduleMemoRewrite(ns);
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

  /** 参与权威总结的条目：事实 + 规范（不含 event/note/重写戳） */
  durableEntries(nsOrBotId: string, namespace?: string): MemoryEntry[] {
    const ns = this.normNs(nsOrBotId, namespace);
    return (this.mem[ns] ?? []).filter((e) => isDurableKind(e.kind) && e.source !== MEMO_REWRITE_SOURCE);
  }

  async rewriteMemo(nsOrBotId: string, summarize: (current: string, recent: MemoryEntry[]) => Promise<string> | string, namespace?: string): Promise<string> {
    const ns = this.normNs(nsOrBotId, namespace);
    const recent = this.durableEntries(ns).slice(-40);
    const text = (await summarize(this.memoNames[ns] ?? "", recent)).trim();
    if (!text) return this.memoNames[ns] ?? "";
    this.memoNames[ns] = text;
    writeFileAtomic(this.memoFile(ns), text);
    this.stampMemoRewrite(ns, text);
    return text;
  }

  setMemo(nsOrBotId: string, text: string, namespace?: string) {
    const ns = this.normNs(nsOrBotId, namespace);
    this.memoNames[ns] = text;
    writeFileAtomic(this.memoFile(ns), text);
    // 人手改也算一次「已对齐」，避免立刻又被自动重写冲掉
    if (text.trim()) this.stampMemoRewrite(ns, text);
  }

  /**
   * 触发条件（对齐 G2 / Grok Build「攒够再蒸馏」）：
   * - MEMORY.md 仍空且 durable ≥ 3；或
   * - 自上次重写起新增/更新的 durable ≥ 5；或
   * - 有变更且距上次 ≥ 24h
   */
  shouldRewriteMemo(nsOrBotId: string, namespace?: string): boolean {
    const ns = this.normNs(nsOrBotId, namespace);
    const durable = this.durableEntries(ns);
    if (!durable.length) return false;
    const lastAt = this.lastMemoRewriteAt(ns);
    // 从未蒸馏过：攒够 3 条再写，避免一条事实就打 API
    if (lastAt === 0) return durable.length >= 3;
    const recent = durable.filter((e) => Math.max(e.createdAt, e.updatedAt) > lastAt);
    if (recent.length >= 5) return true;
    if (recent.length > 0 && Date.now() - lastAt > 24 * 3600 * 1000) return true;
    return false;
  }

  /** 条件满足时用已挂的 rewriter 后台重写；无 rewriter / 不该写则跳过 */
  scheduleMemoRewrite(nsOrBotId: string, namespace?: string) {
    if (!this.memoRewriter) return;
    const ns = this.normNs(nsOrBotId, namespace);
    const prev = this.rewriteTimers.get(ns);
    if (prev) clearTimeout(prev);
    this.rewriteTimers.set(ns, setTimeout(() => {
      this.rewriteTimers.delete(ns);
      void this.runScheduledRewrite(ns);
    }, MEMO_REWRITE_DEBOUNCE_MS));
  }

  /** 测试 / 手动：立刻按 should 跑一次（仍要有 rewriter） */
  async maybeRewriteMemoNow(nsOrBotId: string, namespace?: string): Promise<string | null> {
    const ns = this.normNs(nsOrBotId, namespace);
    if (!this.memoRewriter || !this.shouldRewriteMemo(ns)) return null;
    return this.runScheduledRewrite(ns);
  }

  private async runScheduledRewrite(ns: string): Promise<string | null> {
    if (!this.memoRewriter || this.rewriteInFlight.has(ns) || !this.shouldRewriteMemo(ns)) return null;
    this.rewriteInFlight.add(ns);
    try {
      const rewriter = this.memoRewriter;
      return await this.rewriteMemo(ns, (cur, recent) => rewriter(ns, cur, recent));
    } catch {
      return null;
    } finally {
      this.rewriteInFlight.delete(ns);
    }
  }

  private lastMemoRewriteAt(ns: string): number {
    const stamps = (this.mem[ns] ?? []).filter((e) => e.kind === "summary" && e.source === MEMO_REWRITE_SOURCE);
    if (stamps.length) return Math.max(...stamps.map((e) => e.updatedAt || e.createdAt));
    // 兼容旧测试：任意 summary 也算「已蒸馏过」
    const any = (this.mem[ns] ?? []).filter((e) => e.kind === "summary");
    return any.length ? Math.max(...any.map((e) => e.updatedAt || e.createdAt)) : 0;
  }

  /** 重写成功后打戳，重置 shouldRewrite 计数；不触发再次调度 */
  private stampMemoRewrite(ns: string, memoText: string) {
    const arr = this.mem[ns] || (this.mem[ns] = []);
    const kept = arr.filter((e) => !(e.kind === "summary" && e.source === MEMO_REWRITE_SOURCE));
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const preview = memoText.replace(/\s+/g, " ").trim().slice(0, 80);
    kept.push({
      id: randomUUID(),
      botId: ns.startsWith("bot:") ? ns.slice(4) : ns,
      kind: "summary",
      content: `MEMORY.md 已更新（${day}）${preview ? `：${preview}` : ""}`,
      source: MEMO_REWRITE_SOURCE,
      namespace: ns,
      createdAt: now,
      updatedAt: now,
    });
    this.mem[ns] = kept;
    this.persist(ns);
  }

  // ---- 构建注入上下文（按需，对齐 Grok Bot：相关才带，不每轮塞满） ----

  buildContext(botId: string, query?: string, groups: string[] = [], opts?: { rules?: boolean }): string {
    const parts: string[] = [];
    const q = (query ?? "").trim();
    const own = this.list(`bot:${botId}`);
    const shared = [...groups.flatMap((g) => this.list(`group:${g}`)), ...this.list("global")];
    const memoryAsk = isMemoryAsk(q);
    // 1) 规范：做事要求仍常驻（条数少、必须遵守）；rules:false 时由 system 的 rulesWhereabouts 负责
    const rules = opts?.rules === false ? [] : [...shared, ...own].filter((e) => e.kind === "rule").sort((a, b) => a.updatedAt - b.updatedAt).slice(-40);
    if (rules.length) parts.push("【必须遵守的规范（用户定下的，长期有效，与人设冲突时以这里为准；按时间从旧到新排列，互相矛盾时以靠后的为准）】\n" + rules.map((r) => `- ${r.content}`).join("\n"));
    // 2) MEMORY.md：只在用户问记忆，或本轮问题与总结正文相关时注入
    const ownMemo = this.memoOf(botId).trim();
    const globalMemo = this.memoOf("global").trim();
    if (ownMemo && shouldInjectMemo(q, ownMemo)) {
      parts.push(`【长期记忆·权威总结】（与本轮相关才附上；与单条事实冲突时以更新的单条为准）\n${ownMemo.slice(0, 1200)}`);
    }
    if (globalMemo && globalMemo !== ownMemo && shouldInjectMemo(q, globalMemo)) {
      parts.push(`【全局权威总结】\n${globalMemo.slice(0, 600)}`);
    }
    // 3) 事实：问记忆时多给一些；平常只给与问题相关的，再加极薄的近期档案（防完全失忆）
    const allFacts = [...shared, ...own].filter((e) => e.kind === "fact");
    let facts: MemoryEntry[];
    if (memoryAsk) {
      facts = allFacts.slice(-12);
    } else if (q) {
      const hit = allFacts
        .map((e) => ({ e, s: bigramHits(e.content, q) }))
        .filter((x) => x.s >= 2)
        .sort((a, b) => b.s - a.s || b.e.updatedAt - a.e.updatedAt)
        .slice(0, 6)
        .map((x) => x.e);
      const thin = allFacts.slice(-3);
      const seen = new Set(hit.map((e) => e.id));
      facts = [...hit, ...thin.filter((e) => !seen.has(e.id))].slice(0, 8);
    } else {
      facts = allFacts.slice(-3);
    }
    if (facts.length) parts.push("【长期记忆·事实】\n" + facts.map((f) => `- ${f.content}`).join("\n"));
    // 4) 摘要 / 笔记 / 事件：只放和本轮相关的
    if (q) {
      const extras = own
        .filter((e) => e.kind === "note" || e.kind === "event" || (e.kind === "summary" && e.source !== MEMO_REWRITE_SOURCE))
        .map((e) => ({ e, s: bigramHits(e.content, q) }))
        .filter((x) => x.s >= 2)
        .sort((a, b) => b.s - a.s)
        .slice(0, 4);
      if (extras.length) parts.push("【相关记忆】\n" + extras.map((h) => `- ${h.e.content}`).join("\n"));
    }
    return parts.join("\n\n");
  }

  // ---- 会话摘要（旧接口保留） ----

  async summarizeConversation(botId: string, messages: { role: string; content: string }[], summarize: (msgs: { role: string; content: string }[]) => Promise<string>): Promise<MemoryEntry> {
    const text = await summarize(messages);
    return this.add(botId, { kind: "summary", content: text, source: "auto-summarize" });
  }

  // ---- 维护：合并相似 + 容量淘汰 ----

  /**
   * 只合并同类、文字完全相同（忽略空白标点）的条目，保留较新的一条。
   * 不按相似度合并：「回复用中文」和「回复不要用中文」字面很像，意思相反。
   */
  mergeDuplicate(nsOrBotId: string, namespace?: string): number {
    const ns = this.normNs(nsOrBotId, namespace);
    const arr = this.mem[ns] ?? [];
    const latest = new Map<string, MemoryEntry>();
    for (const e of arr) {
      const k = `${e.kind}\u0000${normText(e.content)}`;
      const prev = latest.get(k);
      if (!prev || e.updatedAt >= prev.updatedAt) latest.set(k, e);
    }
    const keepIds = new Set([...latest.values()].map((e) => e.id));
    const kept = arr.filter((e) => keepIds.has(e.id));
    const merged = arr.length - kept.length;
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
    // 用户定的规范不参与淘汰
    const rules = arr.filter((e) => e.kind === "rule");
    const others = arr.filter((e) => e.kind !== "rule").sort((a, b) => {
      const aScore = (a.tags?.length ?? 0) + (a.kind === "fact" ? 2 : 0);
      const bScore = (b.tags?.length ?? 0) + (b.kind === "fact" ? 2 : 0);
      return bScore - aScore || b.updatedAt - a.updatedAt;
    });
    const keepIds = new Set([...rules, ...others.slice(0, Math.max(0, budget - rules.length))].map((e) => e.id));
    const keep = arr.filter((e) => keepIds.has(e.id));
    const removed = arr.length - keep.length;
    if (!removed) return 0;
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

function isDurableKind(kind: string): boolean {
  return kind === "fact" || kind === "rule";
}

/** 用户这轮是否在查/改记忆（才值得带上权威总结全文） */
function isMemoryAsk(query: string): boolean {
  if (!query) return false;
  return /记得|记忆|偏好|关于我|我是谁|叫我|称呼|忘掉|忘了|你知道我|MEMORY|规范有哪些|有哪些规范|习惯|喜欢什么|不喜欢/i.test(query);
}

/** MEMORY.md 按需注入：问记忆，或问题与总结正文有足够重合 */
function shouldInjectMemo(query: string, memo: string): boolean {
  if (!memo.trim()) return false;
  if (isMemoryAsk(query)) return true;
  if (!query.trim()) return false;
  return bigramHits(memo, query) >= 3;
}

function normText(s: string): string {
  return s.replace(/^\s*(用户定下的规范|用户要求|规范)\s*[:：]/, "").replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
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

/** 给宿主 LLM 用的 MEMORY.md 重写提示（手动按钮与自动调度共用） */
export function memoRewriteMessages(current: string, recent: MemoryEntry[]): { system: string; user: string } {
  const cur = current.trim();
  const lines = recent.map((e) => `- [${e.kind}] ${e.content}`).join("\n");
  return {
    system: "你在维护一份 evergreen 权威总结（MEMORY.md）。把旧总结与最近记忆压成 3–10 条中文要点：去重、保留关键事实与偏好与规范；不要写过程话、不要编号列表以外的寒暄；只输出总结正文。",
    user: `${cur ? `【当前总结】\n${cur.slice(0, 2000)}\n\n` : ""}【最近记忆】\n${lines || "（无）"}`,
  };
}
