import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PetEffectRegistry,
  inferEffectFromPhrase,
  smartEffectName,
  parseInventedEffect,
  BUILTIN_EFFECTS,
} from "../core/pet-effects";
import { parsePetIntent } from "../core/pet-director";

describe("pet-effects", () => {
  test("内置含龟派气功", () => {
    expect(BUILTIN_EFFECTS.some((e) => e.name === "龟派气功")).toBe(true);
  });

  test("infer 龟派气功 → beam", () => {
    const r = inferEffectFromPhrase("放出龟派气功");
    expect(r.name).toContain("龟派气功");
    expect(r.recipe.overlay).toBe("beam");
  });

  test("smartEffectName 截短口语", () => {
    expect(smartEffectName("红色冲击波吧")).toBe("红色冲击波");
    expect(inferEffectFromPhrase("放出红色冲击波吧").name).toBe("红色冲击波");
  });

  test("findReusable / resolveSmart：已有则复用", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-fx-"));
    const reg = new PetEffectRegistry(home, { maxCustom: 5, unusedMs: 1000, defaultTtlMs: 5000 });
    const hit = reg.findReusable("放出龟派气功");
    expect(hit?.effect.name).toBe("龟派气功");
    expect(hit!.score).toBeGreaterThanOrEqual(70);

    let invented = 0;
    const r = await reg.resolveSmart("龟派气功", async () => {
      invented++;
      return null;
    });
    expect(r.mode).toBe("reuse");
    expect(invented).toBe(0);
    expect(r.effect.recipe.overlay).toBe("beam");
  });

  test("resolveSmart：无复用时走模型发明", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-fx-"));
    const reg = new PetEffectRegistry(home);
    const r = await reg.resolveSmart("放出银河螺旋炮", async () => ({
      name: "银河螺旋炮",
      aliases: ["螺旋炮"],
      recipe: { overlay: "beam", color: "#e879f9", motion: "celebrate", holdSec: 2, durationMs: 2200, label: "螺旋炮！" },
    }));
    expect(r.mode).toBe("invent");
    expect(r.effect.name).toBe("银河螺旋炮");
    expect(r.effect.kind).toBe("custom");

    const again = await reg.resolveSmart("银河螺旋炮");
    expect(again.mode).toBe("reuse");
  });

  test("parseInventedEffect 校验 / 容忍 overlay 与 markdown", () => {
    expect(parseInventedEffect('{"name":"火球","overlay":"burst","color":"#f97316","motion":"jump"}')?.recipe.overlay).toBe("burst");
    // 未知 overlay 按语义收成合法枚举，不再整段作废
    expect(parseInventedEffect('{"name":"激光炮","overlay":"laser"}')?.recipe.overlay).toBe("beam");
    expect(parseInventedEffect('```json\n{"name":"星尘漩涡","overlay":"vortex","color":"#a78bfa"}\n```')?.name).toContain("星尘漩涡");
    expect(parseInventedEffect('{"name":"x","overlay":"vortex"}')?.recipe.overlay).toBe("burst");
  });

  test("自定义智能命名 + 钉住不回收 + forget", () => {
    const home = mkdtempSync(join(tmpdir(), "harness-fx-"));
    const reg = new PetEffectRegistry(home, { maxCustom: 3, unusedMs: 1, defaultTtlMs: 50 });
    const { effect, created } = reg.resolveOrCreate("放出蓝色龙息");
    expect(created).toBe(true);
    expect(effect.name).toContain("蓝色龙息");
    expect(effect.kind).toBe("custom");
    expect(effect.recipe.overlay).toBe("beam");

    reg.pin(effect.name, true);
    const pinned = reg.get(effect.name)!;
    expect(pinned.sticky).toBe(true);
    expect(pinned.expiresAt).toBeUndefined();

    // 塞满再 gc：钉住的还在
    reg.resolveOrCreate("特效甲");
    reg.resolveOrCreate("特效乙");
    reg.resolveOrCreate("特效丙");
    reg.resolveOrCreate("特效丁");
    reg.gc(false);
    expect(reg.get("蓝色龙息")).toBeTruthy();

    expect(reg.remove("蓝色龙息")).toBe(true);
    expect(reg.get("蓝色龙息")).toBeNull();
  });

  test("超限 LRU 回收非钉住", () => {
    const home = mkdtempSync(join(tmpdir(), "harness-fx-"));
    const reg = new PetEffectRegistry(home, { maxCustom: 2, unusedMs: 999999999, defaultTtlMs: 999999999 });
    reg.resolveOrCreate("招式一");
    reg.resolveOrCreate("招式二");
    reg.resolveOrCreate("招式三");
    const names = reg.list().filter((e) => e.kind === "custom").map((e) => e.name);
    expect(names.length).toBeLessThanOrEqual(2);
  });
});

describe("pet-director fx/act", () => {
  test("放出龟派气功", () => {
    const i = parsePetIntent({ text: "放出龟派气功", skins: [] });
    expect(i.type).toBe("script");
    if (i.type === "script") expect(i.beats.some((b) => b.type === "fx")).toBe(true);
  });

  test("跳一下", () => {
    const i = parsePetIntent({ text: "跳一下", skins: [] });
    expect(i.type).toBe("act");
    if (i.type === "act") expect(i.action).toBe("jump");
  });
});
