/**
 * G2 记忆嵌入向量：
 * - HashVectorEmbedder：本地 char-bigram 哈希 → 384 维稀疏向量 + 余弦（零依赖默认）
 * - OpenAIEmbedder：可选真向量（baseUrl/key/model），缺失时上层降级到 Hash
 */

export interface Embedder {
  readonly dim: number;
  embed(text: string): Promise<number[]> | number[];
}

/** 中文友好：按字符切分取 bigram（含单字），哈希到 dim 维 */
export class HashVectorEmbedder implements Embedder {
  readonly dim: number;
  constructor(dim = 384) { this.dim = dim; }

  embed(text: string): number[] {
    const v = new Float64Array(this.dim);
    const norm = text.toLowerCase().trim();
    if (!norm) return Array.from(v);
    const grams = this.grams(norm);
    for (const g of grams) {
      let h = 0;
      for (let i = 0; i < g.length; i++) h = (h * 31 + g.charCodeAt(i)) >>> 0;
      const idx = h % this.dim;
      v[idx] += 1;
    }
    return this.normalize(Array.from(v));
  }

  private grams(s: string): string[] {
    const chars = Array.from(s);
    const out: string[] = chars.map((c) => c); // unigram
    for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]); // bigram
    return out;
  }

  private normalize(v: number[]): number[] {
    let sum = 0;
    for (const x of v) sum += x * x;
    const n = Math.sqrt(sum) || 1;
    return v.map((x) => x / n);
  }
}

/** OpenAI 兼容 embeddings adapter（/embeddings 端点） */
export class OpenAIEmbedder implements Embedder {
  readonly dim: number;
  constructor(
    private opts: { baseUrl: string; apiKey?: string; model?: string },
    dim = 1536,
  ) { this.dim = dim; }

  async embed(text: string): Promise<number[]> {
    const url = this.opts.baseUrl.replace(/\/+$/, "") + "/embeddings";
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.opts.model ?? "text-embedding-3-small", input: text.slice(0, 8000) }),
    });
    if (!res.ok) throw new Error(`embeddings API ${res.status}`);
    const data = (await res.json()) as any;
    const vec = data?.data?.[0]?.embedding;
    if (!Array.isArray(vec)) throw new Error("embeddings 返回无向量");
    return this.normalize(vec.map(Number));
  }

  private normalize(v: number[]): number[] {
    let sum = 0;
    for (const x of v) sum += x * x;
    const n = Math.sqrt(sum) || 1;
    return v.map((x) => x / n);
  }
}

/** 余弦相似度（归一化向量点积） */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

/** 简单 BM25-lite 词频加权（与向量双通道，中文友好） */
export function keywordScore(text: string, query: string): number {
  const t = text.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  let score = 0;
  for (const ch of Array.from(q)) {
    if (ch.trim() && t.includes(ch)) score += 1;
  }
  const grams = new Set(Array.from(q));
  for (let i = 0; i < q.length - 1; i++) {
    const g = q.slice(i, i + 2);
    if (t.includes(g)) score += 2;
  }
  void grams;
  return score;
}
