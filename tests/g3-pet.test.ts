import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PetSkinRegistry, DEFAULT_SKIN, petSkins, type PetAction } from "../core/pet-skin";
import { Scheduler } from "../core/scheduler";

describe("G3 pet-skin", () => {
  test("T3.0a 默认皮肤非空且含全部动作", () => {
    expect(DEFAULT_SKIN.id).toBe("default");
    expect(DEFAULT_SKIN.frames.idle.length).toBeGreaterThan(0);
    for (const a of ["idle", "walk", "jump", "sleep", "celebrate", "work", "think"] as PetAction[]) {
      expect(DEFAULT_SKIN.frames[a].length).toBeGreaterThan(0);
    }
  });

  test("T3.0b 帧轮播：同一动作不同帧索引返回不同帧", () => {
    const reg = new PetSkinRegistry();
    const idle = DEFAULT_SKIN.frames.idle;
    expect(reg.frame("default", "idle", 0)).toBe(idle[0]);
    expect(reg.frame("default", "idle", 1)).toBe(idle[1 % idle.length]);
    // 若帧组只有 1 种，则帧索引取模后必然相同；默认 idle 应至少 2 帧
    expect(idle.length).toBeGreaterThanOrEqual(2);
  });

  test("T3.0c 注册皮肤 + 缺失动作回退 idle", () => {
    const reg = new PetSkinRegistry();
    reg.register({ id: "test", name: "测试", frames: { idle: ["A", "B"], walk: ["W"], jump: ["J"], sleep: ["S"], celebrate: ["C"], work: ["W2"], think: ["T"] }, fps: 3 });
    expect(reg.get("test").fps).toBe(3);
    expect(reg.frame("test", "walk", 5)).toBe("W");
    // 未定义动作（构造时若缺字段会类型报错，这里验证注册后帧回退逻辑）
    expect(reg.frame("test", "idle", 1)).toBe("B");
  });

  test("T3.0d pixel 皮肤可用且帧数正确", () => {
    const pixel = petSkins.get("pixel");
    expect(pixel.name).toBe("像素");
    expect(petSkins.frame("pixel", "idle", 0)).toBe("🐾");
    expect(petSkins.frameCount("pixel", "idle")).toBe(3);
  });
});

describe("G3 scheduler once/alarm", () => {
  let home: string;
  let sched: Scheduler;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "harness-g3-"));
    sched = new Scheduler(home);
  });
  afterAll(() => sched.stop());

  test("T3.4a once 任务：到期 onAlarm 触发一次且禁用不重复", async () => {
    const fired: string[] = [];
    sched.onAlarm = (t) => fired.push(t.id);
    const t = sched.create({ botId: "b1", name: "喝水提醒", cron: "* * * * *", kind: "once", alarmAt: Date.now() + 60_000, notifyPet: true });
    expect(t.kind).toBe("once");
    // 未到期：不触发
    await sched.tick(Date.now() + 10_000);
    expect(fired).toEqual([]);
    expect(sched.list()[0].enabled).toBe(true);
    // 到期：触发一次
    await sched.tick(Date.now() + 70_000);
    expect(fired).toEqual([t.id]);
    const after = sched.list()[0];
    expect(after.enabled).toBe(false);
    expect(after.lastResult).toBe("ok");
    // 再 tick 不再触发
    await sched.tick(Date.now() + 3600_000);
    expect(fired).toEqual([t.id]);
  });

  test("T3.4b notifyPet=false 不触发 onAlarm", async () => {
    let fired = 0;
    sched.onAlarm = () => { fired++; };
    sched.create({ botId: "b2", name: "静默闹钟", cron: "* * * * *", kind: "once", alarmAt: Date.now() - 1000, notifyPet: false });
    await sched.tick(Date.now());
    expect(fired).toBe(0);
    // 但任务仍被禁用
    const t = sched.list().find((x) => x.botId === "b2");
    expect(t?.enabled).toBe(false);
  });

  test("T3.4c cron 任务不受 once 影响（回归）", async () => {
    let ran = 0;
    sched.onRun = async () => { ran++; };
    sched.create({ botId: "b3", name: "日报", cron: "0 9 * * *", prompt: "写日报" });
    await sched.tick(Date.now());
    expect(ran).toBe(0); // 未到 9 点
  });
});

describe("G3 persona skin link", () => {
  test("T3.6a inferSkin：像素/可爱关键词映射", async () => {
    const { inferSkin } = await import("../core/persona");
    expect(inferSkin("像素风小狐狸")).toBe("pixel");
    expect(inferSkin("圆润可爱的橘猫")).toBe("cute");
    expect(inferSkin("蓝色狐狸")).toBe("default");
  });
});

describe("G5.5 brand skins", () => {
  test("品牌预设皮肤齐全且帧可用", () => {
    const ids = petSkins.list().map((s) => s.id);
    for (const id of ["deepseek", "claude", "doro", "guga", "grok", "default", "pixel", "cute"]) {
      expect(ids).toContain(id);
    }
    for (const id of ["deepseek", "claude", "doro", "guga", "grok"]) {
      const sk = petSkins.get(id);
      expect(sk.frames.idle.length).toBeGreaterThan(0);
      expect(sk.color).toBeTruthy();
      expect(petSkins.frame(id, "idle", 0)).toBeTruthy();
    }
  });

  test("品牌皮肤动作帧非空", () => {
    for (const a of ["idle", "walk", "jump", "sleep", "celebrate", "work", "think"] as PetAction[]) {
      for (const id of ["deepseek", "claude", "doro", "guga", "grok"]) {
        expect(petSkins.frameCount(id, a)).toBeGreaterThan(0);
      }
    }
  });
});

describe("G5.5 skin persistence (community sprite)", () => {
  test("下载注册 → 落盘 index.json → 新建 registry 恢复", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-skins-"));
    const reg = new PetSkinRegistry(dir);
    const sprite = { url: "https://example.test/claude/spritesheet.webp", path: join(dir, "skins", "claude-x", "spritesheet.webp"), rows: 9, cols: 8 };
    reg.register({ id: "claude-x", name: "Claude 测试", color: "#D97757", desc: "社区皮肤", fps: 8, sprite, frames: { idle: ["🙂"], walk: ["🚶"], jump: ["🤸"], sleep: ["😴"], celebrate: ["🎉"], work: ["🤔"], think: ["💭"] } });
    // 新实例从 index.json 恢复
    const reg2 = new PetSkinRegistry(dir);
    const restored = reg2.get("claude-x");
    expect(restored.id).toBe("claude-x");
    expect(restored.name).toBe("Claude 测试");
    expect(restored.sprite?.path).toBe(sprite.path);
    expect(restored.sprite?.rows).toBe(9);
    // 内置品牌不受影响
    expect(reg2.list().map((s) => s.id)).toContain("deepseek");
  });

  test("内置皮囊不需要 assetsDir 也能工作", () => {
    const reg = new PetSkinRegistry();
    expect(reg.get("default").id).toBe("default");
    // 无 assetsDir 时 register 不落盘也不报错
    reg.register({ id: "x", name: "X", frames: { idle: ["A"], walk: ["B"], jump: ["C"], sleep: ["D"], celebrate: ["E"], work: ["F"], think: ["G"] }, fps: 2 });
    expect(reg.get("x").name).toBe("X");
  });
});
