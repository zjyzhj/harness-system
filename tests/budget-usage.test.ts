import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import { MemorySystem } from "../core/memory-system";
import { SkillRegistry } from "../core/skill-registry";
import { BotRuntime, contextWindowOf, historyBudgetOf, shrinkToolResults, turnBudgetOf } from "../core/bot-runtime";
import { ProviderCenter } from "../core/provider-center";
import { usageOf } from "../core/adapters/openai-compat";
import type { Bot, Provider } from "../core/types";

const prov = (o: Partial<Provider>): Provider => ({ id: "p", kind: "openai-compat", name: "p", isDefault: true, createdAt: 0, ...o });

describe("按模型设定上下文预算", () => {
  test("按模型名估计窗口，手动配置优先", () => {
    expect(contextWindowOf(prov({ model: "deepseek-chat" }))).toBe(64_000);
    expect(contextWindowOf(prov({ model: "claude-sonnet-4" }))).toBe(200_000);
    expect(contextWindowOf(prov({ model: "gpt-4.1-mini" }))).toBe(128_000);
    expect(contextWindowOf(prov({ model: "some-local-model" }))).toBe(16_000);
    expect(contextWindowOf(prov({ model: "deepseek-chat", contextTokens: 32_000 }))).toBe(32_000);
    expect(historyBudgetOf(64_000)).toBe(22_400);
    expect(historyBudgetOf(16_000)).toBe(8000);
    expect(historyBudgetOf(1_000_000)).toBe(24_000);
    expect(turnBudgetOf(64_000)).toBe(25_600);
  });

  test("一轮里工具结果超预算时从最早的截短，最近一轮不动", () => {
    const big = "[工具执行返回]\n" + "长".repeat(6000);
    const turns = [
      { role: "assistant", content: "查一下" }, { role: "user", content: big },
      { role: "assistant", content: "再查" }, { role: "user", content: big },
      { role: "assistant", content: "最后" }, { role: "user", content: big },
    ];
    const n = shrinkToolResults(turns, 5000, 4, (t) => t.content.startsWith("[工具执行返回]"));
    expect(n).toBe(2);
    expect(turns[1].content).toContain("已省略");
    expect(turns[3].content).toContain("已省略");
    expect(turns[5].content).toBe(big);
    expect(shrinkToolResults(turns, 5000, 4, (t) => t.content.startsWith("[工具执行返回]"))).toBe(0);
  });
});

describe("用量统计", () => {
  test("一轮里所有模型调用的用量都算上，记进消息并上报", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-usage-"));
    const store = new Store(home);
    let n = 0;
    class P extends ProviderCenter {
      override async streamComplete(_p: any, req: any): Promise<any> {
        const text = n++ === 0 ? "```tool\n" + JSON.stringify({ tool: "memory.list", args: {} }) + "\n```" : "好了";
        req._onChunk({ type: "text", text });
        return { text, content: [{ type: "text", text }], usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 60 } };
      }
    }
    const providers = new P(store);
    providers.addProvider({ kind: "openai-compat", toolMode: "text", name: "DS", baseUrl: "https://fake/v1", apiKey: "x", model: "deepseek-chat", isDefault: true });
    const bot: Bot = { id: "a", name: "助手", role: "通用", persona: "", providerId: "", petEnabled: false, createdAt: 1 };
    store.saveBot(bot);
    const reported: any[] = [];
    const rt = new BotRuntime({ store, providers, memory: new MemorySystem(home), skills: new SkillRegistry(join(home, "skills")), onUsage: (u) => reported.push(u) });
    await rt.handleStream({ bot, from: "user", text: "你好", sessionId: "s-1" }, { onBlock: () => {} });
    const last = store.listMessages("s-1").at(-1)!;
    expect(last.meta?.usage).toEqual({ input: 200, output: 40, calls: 2, cached: 120 });
    expect(last.meta?.tokensUsed).toBe(240);
    expect(reported).toEqual([{ botId: "a", providerId: expect.any(String), model: "deepseek-chat", input: 200, output: 40, calls: 2, cached: 120 }]);
  });

  test("DeepSeek / OpenAI 的缓存命中字段都能读到", () => {
    expect(usageOf({ prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 80 })).toEqual({ inputTokens: 100, outputTokens: 5, cachedTokens: 80 });
    expect(usageOf({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 64 } })).toEqual({ inputTokens: 100, outputTokens: 5, cachedTokens: 64 });
    expect(usageOf({ prompt_tokens: 1, completion_tokens: 1 })).toEqual({ inputTokens: 1, outputTokens: 1 });
  });
});

describe("系统提示是稳定前缀（前缀缓存能命中）", () => {
  test("工具轮之间、前后两条消息之间系统提示完全一样；时间、记忆、执行思路随用户消息发", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-prefix-"));
    const store = new Store(home);
    const reqs: any[] = [];
    class P extends ProviderCenter {
      override async streamComplete(_p: any, req: any): Promise<any> {
        reqs.push(req);
        const text = reqs.length === 1 ? "```tool\n" + JSON.stringify({ tool: "memory.list", args: {} }) + "\n```" : "好了";
        req._onChunk({ type: "text", text });
        return { text, content: [{ type: "text", text }] };
      }
    }
    const providers = new P(store);
    providers.addProvider({ kind: "openai-compat", toolMode: "native", name: "DS", baseUrl: "https://fake/v1", apiKey: "x", model: "deepseek-chat", isDefault: true });
    const bot: Bot = { id: "a", name: "助手", role: "通用", persona: "", providerId: "", petEnabled: false, createdAt: 1 };
    store.saveBot(bot);
    const memory = new MemorySystem(home);
    const rt = new BotRuntime({ store, providers, memory, skills: new SkillRegistry(join(home, "skills")) });
    await rt.handleStream({ bot, from: "user", text: "列一下记忆", sessionId: "s-1" }, { onBlock: () => {} });
    memory.add("a", { kind: "fact", content: "用户养了一只叫团子的猫" });
    await rt.handleStream({ bot, from: "user", text: "我的猫叫什么", sessionId: "s-1" }, { onBlock: () => {} });
    expect(reqs.length).toBe(3);
    expect(new Set(reqs.map((r) => r.system)).size).toBe(1);
    expect(reqs[0].system).not.toContain("当前时间");
    expect(reqs[0].system).not.toContain("[继续");
    expect(String(reqs[0].user)).toContain("当前时间");
    expect(String(reqs[2].user)).toContain("团子");
    expect(JSON.stringify(reqs[1].tail)).toContain("[继续");
  });
});
