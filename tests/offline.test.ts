import { describe, test, expect } from "bun:test";
import { OfflinePersona, offlineIntro } from "../core/offline-persona";
import type { Bot, MemoryEntry } from "../core/types";

const bot: Bot = {
  id: "b", name: "小狐", role: "陪伴助手", persona: "活泼可爱",
  providerId: "none", petEnabled: true, createdAt: Date.now(),
  personaCard: { name: "小狐", traits: ["蓝色色系", "狐狸形态", "可爱"], catchphrase: "嘿嘿，需要我帮忙吗？" },
};

const mem: MemoryEntry[] = [
  { id: "1", botId: "b", kind: "fact", content: "用户喜欢喝美式咖啡", createdAt: 1, updatedAt: 1 },
];

describe("offline-persona", () => {
  test("问候生成有性格回复", () => {
    const p = new OfflinePersona();
    const r = p.reply(bot, "你好", mem);
    expect(r).toContain("小狐");
    expect(r.length).toBeGreaterThan(5);
  });
  test("离线始终 available", () => {
    expect(new OfflinePersona().available()).toBe(true);
  });
  test("基于记忆关怀", () => {
    const p = new OfflinePersona();
    const r = p.reply(bot, "在吗？", mem);
    expect(r.length).toBeGreaterThan(5);
  });
  test("proactive 会给出搭话", () => {
    const p = new OfflinePersona();
    // 强随机下不应返回 null（facts 存在）
    const r = p.proactive(bot, mem);
    expect(r).not.toBeNull();
    expect(r!.text.length).toBeGreaterThan(5);
  });
  test("offlineIntro 自我介绍", () => {
    expect(offlineIntro(bot)).toContain("小狐");
    expect(offlineIntro(bot)).toContain("蓝色色系");
  });
});
