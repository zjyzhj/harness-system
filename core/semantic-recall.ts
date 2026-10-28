import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-fs";

/** 真语义向量：本地模型或在线 API。query / passage 分开编码（e5 这类模型需要前缀） */
export interface VectorEmbedder {
  readonly id: string;
  /** 低于这个相似度视为不相关（不同模型的分数分布差别很大） */
  readonly minScore: number;
  embedMany(texts: string[], kind: "query" | "passage"): Promise<number[][]>;
}

/** 可检索的一条内容：一条记忆，或历史对话里的一段话 */
export interface RecallItem {
  key: string;
  kind: "memory" | "message";
  text: string;
  at: number;
  botId?: string;
  sessionId?: string;
  namespace?: string;
  role?: string;
}
export interface RecallHit extends RecallItem { score: number }

export interface RecallStatus { embedder: string; indexed: number; total: number; ready: boolean; error?: string }

const hashOf = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);
const toB64 = (v: number[]) => Buffer.from(new Float32Array(v).buffer).toString("base64");
const fromB64 = (s: string) => { const b = Buffer.from(s, "base64"); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };

function dot(a: Float32Array | number[], b: Float32Array | number[]): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/**
 * 语义索引：记忆 + 历史对话的向量缓存在 <dir>/vectors-<embedder>.json，
 * 内容变了（hash 不同）才重算；换模型就换一个文件，不会混用不同向量空间。
 */
export class SemanticIndex {
  private vecs = new Map<string, { h: string; v: Float32Array }>();
  private file: string;
  private syncing: Promise<void> | null = null;
  private lastError: string | undefined;
  private total = 0;
  private items: RecallItem[] = [];

  constructor(dir: string, readonly embedder: VectorEmbedder, private source: () => RecallItem[], private batch = 16) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.file = join(dir, `vectors-${embedder.id.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, [string, string]>;
      for (const [k, [h, v]] of Object.entries(raw)) this.vecs.set(k, { h, v: fromB64(v) });
    } catch { /* 没有缓存 */ }
  }

  status(): RecallStatus {
    return { embedder: this.embedder.id, indexed: this.vecs.size, total: this.total, ready: !this.lastError && this.vecs.size > 0, error: this.lastError };
  }

  /** 增量建索引：只算新增 / 改过的内容，删掉已经不存在的；并发调用合并成一次 */
  sync(): Promise<void> {
    this.syncing ??= this.doSync().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  private async doSync() {
    const items = this.source();
    this.items = items;
    this.total = items.length;
    const live = new Set(items.map((i) => i.key));
    let changed = false;
    for (const k of [...this.vecs.keys()]) if (!live.has(k)) { this.vecs.delete(k); changed = true; }
    const todo = items.filter((i) => this.vecs.get(i.key)?.h !== hashOf(i.text));
    try {
      for (let i = 0; i < todo.length; i += this.batch) {
        const part = todo.slice(i, i + this.batch);
        const out = await this.embedder.embedMany(part.map((x) => x.text), "passage");
        part.forEach((x, j) => out[j]?.length && this.vecs.set(x.key, { h: hashOf(x.text), v: new Float32Array(out[j]) }));
        changed = true;
        if ((i / this.batch) % 8 === 7) this.save();
      }
      this.lastError = undefined;
    } catch (e) {
      this.lastError = (e as Error).message;
    }
    if (changed) this.save();
  }

  private save() {
    const out: Record<string, [string, string]> = {};
    for (const [k, { h, v }] of this.vecs) out[k] = [h, toB64(Array.from(v))];
    writeFileAtomic(this.file, JSON.stringify(out));
  }

  /** 按语义找最相关的 k 条（在上次同步时已建好向量的内容里找，不等全量同步） */
  async search(query: string, filter: (i: RecallItem) => boolean = () => true, k = 6): Promise<RecallHit[]> {
    if (!query.trim() || !this.vecs.size) return [];
    const [qv] = await this.embedder.embedMany([query.slice(0, 2000)], "query");
    if (!qv?.length) return [];
    const hits: RecallHit[] = [];
    for (const item of this.items) {
      const rec = this.vecs.get(item.key);
      if (!rec || rec.h !== hashOf(item.text) || !filter(item)) continue;
      const score = dot(rec.v, qv);
      if (score >= this.embedder.minScore) hits.push({ ...item, score });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, k);
  }
}

/** 把检索结果写成注入上下文的一节 */
export function recallSection(hits: RecallHit[], nameOf: (id: string) => string): string {
  if (!hits.length) return "";
  const day = (t: number) => new Date(t).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  const lines = hits.map((h) => h.kind === "memory"
    ? `- [记忆] ${h.text}`
    : `- [${day(h.at)} 对话 · ${h.role === "user" ? "用户" : nameOf(h.botId ?? "")}] ${h.text.slice(0, 300)}`);
  return `【语义回想（和这次问题相关的记忆与过往对话，可能过时，以用户最新说法为准）】\n${lines.join("\n")}`;
}
