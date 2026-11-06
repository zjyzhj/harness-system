import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import { GroupRegistry } from "../core/group-registry";
import {
  GROUP_STARTERS,
  groupStarterSuggestions,
  groupWelcomeText,
  pickMembersForStarter,
  seedGroupWelcome,
} from "../core/group-onboard";

describe("group onboard", () => {
  test("模板齐全且带起步话术", () => {
    expect(GROUP_STARTERS.length).toBeGreaterThanOrEqual(3);
    for (const s of GROUP_STARTERS) {
      expect(s.starters.length).toBeGreaterThanOrEqual(2);
      expect(s.goal.length).toBeGreaterThan(10);
    }
  });

  test("按角色关键词挑成员，不足时回落", () => {
    const bots = [
      { id: "1", name: "调研小助", role: "调研" },
      { id: "2", name: "写作酱", role: "写作" },
      { id: "3", name: "闲逛", role: "闲聊" },
    ];
    const starter = GROUP_STARTERS.find((s) => s.id === "research-write")!;
    const ids = pickMembersForStarter(bots, starter);
    expect(ids).toContain("1");
    expect(ids).toContain("2");
    expect(ids.length).toBeGreaterThanOrEqual(2);

    const onlyOne = pickMembersForStarter([{ id: "a", name: "独苗", role: "" }], starter, []);
    expect(onlyOne).toEqual(["a"]);
  });

  test("欢迎文案含 @ 规则与目标", () => {
    const text = groupWelcomeText(
      { name: "产品组", settings: { goal: "本周定方案" } },
      ["甲", "乙"],
    );
    expect(text).toContain("产品组");
    expect(text).toContain("@");
    expect(text).toContain("本周定方案");
    expect(groupStarterSuggestions({ name: "产品组" }, "triage")[0]).toMatch(/分诊|复述|候选/);
  });

  test("seed 写入欢迎房，重复不另开", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-group-onboard-"));
    const store = new Store(dir);
    const groups = new GroupRegistry(dir);
    const g = groups.create("早会", "user", ["b1", "b2"]);
    groups.update(g.id, { settings: { goal: "对齐进度" } });
    const fresh = groups.get(g.id)!;
    const sid = seedGroupWelcome(store, fresh, ["甲", "乙"], { starterId: "daily-review" });
    const msgs = store.listMessages(sid);
    expect(msgs.length).toBe(1);
    expect(String(msgs[0]?.content)).toContain("早会");
    expect(msgs[0]?.meta?.tag).toBe("group-welcome");
    expect(msgs[0]?.meta?.suggestions?.length).toBe(3);
    expect(seedGroupWelcome(store, fresh, ["甲", "乙"])).toBe(sid);
    expect(store.listMessages(sid).length).toBe(1);
  });
});
