import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProactiveEngine, collectSignals, type ProactiveSignal } from "../core/proactive";
import type { ChatMessage, OrchestrationPlan, Session } from "../core/types";

const H = 3600_000;
const NOW = new Date(2026, 9, 28, 15, 0).getTime();
const sess = (id: string, botId = "a"): Session => ({ id, botId, title: id, createdAt: NOW - 10 * H, updatedAt: NOW - 4 * H });
const bot = (sessionId: string, content: ChatMessage["content"], ago: number): ChatMessage =>
  ({ sessionId, from: "a", to: "user", role: "assistant", content, kind: "chat", createdAt: NOW - ago });

describe("主动跟进的信号", () => {
  test("没选的选项、没接的提议、失败的编排和定时任务；已回复 / 太新 / 后台会话不算", () => {
    const msgs: Record<string, ChatMessage[]> = {
      "s-choice": [bot("s-choice", [{ type: "choice", id: "c1", question: "选哪个方向？", options: ["A", "B"] }], 3 * H)],
      "s-offer": [bot("s-offer", "初稿写好了。需要我再出一版英文的吗？", 4 * H)],
      "s-fresh": [bot("s-fresh", "需要我继续吗？", 1 * H)],
      "s-done": [bot("s-done", "需要我继续吗？", 5 * H), { ...bot("s-done", "好的", 4 * H), role: "user", from: "user" }],
      "plan-x-1": [bot("plan-x-1", "需要我继续吗？", 5 * H)],
    };
    const plans = [{ id: "p1", ownerBotId: "user", title: "介绍页", createdAt: NOW - 3 * H, status: "error", finishedAt: NOW - 2 * H, stages: [{ id: "st", botId: "w", prompt: "", mode: "seq", status: "error", error: "超时", retries: 0 }] }] as OrchestrationPlan[];
    const sigs = collectSignals({
      sessions: Object.keys(msgs).map((id) => sess(id)),
      messages: (sid) => msgs[sid] ?? [],
      plans,
      tasks: [{ id: "t1", botId: "a", name: "日报", cron: "0 9 * * *", enabled: true, runCount: 1, createdAt: 0, lastRunAt: NOW - H, lastError: "网络错误" }],
      masterId: "m",
      nameOf: (id) => (id === "w" ? "写作助手" : id),
      now: NOW,
    });
    expect(sigs.map((s) => s.kind).sort()).toEqual(["choice", "offer", "plan", "task"]);
    expect(sigs.find((s) => s.kind === "plan")?.fact).toContain("写作助手");
    expect(sigs.find((s) => s.kind === "plan")?.botId).toBe("m");
  });
});

describe("主动跟进的节奏", () => {
  const sig = (key: string): ProactiveSignal => ({ key, kind: "offer", botId: "a", sessionId: "s-1", fact: "x", at: NOW });

  test("同一件事只提一次；用户正在聊、深夜、间隔太短都不打扰", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-proactive-"));
    let now = NOW;
    let lastUser = NOW - 2 * H;
    const sent: string[] = [];
    const eng = new ProactiveEngine(home, {
      collect: () => [sig("k1"), sig("k2")],
      lastUserActivity: () => lastUser,
      phrase: async (s) => `跟进 ${s.key}`,
      deliver: (_s, text) => sent.push(text),
      now: () => now,
    });
    expect((await eng.tick())?.key).toBe("k1");
    expect(await eng.tick()).toBeNull();
    now += 3 * H;
    lastUser = now - 5 * 60_000;
    expect(await eng.tick()).toBeNull();
    lastUser = now - H;
    expect((await eng.tick())?.key).toBe("k2");
    now = new Date(2026, 9, 29, 23, 30).getTime();
    expect(await eng.tick()).toBeNull();
    expect(sent).toEqual(["跟进 k1", "跟进 k2"]);

    const again = new ProactiveEngine(home, { collect: () => [sig("k1")], lastUserActivity: () => 0, phrase: async () => "x", deliver: () => sent.push("重复"), now: () => NOW + 30 * H });
    expect(await again.tick()).toBeNull();
  });

  test("写不出话（没模型 / 出错）就不发", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-proactive-"));
    const sent: string[] = [];
    const eng = new ProactiveEngine(home, { collect: () => [sig("k1")], lastUserActivity: () => 0, phrase: async () => null, deliver: (_s, t) => sent.push(t), now: () => NOW });
    expect(await eng.tick()).toBeNull();
    expect(sent.length).toBe(0);
  });
});
