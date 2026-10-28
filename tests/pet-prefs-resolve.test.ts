import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PET_PREFS,
  clearPetBotPrefs,
  mergePrefs,
  normalizePetPrefs,
  patchPetBotPrefs,
  resolvePetPrefs,
} from "../core/pet-prefs";

describe("pet-prefs 默认只保留基础能力", () => {
  test("进阶开关默认全关", () => {
    const p = normalizePetPrefs({});
    expect(p.companionChat).toBe(false);
    expect(p.proactiveFollowup).toBe(false);
    expect(p.idleWork).toBe(false);
    expect(p.autoAppearance).toBe(false);
    expect(p.agentMaySpawn).toBe(false);
    expect(p.selfEvolve).toBe(false);
    expect(p.autoEvolve).toBe(false);
    expect(p.petVisit).toBe(false);
  });

  test("显式 true 才打开", () => {
    const p = normalizePetPrefs({ petVisit: true, companionChat: true, selfEvolve: true });
    expect(p.petVisit).toBe(true);
    expect(p.companionChat).toBe(true);
    expect(p.selfEvolve).toBe(true);
    expect(p.autoEvolve).toBe(false);
  });
});

describe("per-bot 覆盖", () => {
  test("resolvePetPrefs 合并全局与单宠", () => {
    const prefs = mergePrefs({}, {
      pet: { companionChat: true, petVisit: false },
      petBots: { a: { companionChat: false, petVisit: true } },
    });
    const cfg = { prefs };
    expect(resolvePetPrefs(cfg).companionChat).toBe(true);
    expect(resolvePetPrefs(cfg, "a").companionChat).toBe(false);
    expect(resolvePetPrefs(cfg, "a").petVisit).toBe(true);
    expect(resolvePetPrefs(cfg, "b").companionChat).toBe(true);
  });

  test("patchPetBotPrefs / clearPetBotPrefs", () => {
    let prefs = patchPetBotPrefs({}, "x", { companionChat: true });
    expect((prefs.petBots as Record<string, { companionChat: boolean }>).x.companionChat).toBe(true);
    prefs = clearPetBotPrefs(prefs, "x");
    expect((prefs.petBots as Record<string, unknown>).x).toBeUndefined();
  });

  test("DEFAULT 与 normalize 一致", () => {
    expect(normalizePetPrefs({})).toEqual(DEFAULT_PET_PREFS);
  });
});
