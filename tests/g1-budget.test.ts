import { describe, test, expect } from "bun:test";
import { trimHistoryToBudget } from "../core/context-budget";
import { estimateTokens } from "../core/store";
import type { ChatMessage } from "../core/types";

function mk(id: number, text: string, role: "user" | "assistant" = "user"): ChatMessage {
  return { id, sessionId: "s", from: role === "assistant" ? "bot" : "user", to: "bot", role, content: text, kind: "chat", createdAt: id };
}

describe("G1 context-budget", () => {
  test("T1.4 预算内不压缩", async () => {
    const hist = [mk(1, "你好"), mk(2, "再见", "assistant")];
    const r = await trimHistoryToBudget(hist, 0, () => "summary", { budgetTokens: 1000 });
    expect(r.compressed).toBe(false);
    expect(r.messages).toHaveLength(2);
  });

  test("T1.4 超预算压缩最旧段 + summary 占位", async () => {
    const LONG = "这是一条用于测试的长消息内容" + "填充".repeat(40); // 约 90 chars → ~23 token
    const hist = Array.from({ length: 60 }, (_, i) => mk(i + 1, LONG));
    const budget = 400;
    expect(estimateTokens(hist[0].content) * 60).toBeGreaterThan(budget);
    const r = await trimHistoryToBudget(hist, 0, (msgs) => `摘要:${msgs.length}条`, { budgetTokens: budget });
    expect(r.compressed).toBe(true);
    expect(r.messages[0].role).toBe("system");
    expect(r.messages[0].content).toContain("历史摘要");
    expect(r.compactedUpToSeq).toBeGreaterThan(0);
  });

  test("T1.5 lastSeq 去重：已压缩段不重复压缩", async () => {
    const LONG = "这是一条用于测试的长消息内容" + "填充".repeat(40);
    const hist = Array.from({ length: 60 }, (_, i) => mk(i + 1, LONG));
    const r1 = await trimHistoryToBudget(hist, 0, () => "sum1", { budgetTokens: 400 });
    expect(r1.compressed).toBe(true);
    const lastSeq = r1.compactedUpToSeq;
    // 再次压缩：lastSeq 去重 → 只压缩「更旧」的下一个段（边界推进），不重复压缩已压缩段
    const r2 = await trimHistoryToBudget(hist, lastSeq, () => "sum2", { budgetTokens: 400 });
    expect(r2.compressed).toBe(true);
    expect(r2.compactedUpToSeq).toBeGreaterThan(lastSeq);
    expect(r2.messages.filter((m) => m.role === "system")).toHaveLength(1);
    // 摘要内容来自新段（不是重复的 sum1）
    expect(r2.messages[0].content).toContain("sum2");
  });

  test("T1.4 无可压缩段时退化为截断近窗", async () => {
    const hist = Array.from({ length: 20 }, (_, i) => mk(i + 1, "aa"));
    const r = await trimHistoryToBudget(hist, 20, () => "x", { budgetTokens: 50 });
    expect(r.compressed).toBe(false);
    expect(r.messages.length).toBeLessThan(20);
  });
});
