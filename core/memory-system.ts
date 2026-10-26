import { randomUUID } from "node:crypto";
import type { MemoryEntry } from "./types";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

/**
 * 持久记忆系统 — 对标 CowAgent agent/memory/
 * 每 bot 一个记忆空间，落盘为 memory/<botId>.json。
 * 分层：
 *   - fact    事实（用户偏好、关键信息）—— 最优先注入
 *   - summary 会话摘要 —— 每次对话后更新，注入
 *   - note    主动笔记 —— bot/用户可写
 *   - event   事件记录（任务完成等）—— 供回顾
 * MVP 用关键词 + 最近优先检索（无向量库依赖；预留 embedding 接口可升级）。
 */
export class MemorySystem {
  private mem: Record<string, MemoryEntry[]> = {};
  private dir: string;

  constructor(private home: string) {
    this.dir = join(home, "memory");
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    this.loadAll();
  }

  private fileFor(botId: string) {
    return join(this.dir, `${botId}.json`);
  }

  private loadAll() {
    for (const f of readdirSync(this.dir).filter((f) => f.endsWith(".json"))) {
      const botId = basename(f, ".json");
      try {
        this.mem[botId] = JSON.parse(readFileSync(join(this.dir, f), "utf8"));
      } catch {
        this.mem[botId] = [];
      }
    }
  }

  private persist(botId: string) {
    writeFileSync(this.fileFor(botId), JSON.stringify(this.mem[botId] ?? [], null, 2), "utf8");
  }

  list(botId: string): MemoryEntry[] {
    return this.mem[botId] ?? [];
  }

  add(botId: string, entry: Omit<MemoryEntry, "id" | "botId" | "createdAt" | "updatedAt"> & { id?: string }): MemoryEntry {
    const arr = this.mem[botId] || (this.mem[botId] = []);
    const now = Date.now();
    const e: MemoryEntry = {
      id: entry.id ?? randomUUID(),
      botId,
      kind: entry.kind,
      content: entry.content,
      tags: entry.tags,
      source: entry.source,
      createdAt: now,
      updatedAt: now,
    };
    arr.push(e);
    // 同 key 覆盖（按 id 去重）
    this.mem[botId] = dedupe(arr);
    this.persist(botId);
    return e;
  }

  update(botId: string, id: string, content: string): MemoryEntry | null {
    const arr = this.mem[botId];
    const e = arr?.find((x) => x.id === id);
    if (!e) return null;
    e.content = content;
    e.updatedAt = Date.now();
    this.persist(botId);
    return e;
  }

  delete(botId: string, id: string) {
    this.mem[botId] = (this.mem[botId] ?? []).filter((x) => x.id !== id);
    this.persist(botId);
  }

  /** 关键词检索（简单打分：命中 tag + 内容 + 最近优先） */
  search(botId: string, query: string, limit = 8): MemoryEntry[] {
    const q = query.toLowerCase();
    const arr = this.list(botId);
    return arr
      .map((e) => {
        const tagScore = (e.tags ?? []).filter((t) => q.includes(t.toLowerCase())).length * 3;
        const contentScore = e.content.toLowerCase().includes(q) ? 2 : 0;
        const recency = e.updatedAt / Date.now(); // 0..1
        return { e, score: tagScore + contentScore + recency * 0.5 };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.e);
  }

  /** 构建注入上下文的记忆块（fact 优先、summary 次之、检索命中） */
  buildContext(botId: string, query?: string): string {
    const all = this.list(botId);
    const facts = all.filter((e) => e.kind === "fact").slice(-6);
    const summaries = all.filter((e) => e.kind === "summary").slice(-3);
    const hits = query ? this.search(botId, query, 5) : [];
    const hitIds = new Set(hits.map((h) => h.id));
    const parts: string[] = [];
    if (facts.length) {
      parts.push("【长期记忆·事实】\n" + facts.map((f) => `- ${f.content}`).join("\n"));
    }
    if (summaries.length) {
      parts.push("【长期记忆·过往摘要】\n" + summaries.map((s) => `- ${s.content}`).join("\n"));
    }
    const extra = hits.filter((h) => h.kind !== "fact" && h.kind !== "summary" && !hitIds.has(h.id));
    if (extra.length) {
      parts.push("【相关记忆】\n" + extra.map((h) => `- ${h.content}`).join("\n"));
    }
    return parts.join("\n\n");
  }

  /** 会话摘要：把一段对话压成一条 summary 记忆（由 BotRuntime 注入 LLM 生成） */
  async summarizeConversation(botId: string, messages: { role: string; content: string }[], summarize: (msgs: { role: string; content: string }[]) => Promise<string>): Promise<MemoryEntry> {
    const text = await summarize(messages);
    return this.add(botId, { kind: "summary", content: text, source: "auto-summarize" });
  }
}

function dedupe(arr: MemoryEntry[]): MemoryEntry[] {
  const seen = new Map<string, MemoryEntry>();
  for (const e of arr) seen.set(e.id, e);
  return [...seen.values()];
}
