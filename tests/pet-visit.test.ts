import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PetVisitEngine, parseVisitLines } from "../core/pet-visit";
import { PetEvolveEngine, parseEvolveInvent } from "../core/pet-evolve";
import { normalizePetPrefs } from "../core/pet-prefs";
import type { Bot, ChatMessage } from "../core/types";

const a: Bot = { id: "a", name: "阿A", role: "x", persona: "", providerId: "", petEnabled: true, createdAt: 1 };
const b: Bot = { id: "b", name: "阿B", role: "x", persona: "", providerId: "", petEnabled: true, createdAt: 1 };

function msg(text: string, at: number): ChatMessage {
  return {
    id: at, sessionId: "s-1", from: "user", to: "a", role: "user",
    content: [{ type: "text", text }], kind: "chat", createdAt: at,
  };
}

describe("多宠互访", () => {
  test("visit 记录双方文案，冷却内不重复", () => {
    const home = mkdtempSync(join(tmpdir(), "harness-visit-"));
    let now = 1_000_000;
    const eng = new PetVisitEngine(home, { bots: () => [a, b], now: () => now });
    const r1 = eng.visit(a, b);
    expect(r1?.fromName).toBe("阿A");
    expect(r1?.toName).toBe("阿B");
    expect(r1?.lineFrom).toContain("阿B");
    expect(eng.visit(a, b)).toBe(null); // 冷却
    expect(eng.visit(a, b, { force: true })?.id).toBeTruthy();
    expect(eng.list("a").length).toBeGreaterThanOrEqual(2);
  });

  test("tick 在至少两只上台时能串门", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-visit2-"));
    const eng = new PetVisitEngine(home, { bots: () => [a, b], enabled: () => true });
    expect((await eng.tick())?.fromId).toBeTruthy();
  });

  test("prefs 关时 tick 不串门", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-visit3-"));
    const eng = new PetVisitEngine(home, { bots: () => [a, b], enabled: () => false });
    expect(await eng.tick()).toBe(null);
  });

  test("inventLines 优先于模板", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-visit-llm-"));
    const eng = new PetVisitEngine(home, {
      bots: () => [a, b],
      inventLines: async () => ({ from: "特制问候去找你", to: "特制欢迎回来" }),
    });
    const r = await eng.visitSmart(a, b, { force: true });
    expect(r?.lineFrom).toContain("特制问候");
    expect(r?.lineTo).toContain("特制欢迎");
  });
});

describe("进化历史可回看", () => {
  test("listHistory 含已接受记录", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-ehist-"));
    const now = Date.parse("2026-10-29T12:00:00Z");
    const eng = new PetEvolveEngine(home, {
      bots: () => [a],
      memory: () => [],
      recentUserMessages: () => [msg("以后都先给结论", now - 1000)],
      petXp: () => 0,
      now: () => now,
      deliver: () => {},
      apply: () => {},
    });
    const p = await eng.tick();
    expect(p).toBeTruthy();
    eng.accept(p!.id);
    const hist = eng.listHistory("a");
    expect(hist[0]?.status).toBe("accepted");
    expect(hist[0]?.title).toBeTruthy();
  });
});

describe("prefs 互访默认", () => {
  test("petVisit 默认关，需开关打开", () => {
    expect(normalizePetPrefs({}).petVisit).toBe(false);
    expect(normalizePetPrefs({ petVisit: true }).petVisit).toBe(true);
  });
});

describe("模型 JSON 解析", () => {
  test("parseVisitLines / parseEvolveInvent", () => {
    expect(parseVisitLines('{"from":"嗨","to":"来啦"}')).toEqual({ from: "嗨", to: "来啦" });
    const e = parseEvolveInvent('{"kind":"habit","title":"记这条？","detail":"用户说了以后都…"}');
    expect(e?.kind).toBe("habit");
    expect(e?.title).toContain("记");
  });

  test("进化 invent 优先于规则", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-einv-"));
    const now = Date.parse("2026-10-29T12:00:00Z");
    const eng = new PetEvolveEngine(home, {
      bots: () => [a],
      memory: () => [],
      recentUserMessages: () => [msg("随便聊聊天气", now - 1000)],
      petXp: () => 0,
      now: () => now,
      deliver: () => {},
      apply: () => {},
      invent: async () => ({ kind: "play" as const, title: "模型提议？", detail: "来自 invent" }),
    });
    const p = await eng.tick();
    expect(p?.title).toBe("模型提议？");
    expect(p?.detail).toContain("invent");
  });
});

describe("forgetBot", () => {
  test("删除旁路历史", () => {
    const home = mkdtempSync(join(tmpdir(), "harness-visit-forget-"));
    const eng = new PetVisitEngine(home, { bots: () => [a, b] });
    eng.visit(a, b, { force: true });
    expect(eng.list("a").length).toBe(1);
    eng.forgetBot("a");
    expect(eng.list("a").length).toBe(0);
    expect(eng.list("b").length).toBe(0);
  });
});
