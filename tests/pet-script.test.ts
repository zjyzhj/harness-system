import { describe, expect, test } from "bun:test";
import { expandPhraseToBeats, parseBeats, estimateScriptMs } from "../core/pet-script";
import { resolveMotion, traitsBlob } from "../core/pet-motion";
import { parsePetIntent } from "../core/pet-director";

describe("pet-script", () => {
  test("大招展开为多拍脚本", () => {
    const beats = expandPhraseToBeats("龟派气功");
    expect(beats!.length).toBeGreaterThan(1);
    expect(beats!.some((b) => b.type === "fx")).toBe(true);
    expect(estimateScriptMs(beats!)).toBeGreaterThan(1000);
  });

  test("parseBeats 校验", () => {
    const beats = parseBeats([
      { type: "action", action: "jump", hold: 2 },
      { type: "say", text: "嘿" },
      { type: "wait", ms: 200 },
      { type: "action", action: "nope" },
    ]);
    expect(beats!.length).toBe(3);
  });

  test("一句话放出大招 → script 意图", () => {
    const i = parsePetIntent({ text: "放出龟派气功", skins: [] });
    expect(i.type).toBe("script");
  });
});

describe("pet-motion", () => {
  test("celebrate → TapBody", () => {
    const p = resolveMotion("celebrate", { traits: { blob: "活泼可爱" } });
    expect(p.live2dGroup).toBe("TapBody");
    expect(p.mood).toBe("excited");
  });

  test("sleep → 闭眼", () => {
    const p = resolveMotion("sleep", { traits: { blob: "懒" } });
    expect(p.sleepEyes).toBe(true);
    expect(p.holdSec).toBeGreaterThanOrEqual(8);
  });

  test("traitsBlob", () => {
    expect(traitsBlob({ persona: "稳重", personaCard: { traits: ["酷"] } })).toContain("酷");
  });
});
