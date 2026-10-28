import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, estimateTokens } from "../core/store";
import { contentText } from "../core/types";

let home: string;
let store: Store;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "harness-g1-"));
  store = new Store(home);
});
afterAll(() => store.close());

function msg(sid: string, from: string, to: string, text: string, at?: number, role: "user" | "assistant" = "user") {
  store.addMessage({ sessionId: sid, from, to, role, content: text, kind: "chat", createdAt: at ?? Date.now() });
}

describe("G1 store: jsonl 分片 + 分页 + 搜索 + 归档 + 迁移", () => {
  test("T1.0 分片：append 后 jsonl 文件存在且可重启恢复", async () => {
    msg("s-p1", "user", "botA", "第一条消息", 1000);
    msg("s-p1", "botA", "user", "你好", 1001, "assistant");
    const file = join(home, "sessions", "s-p1.jsonl");
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    // 重启恢复
    store.close();
    const store2 = new Store(home);
    const msgs = store2.listMessages("s-p1");
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe("第一条消息");
    const s = store2.listSessionsPage({ limit: 10 }).sessions.find((x) => x.id === "s-p1");
    expect(s?.messageCount).toBe(2);
    // 恢复 nextMsgId 正确（新增消息 id 递增）
    store2.addMessage({ sessionId: "s-p1", from: "user", to: "botA", role: "user", content: "第三条", kind: "chat", createdAt: 1002 });
    const after = store2.listMessages("s-p1");
    expect(after).toHaveLength(3);
    expect((after[2] as any).id).toBeGreaterThan((after[1] as any).id);
    store = store2;
  });

  test("T1.1 分页：会话分页 + 消息 older 分页 hasMore", () => {
    for (let i = 0; i < 30; i++) msg("s-page", "user", "botB", `消息${i}`, 2000 + i);
    const { sessions, total } = store.listSessionsPage({ offset: 0, limit: 5 });
    expect(total).toBeGreaterThanOrEqual(2);   // 会话数（s-p1 + s-page）
    expect(sessions.length).toBeGreaterThan(0);
    const page2 = store.listSessionsPage({ offset: 1, limit: 5 });
    expect(page2.sessions.length).toBeGreaterThan(0);
    expect(page2.sessions[0].id).not.toBe(sessions[0].id);

    // 消息分页：无 beforeId → 最新窗口；带 beforeId → 更旧窗口（不含边界）
    const w1 = store.listMessagesPage("s-page", { limit: 5 });
    expect(w1.msgs).toHaveLength(5);
    expect(w1.hasMore).toBe(true); // 还有更旧
    const collected: number[] = [...w1.msgs.map((m: any) => m.id)];
    const newestId = (w1.msgs[w1.msgs.length - 1] as any).id as number;
    let cursor = (w1.msgs[0] as any).id;
    let guard = 0;
    while (guard++ < 10) {
      const w2 = store.listMessagesPage("s-page", { limit: 10, beforeId: cursor });
      if (!w2.msgs.length) break;
      collected.unshift(...w2.msgs.map((m: any) => m.id));
      cursor = (w2.msgs[0] as any).id;
    }
    expect(collected.length).toBe(30);
    expect(new Set(collected).size).toBe(30);
    expect(Math.max(...collected)).toBe(newestId);
  });

  test("T1.2 搜索：关键词命中会话标题与消息，空词返回空", () => {
    const byMsg = store.searchMessages({ q: "消息2" });
    expect(byMsg.length).toBeGreaterThan(0);
    expect(byMsg[0].snippet).toContain("消息2");
    expect(byMsg[0].sessionId).toBe("s-page");
    const empty = store.searchMessages({ q: "" });
    expect(empty).toHaveLength(0);
    const filtered = store.searchMessages({ q: "消息", botId: "botB" });
    expect(filtered.length).toBeGreaterThan(0);
  });

  test("T1.3 归档：不进列表、可恢复、可删除", () => {
    msg("s-arch", "user", "botC", "归档我", 3000);
    store.archiveSession("s-arch", true);
    expect(store.listSessionsPage({}).sessions.some((s) => s.id === "s-arch")).toBe(false);
    expect(store.listSessionsPage({ archived: true }).sessions.some((s) => s.id === "s-arch")).toBe(true);
    // 恢复
    store.archiveSession("s-arch", false);
    expect(store.listSessionsPage({}).sessions.some((s) => s.id === "s-arch")).toBe(true);
    // 删除（含文件）
    store.deleteSession("s-arch");
    expect(existsSync(join(home, "sessions", "s-arch.jsonl"))).toBe(false);
    expect(store.listMessages("s-arch")).toHaveLength(0);
  });

  test("estimateTokens：text/code/image 估测合理", () => {
    expect(estimateTokens("你好你好你好你好")).toBe(8); // 中文约一字一 token
    expect(estimateTokens("hello 你好")).toBe(4);
    expect(estimateTokens([{ type: "text", text: "12345678" }])).toBe(2);
    expect(estimateTokens([{ type: "image", dataUrl: "data:..." }])).toBe(85);
    expect(estimateTokens([{ type: "tool_call", tool: "x", args: {} }])).toBe(60);
  });
});

describe("G1 store: 旧格式迁移", () => {
  test("T1.6 messages.json → jsonl：数据一致 + migrated 标记", () => {
    const oldHome = join(home, "legacy");
    mkdirSync(oldHome, { recursive: true });
    // 构造旧格式 5 条
    const legacy: Record<string, any[]> = {
      "s-old": [
        { id: 1, sessionId: "s-old", from: "user", to: "botX", role: "user", content: "老1", kind: "chat", createdAt: 100 },
        { id: 2, sessionId: "s-old", from: "botX", to: "user", role: "assistant", content: "老2", kind: "chat", createdAt: 101 },
      ],
      "s-old2": [
        { id: 3, sessionId: "s-old2", from: "user", to: "botY", role: "user", content: "别组", kind: "chat", createdAt: 200 },
      ],
    };
    writeFileSync(join(oldHome, "messages.json"), JSON.stringify(legacy), "utf8");
    writeFileSync(join(oldHome, "sessions.json"), JSON.stringify({}), "utf8");

    const s2 = new Store(oldHome);
    const m1 = s2.listMessages("s-old");
    expect(m1).toHaveLength(2);
    expect(contentText(m1[0].content)).toBe("老1");
    expect(s2.listMessages("s-old2")).toHaveLength(1);
    // jsonl 文件存在
    expect(existsSync(join(oldHome, "sessions", "s-old.jsonl"))).toBe(true);
    // 原文件保留 + migrated 标记
    const legacyFile = JSON.parse(readFileSync(join(oldHome, "messages.json"), "utf8"));
    expect(legacyFile.migrated).toBe(true);
    // 迁移后追加正常
    s2.addMessage({ sessionId: "s-old", from: "user", to: "botX", role: "user", content: "新消息", kind: "chat", createdAt: 300 });
    expect(s2.listMessages("s-old")).toHaveLength(3);
    s2.close();
  });
});

describe("G1 store: 性能（10k 消息）", () => {
  test("T1.7 10k 消息追加 + 打开 < 1s", () => {
    const perfHome = mkdtempSync(join(tmpdir(), "harness-g1-perf-"));
    const s0 = new Store(perfHome);
    const t0 = performance.now();
    for (let i = 0; i < 10000; i++) {
      s0.addMessage({ sessionId: "s-big", from: "user", to: "botZ", role: "user", content: `消息内容 ${i} 填充填充填充`, kind: "chat", createdAt: 1000 + i });
    }
    const appendMs = performance.now() - t0;
    expect(s0.listMessages("s-big")).toHaveLength(10000);
    s0.close();

    // 重启打开（只读 jsonl + 索引）
    const t1 = performance.now();
    const s1 = new Store(perfHome);
    const msgs = s1.listMessages("s-big");
    const openMs = performance.now() - t1;
    expect(msgs.length).toBeGreaterThanOrEqual(10000);
    expect(openMs).toBeLessThan(1000);
    // 搜索 < 500ms
    const t2 = performance.now();
    const hits = s1.searchMessages({ q: "9999" });
    expect(hits.length).toBeGreaterThan(0);
    const searchMs = performance.now() - t2;
    expect(searchMs).toBeLessThan(500);
    s1.close();
    // 打印性能（可见性）
    console.log(`  [perf] append10k=${appendMs.toFixed(0)}ms open=${openMs.toFixed(0)}ms search=${searchMs.toFixed(0)}ms`);
  });
});
