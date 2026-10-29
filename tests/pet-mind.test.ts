import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPetMind,
  extractCompanionFact,
  formatMindForPrompt,
  listPetActivity,
  notePetDecision,
  stageFromLevel,
  levelFromXp,
} from "../core/pet-mind";
import { DEFAULT_PET_PREFS } from "../core/pet-prefs";

describe("pet-mind", () => {
  test("level / stage", () => {
    expect(levelFromXp(0)).toBe(1);
    expect(levelFromXp(100)).toBe(2);
    expect(stageFromLevel(1)).toBe("幼年");
    expect(stageFromLevel(10)).toBe("传说");
  });

  test("buildPetMind 投影", () => {
    const mind = buildPetMind({
      bot: {
        id: "b1",
        name: "小狐",
        role: "助手",
        persona: "活泼",
        providerId: "p",
        petEnabled: true,
        createdAt: 1,
        skinId: "live2d-hiyori",
      },
      xp: 400,
      prefs: { ...DEFAULT_PET_PREFS, companionChat: true, idleWork: true },
      memories: [
        { id: "1", botId: "b1", kind: "fact", content: "用户喜欢早上喝茶", createdAt: 1, updatedAt: 1 },
      ],
      recentUserLines: ["帮我看看日程"],
      affinity: { b2: 5 },
      companionQuotas: { dayCount: 1, workCount: 0, appearCount: 0 },
    });
    expect(mind.bond.level).toBeGreaterThanOrEqual(2);
    expect(mind.memory.recentFacts[0]).toContain("喝茶");
    expect(mind.autonomy.quotas.chatLeft).toBe(DEFAULT_PET_PREFS.maxChatPerDay - 1);
    expect(formatMindForPrompt(mind)).toContain("小狐");
    expect(formatMindForPrompt(mind)).toContain("搭话开");
  });

  test("activity jsonl 读写", () => {
    const home = mkdtempSync(join(tmpdir(), "harness-mind-"));
    notePetDecision(home, { botId: "b1", kind: "idleWork", via: "model", note: "提醒日程" });
    notePetDecision(home, { botId: "b1", kind: "visit", via: "model", note: "→ 小白", blocked: false });
    const rows = listPetActivity(home, { botId: "b1", limit: 10 });
    expect(rows.length).toBe(2);
    expect(rows[0].kind).toBe("visit");
  });

  test("extractCompanionFact 过滤闲聊", () => {
    expect(extractCompanionFact("嗨")).toBeNull();
    expect(extractCompanionFact("记得你说下午要交报告，要我提醒你吗？")).toContain("报告");
  });
});
