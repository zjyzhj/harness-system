import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PetEvolveEngine } from "../core/pet-evolve";
import { normalizePetPrefs } from "../core/pet-prefs";
import type { Bot, ChatMessage } from "../core/types";

const bot: Bot = {
  id: "b1", name: "小助", role: "助手", persona: "", providerId: "", petEnabled: true, createdAt: 1,
};

function msg(text: string, at: number): ChatMessage {
  return {
    id: at, sessionId: "s-1", from: "user", to: "b1", role: "user",
    content: [{ type: "text", text }], kind: "chat", createdAt: at,
  };
}

describe("pet-evolve 自进化", () => {
  test("用户「以后都」会提议 habit，接受后 apply", () => {
    const home = mkdtempSync(join(tmpdir(), "harness-evolve-"));
    const applied: string[] = [];
    const delivered: string[] = [];
    let now = Date.parse("2026-10-29T12:00:00Z");
    const eng = new PetEvolveEngine(home, {
      bots: () => [bot],
      memory: () => [],
      recentUserMessages: () => [msg("以后都先给结论，少废话", now - 1000)],
      petXp: () => 0,
      now: () => now,
      deliver: (_id, p) => delivered.push(p.kind),
      apply: (_id, p) => applied.push(p.kind),
    });
    const p = eng.tick();
    expect(p?.kind).toBe("habit");
    expect(delivered).toEqual(["habit"]);
    expect(eng.accept(p!.id)?.status).toBe("accepted");
    expect(applied).toEqual(["habit"]);
  });

  test("没有待确认时 rejectLatest 为空", () => {
    const home = mkdtempSync(join(tmpdir(), "harness-evolve2-"));
    const eng = new PetEvolveEngine(home, {
      bots: () => [bot],
      memory: () => [],
      recentUserMessages: () => [],
      petXp: () => 0,
      deliver: () => {},
      apply: () => {},
    });
    expect(eng.acceptLatest("b1")).toBe(null);
  });
});

describe("pet-prefs 进化相关默认", () => {
  test("召唤/自进化/自动接受默认全关", () => {
    const p = normalizePetPrefs({});
    expect(p.agentMaySpawn).toBe(false);
    expect(p.selfEvolve).toBe(false);
    expect(p.autoEvolve).toBe(false);
  });
});

describe("selfEvolve 闸门", () => {
  test("enabled=false 时 tick 不提议", () => {
    const home = mkdtempSync(join(tmpdir(), "harness-evolve-gate-"));
    const eng = new PetEvolveEngine(home, {
      bots: () => [bot],
      memory: () => [],
      recentUserMessages: () => [msg("以后都先给结论", Date.now())],
      petXp: () => 0,
      enabled: () => false,
      deliver: () => {},
      apply: () => {},
    });
    expect(eng.tick()).toBe(null);
  });
});
