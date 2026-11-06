import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompanionEngine } from "../core/companion";
import type { Bot } from "../core/types";

describe("轻量陪伴", () => {
  test("空闲时会搭话，同一天有上限", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-companion-"));
    const bot: Bot = { id: "a", name: "小助", role: "陪伴", persona: "", providerId: "", petEnabled: true, createdAt: 1 };
    const delivered: string[] = [];
    let now = Date.parse("2026-10-29T14:00:00Z");
    const eng = new CompanionEngine(home, {
      bots: () => [bot],
      memory: () => [{ id: "1", botId: "a", kind: "fact", content: "喜欢喝美式", createdAt: 1, updatedAt: 1 }],
      lastUserActivity: () => now - 60 * 60_000,
      isBusy: () => false,
      deliver: (_id, line) => delivered.push(line.text),
      now: () => now,
    }, { idleMs: 10 * 60_000, gapMs: 1, maxPerDay: 2, hours: [0, 24] });

    expect(await eng.tick()).toBe("a");
    expect(delivered.length).toBe(1);
    now += 10;
    expect(await eng.tick()).toBe("a");
    now += 10;
    expect(await eng.tick()).toBe(null); // 日上限 2
  });

  test("用户刚活跃时不打扰", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-companion2-"));
    const bot: Bot = { id: "a", name: "小助", role: "陪伴", persona: "", providerId: "", petEnabled: true, createdAt: 1 };
    const now = Date.now();
    const eng = new CompanionEngine(home, {
      bots: () => [bot],
      memory: () => [],
      lastUserActivity: () => now,
      isBusy: () => false,
      deliver: () => {},
      now: () => now,
    }, { idleMs: 45 * 60_000, hours: [0, 24] });
    expect(await eng.tick()).toBe(null);
  });

  test("companionChat 关闭时不搭话", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-companion3-"));
    const bot: Bot = { id: "a", name: "小助", role: "陪伴", persona: "", providerId: "", petEnabled: true, createdAt: 1 };
    let now = Date.parse("2026-10-29T14:00:00Z");
    const eng = new CompanionEngine(home, {
      bots: () => [bot],
      memory: () => [],
      lastUserActivity: () => now - 60 * 60_000,
      isBusy: () => false,
      deliver: () => { throw new Error("should not deliver"); },
      now: () => now,
      prefs: () => ({
        companionChat: false,
        idleWork: false,
        autoAppearance: false,
        idleMs: 10 * 60_000,
        maxChatPerDay: 4,
        maxWorkPerDay: 2,
        maxAppearPerWeek: 1,
      }),
    }, { hours: [0, 24], gapMs: 1 });
    expect(await eng.tick()).toBe(null);
  });

  test("idleWork 开启时优先做事", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-companion4-"));
    const bot: Bot = { id: "a", name: "小助", role: "陪伴", persona: "", providerId: "", petEnabled: true, createdAt: 1 };
    const kinds: string[] = [];
    let now = Date.parse("2026-10-29T14:00:00Z");
    const eng = new CompanionEngine(home, {
      bots: () => [bot],
      memory: () => [],
      lastUserActivity: () => now - 60 * 60_000,
      isBusy: () => false,
      deliver: (_id, line) => kinds.push(line.kind || "chat"),
      now: () => now,
      prefs: () => ({
        companionChat: true,
        idleWork: true,
        autoAppearance: false,
        idleMs: 10 * 60_000,
        maxChatPerDay: 4,
        maxWorkPerDay: 2,
        maxAppearPerWeek: 1,
      }),
      work: async () => ({ text: "我扫了一眼待办，今天没什么急的。", title: "空闲小事" }),
    }, { hours: [0, 24], gapMs: 1 });
    expect(await eng.tick()).toBe("a");
    expect(kinds).toEqual(["work"]);
  });
});
