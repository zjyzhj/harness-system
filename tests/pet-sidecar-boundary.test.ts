/**
 * 边界：未挂载娱乐侧车时，BotRuntime 是完整 Bot，不含 pet 工具与桌宠提示。
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import { MemorySystem } from "../core/memory-system";
import { SkillRegistry } from "../core/skill-registry";
import { BotRuntime } from "../core/bot-runtime";
import { ProviderCenter } from "../core/provider-center";
import { attachPetEntertainment, type PetHost } from "../core/pet";
import type { Bot } from "../core/types";

function bareRuntime() {
  const home = mkdtempSync(join(tmpdir(), "harness-pet-bound-"));
  const store = new Store(home);
  const providers = new ProviderCenter(store);
  providers.addProvider({ kind: "openai-compat", name: "默认", baseUrl: "https://fake/v1", apiKey: "x", model: "m", isDefault: true });
  const bot: Bot = { id: "a", name: "助手", role: "助手", persona: "", providerId: "", petEnabled: false, createdAt: 1 };
  store.saveBot(bot);
  const rt = new BotRuntime({
    store,
    providers,
    memory: new MemorySystem(home),
    skills: new SkillRegistry(join(home, "skills")),
  });
  return { rt, bot, store };
}

describe("宠物娱乐侧车边界", () => {
  test("未挂载：无 pet.* 工具", () => {
    const { rt } = bareRuntime();
    expect(rt.toolRegistry().prompt()).not.toContain("pet.");
    expect(rt.toolRegistry().has("pet.status")).toBe(false);
  });

  test("未挂载：app.createBot 带 pet 也不自动上台", async () => {
    const { rt, bot, store } = bareRuntime();
    const out = await rt.toolRegistry().run({
      bot, tool: "app.createBot", args: { name: "小宠", pet: true }, originalText: "", depth: 0,
    });
    expect(out.output).toContain("小宠");
    expect(out.output).toMatch(/娱乐|详情|出来/);
    const created = store.listBots().find((b) => b.name === "小宠");
    expect(created).toBeTruthy();
    expect(created!.petEnabled).toBe(false);
  });

  test("挂载后：出现 pet.*，且可执行 pet.status", async () => {
    const { rt, bot, store } = bareRuntime();
    const host: PetHost = {
      show: () => {},
      hide: () => {},
      skinLabel: () => "默认",
      maySpawn: () => false,
      isShown: () => false,
      xp: () => 0,
    };
    attachPetEntertainment(rt, { store, host });
    expect(rt.toolRegistry().has("pet.status")).toBe(true);
    const out = await rt.toolRegistry().run({
      bot, tool: "pet.status", args: {}, originalText: "", depth: 0,
    });
    expect(out.output).toContain("助手");
  });
});
