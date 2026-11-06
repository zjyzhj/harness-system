import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import {
  firstRunEmptyCopy,
  firstRunStep,
  seedBotWelcome,
  welcomeGreeting,
  welcomeSuggestions,
} from "../core/bot-onboard";
import type { Bot } from "../core/types";

describe("bot onboard welcome", () => {
  test("问候与建议非空", () => {
    const bot = { name: "改包助手", role: "产包主控", persona: "务实" };
    expect(welcomeGreeting(bot)).toContain("改包助手");
    expect(welcomeSuggestions(bot).length).toBe(3);
  });

  test("无模型时建议优先提醒去配置", () => {
    const tips = welcomeSuggestions({ name: "小测", role: "助手" }, { hasProvider: false });
    expect(tips[0]).toMatch(/模型/);
    expect(tips.length).toBe(3);
  });

  test("seed 写入欢迎会话，重复调用不另开", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-onboard-"));
    const store = new Store(dir);
    const bot: Bot = {
      id: "bot-x", name: "小测", role: "助手", persona: "友好",
      providerId: "", petEnabled: false, createdAt: Date.now(),
    };
    store.saveBot(bot);
    const sid = seedBotWelcome(store, bot);
    const msgs = store.listMessages(sid);
    expect(msgs.length).toBe(1);
    expect(String(msgs[0]?.content)).toContain("小测");
    expect(msgs[0]?.meta?.suggestions?.length).toBeGreaterThan(0);
    expect(msgs[0]?.meta?.suggestions?.[0]).toMatch(/模型/);
    expect(seedBotWelcome(store, bot)).toBe(sid);
  });

  test("有模型时欢迎建议不催配置", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-onboard-"));
    const store = new Store(dir);
    store.saveProvider({
      id: "p1", name: "DeepSeek", kind: "openai-compat",
      baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", isDefault: true,
      createdAt: Date.now(),
    });
    const bot: Bot = {
      id: "bot-y", name: "有模", role: "助手", persona: "",
      providerId: "p1", petEnabled: false, createdAt: Date.now(),
    };
    store.saveBot(bot);
    const sid = seedBotWelcome(store, bot);
    const tips = store.listMessages(sid)[0]?.meta?.suggestions ?? [];
    expect(tips.some((t) => /模型/.test(t))).toBe(false);
  });
});

describe("first-run funnel", () => {
  test("步骤：无模型 → 无 bot → 可聊", () => {
    expect(firstRunStep({ providerCount: 0, botCount: 0 })).toBe("provider");
    expect(firstRunStep({ providerCount: 1, botCount: 0 })).toBe("bot");
    expect(firstRunStep({ providerCount: 1, botCount: 2 })).toBe("chat");
  });

  test("空状态文案带主按钮", () => {
    expect(firstRunEmptyCopy("provider").primary).toMatch(/模型/);
    expect(firstRunEmptyCopy("bot").primary).toMatch(/bot/i);
    expect(firstRunEmptyCopy("chat").title).toMatch(/选/);
  });
});
