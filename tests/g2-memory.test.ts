import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySystem } from "../core/memory-system";
import { HashVectorEmbedder, cosine } from "../core/embedders";

let home: string;
let mem: MemorySystem;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "harness-g2-"));
  mem = new MemorySystem(home);
});
afterAll(() => {});

describe("G2 embedders", () => {
  test("T2.0 哈希向量：同义改写召回（余弦相似）", () => {
    const emb = new HashVectorEmbedder(384);
    const v1 = emb.embed("我喜欢吃辣的食物");
    const v2 = emb.embed("我的口味偏好是辣");
    const v3 = emb.embed("今天天气很好适合散步");
    expect(cosine(v1, v2)).toBeGreaterThan(cosine(v1, v3));
  });

  test("T2.0 keywordScore 中文敏感", () => {
    const { keywordScore } = require("../core/embedders");
    expect(keywordScore("用户偏好简洁回答", "偏好简洁")).toBeGreaterThan(0);
    expect(keywordScore("用户偏好简洁回答", "天气")).toBe(0);
  });
});

describe("G2 memory namespace + 级联 + memo", () => {
  test("T2.1 namespace：group/global 写入 + 独立检索", async () => {
    mem.add("botA", { kind: "fact", content: "A 喜欢咖啡", tags: ["偏好"] });
    mem.add("botA", { kind: "fact", content: "团队用飞书沟通", tags: [], namespace: "group:dev" });
    mem.add("botA", { kind: "fact", content: "公司 10 点晨会", tags: [], namespace: "global" });
    expect(mem.list("botA").filter((e) => e.kind === "fact").length).toBe(1);
    expect(mem.list("group:dev", undefined).length).toBe(1);
    expect(mem.list("global", undefined).length).toBe(1);
    // 检索不同 ns
    const hits = await mem.retrieve("group:dev", "飞书", 5);
    expect(hits[0].content).toContain("飞书");
  });

  test("T2.2 级联检索：bot → group → global 合并去重", async () => {
    mem.add("botB", { kind: "fact", content: "B 负责后端" });
    mem.add("botB", { kind: "fact", content: "后端语言是 TypeScript", namespace: "group:eng" });
    mem.add("botB", { kind: "fact", content: "公司食堂很好吃", namespace: "global" });
    const all = await mem.retrieveCascade("botB", ["eng"], "TypeScript 后端", 10);
    const texts = all.map((e) => e.content);
    expect(texts.some((t) => t.includes("后端"))).toBe(true);
    expect(texts.some((t) => t.includes("TypeScript"))).toBe(true);
    // 去重：同一 id 只出现一次
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
  });

  test("T2.3 MEMORY.md：重写 + 常驻注入", async () => {
    await mem.rewriteMemo("botC", (_cur, recent) => `权威总结：${recent.length} 条记忆`);
    expect(mem.memoOf("botC")).toContain("权威总结");
    const ctx = mem.buildContext("botC", "任何问题");
    expect(ctx).toContain("权威总结");
  });

  test("T2.3 shouldRewriteMemo：5 条新 fact 触发", () => {
    const m2 = new MemorySystem(mkdtempSync(join(tmpdir(), "harness-g2memo-")));
    for (let i = 0; i < 5; i++) m2.add("botD", { kind: "fact", content: `事实${i}` });
    expect(m2.shouldRewriteMemo("botD")).toBe(true);
    m2.add("botD", { kind: "summary", content: "s" });
    // 有 summary 后新 fact 清零 → false
    expect(m2.shouldRewriteMemo("botD")).toBe(false);
  });

  test("T2.5 mergeDuplicate + evict", () => {
    const m3 = new MemorySystem(mkdtempSync(join(tmpdir(), "harness-g2merge-")));
    for (let i = 0; i < 10; i++) m3.add("botE", { kind: "fact", content: "重复内容", tags: ["x"] });
    expect(m3.list("botE").length).toBe(1);
    // 旧数据里已经存在的重复条目由 mergeDuplicate 清理
    const arr = m3.list("botE");
    for (let i = 0; i < 9; i++) arr.push({ ...arr[0], id: `dup${i}`, updatedAt: arr[0].updatedAt - i - 1 });
    const merged = m3.mergeDuplicate("botE");
    expect(merged).toBe(9);
    expect(m3.list("botE").filter((e) => e.content === "重复内容").length).toBe(1);
    // evict
    const m4 = new MemorySystem(mkdtempSync(join(tmpdir(), "harness-g2evict-")));
    for (let i = 0; i < 50; i++) m4.add("botF", { kind: "note", content: `n${i}` });
    const removed = m4.evict("botF", 20);
    expect(removed).toBe(30);
    expect(m4.list("botF").length).toBe(20);
  });
});

describe("G2 legacy 迁移", () => {
  test("T2.1 旧 memory/<botId>.json → bot:<botId>", () => {
    const oldHome = mkdtempSync(join(tmpdir(), "harness-g2legacy-"));
    const dir = join(oldHome, "memory");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "botLegacy.json"), JSON.stringify([
      { id: "1", botId: "botLegacy", kind: "fact", content: "旧事实", createdAt: 1, updatedAt: 1 },
    ]), "utf8");
    const m = new MemorySystem(oldHome);
    expect(m.list("botLegacy").length).toBe(1);
    expect(m.list("botLegacy")[0].namespace).toBe("bot:botLegacy");
    // 旧文件已迁移
    expect(existsSync(join(dir, "botLegacy.json"))).toBe(false);
    expect(existsSync(join(dir, "bot_botLegacy.json")) || existsSync(join(dir, "bot:botLegacy.json"))).toBe(true);
  });
});
