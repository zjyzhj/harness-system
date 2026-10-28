import { describe, test, expect } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SemanticIndex, recallSection, type RecallItem, type VectorEmbedder } from "../core/semantic-recall";

/** 假向量：按关键词落到固定维度，模拟「意思相近 → 向量相近」 */
const TOPICS = ["猫", "服务器", "中文"];
class FakeEmbedder implements VectorEmbedder {
  readonly id = "fake";
  readonly minScore = 0.5;
  calls: string[][] = [];
  async embedMany(texts: string[]) {
    this.calls.push(texts);
    return texts.map((t) => {
      const v = TOPICS.map((k) => (t.includes(k) || (k === "猫" && t.includes("团子")) ? 1 : 0));
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  }
}

describe("语义回想索引", () => {
  test("按意思找回记忆和过往对话，换内容才重算，过滤当前会话", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-vec-"));
    let items: RecallItem[] = [
      { key: "mem:1", kind: "memory", text: "用户养了一只橘猫叫团子", at: 1, namespace: "bot:a" },
      { key: "msg:s1:1", kind: "message", text: "测试服务器是 10.0.0.8", at: 2, botId: "a", sessionId: "s1", role: "user" },
      { key: "msg:s2:1", kind: "message", text: "团子今天不吃饭", at: 3, botId: "a", sessionId: "s2", role: "user" },
    ];
    const emb = new FakeEmbedder();
    const idx = new SemanticIndex(dir, emb, () => items);
    await idx.sync();
    expect(idx.status()).toMatchObject({ indexed: 3, total: 3, ready: true });

    const hits = await idx.search("我的猫叫什么", (i) => i.sessionId !== "s2");
    expect(hits.map((h) => h.key)).toEqual(["mem:1"]);

    await idx.sync();
    expect(emb.calls.filter((c) => c.length > 1 || c[0] !== "我的猫叫什么").length).toBe(1);

    items = [items[0], { ...items[1], text: "测试服务器换成 10.0.0.9" }];
    await idx.sync();
    expect(idx.status().indexed).toBe(2);

    const reloaded = new SemanticIndex(dir, emb, () => items);
    await reloaded.sync();
    expect(emb.calls.at(-1)).not.toEqual(["用户养了一只橘猫叫团子", "测试服务器换成 10.0.0.9"]);
    expect(existsSync(join(dir, "vectors-fake.json"))).toBe(true);
  });

  test("向量接口出错时记下错误，不抛给对话", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-vec-"));
    const bad: VectorEmbedder = { id: "bad", minScore: 0.5, embedMany: async () => { throw new Error("下载失败"); } };
    const idx = new SemanticIndex(dir, bad, () => [{ key: "m", kind: "memory", text: "x", at: 1 }]);
    await idx.sync();
    expect(idx.status()).toMatchObject({ ready: false, error: "下载失败" });
  });

  test("注入文字区分记忆和对话", () => {
    const s = recallSection([
      { key: "a", kind: "memory", text: "橘猫叫团子", at: 1, score: 0.9 },
      { key: "b", kind: "message", text: "团子不吃饭", at: Date.UTC(2026, 9, 1), role: "assistant", botId: "x", score: 0.8 },
    ], () => "灵感助手");
    expect(s).toContain("[记忆] 橘猫叫团子");
    expect(s).toContain("灵感助手] 团子不吃饭");
  });
});
