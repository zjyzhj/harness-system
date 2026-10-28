import { describe, expect, test } from "bun:test";
import {
  parsePetIntent,
  parsePetIntentsRule,
  parseDirectorIntents,
  shouldUseDirectorModel,
} from "../core/pet-director";
import { mergePrefs, normalizePetPrefs, DEFAULT_PET_PREFS } from "../core/pet-prefs";

const skins = [
  { id: "pd-doro-5", name: "Doro 卫衣" },
  { id: "pd-guga-2", name: "咕嘎" },
  { id: "default", name: "默认" },
];

describe("pet-director 规则意图", () => {
  test("换成已安装皮肤", () => {
    const i = parsePetIntent({ text: "换成 Doro 卫衣", skins });
    expect(i).toEqual({ type: "setSkin", skinId: "pd-doro-5", label: "Doro 卫衣" });
  });

  test("推荐别名走 petdex 安装", () => {
    const i = parsePetIntent({ text: "换上咕嘎", skins: [{ id: "default", name: "默认" }] });
    expect(i.type).toBe("installPetdex");
    if (i.type === "installPetdex") expect(i.slug).toBe("guga-2");
  });

  test("生成形象", () => {
    const i = parsePetIntent({ text: "生成一只戴耳机的橘猫", skins });
    expect(i.type).toBe("generatePersona");
    if (i.type === "generatePersona") expect(i.desc).toContain("橘猫");
  });

  test("安静一点", () => {
    const i = parsePetIntent({ text: "安静一点", skins });
    expect(i.type).toBe("setPace");
    if (i.type === "setPace") expect(i.companionChat).toBe(false);
  });

  test("半小时后提醒", () => {
    const i = parsePetIntent({ text: "半小时后提醒我喝水", skins });
    expect(i.type).toBe("remind");
    if (i.type === "remind") {
      expect(i.delayMs).toBe(30 * 60_000);
      expect(i.text).toContain("喝水");
    }
  });

  test("换回去", () => {
    const i = parsePetIntent({ text: "换回去", skins, skinId: "pd-doro-5", prevSkinId: "default" });
    expect(i).toEqual({ type: "revertSkin" });
  });

  test("兜底 chat", () => {
    const i = parsePetIntent({ text: "今天天气怎么样？", skins });
    expect(i).toEqual({ type: "chat", text: "今天天气怎么样？" });
  });

  test("复合句规则拆分：换成咕嘎 + 话少一点", () => {
    const intents = parsePetIntentsRule({ text: "换成咕嘎，话少一点", skins });
    expect(intents?.length).toBe(2);
    expect(intents![0]).toEqual({ type: "setSkin", skinId: "pd-guga-2", label: "咕嘎" });
    expect(intents![1].type).toBe("setPace");
    if (intents![1].type === "setPace") expect(intents![1].companionChat).toBe(false);
    expect(shouldUseDirectorModel("换成咕嘎，话少一点", intents)).toBe(false);
  });

  test("模型 JSON 多意图 hydrate", () => {
    const raw = `[{"type":"setSkin","query":"咕嘎"},{"type":"setPace","companionChat":false}]`;
    const intents = parseDirectorIntents(raw, { text: "x", skins });
    expect(intents?.map((i) => i.type)).toEqual(["setSkin", "setPace"]);
  });
});

describe("pet-prefs", () => {
  test("默认只保留基础：进阶全关", () => {
    const p = normalizePetPrefs({});
    expect(p.companionChat).toBe(false);
    expect(p.idleWork).toBe(false);
    expect(p.autoAppearance).toBe(false);
    expect(p.proactiveFollowup).toBe(false);
    expect(p.petVisit).toBe(false);
    expect(p.selfEvolve).toBe(false);
  });

  test("mergePrefs 不丢 suggestions", () => {
    const merged = mergePrefs({ suggestions: true, pet: { ...DEFAULT_PET_PREFS, companionChat: true } }, { pet: { idleWork: true } });
    expect(merged.suggestions).toBe(true);
    expect((merged.pet as { idleWork: boolean }).idleWork).toBe(true);
    expect((merged.pet as { companionChat: boolean }).companionChat).toBe(true);
  });
});
