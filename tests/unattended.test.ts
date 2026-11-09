import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import { MemorySystem } from "../core/memory-system";
import { SkillRegistry } from "../core/skill-registry";
import { BotRuntime } from "../core/bot-runtime";
import { ProviderCenter } from "../core/provider-center";
import { BrowserPresence, type BrowserHost } from "../core/browser-presence";
import { ConsentCenter } from "../core/consent-center";
import type { Bot } from "../core/types";

describe("无人值守（编排阶段 / 定时任务）", () => {
  test("bot 想反问用户时被挡回，自己做假设继续交付产出", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-unattended-"));
    const store = new Store(home);
    const systems: string[] = [];
    class P extends ProviderCenter {
      override async streamComplete(_p: any, req: any): Promise<any> {
        systems.push(req.system);
        const back = String(req.user).includes("[工具执行返回]");
        const text = back ? "假设主题是 AI 写作工具。报告正文……" : "```tool\n" + JSON.stringify({ tool: "ui.ask", args: { question: "主题是？", options: ["A", "B"] } }) + "\n```";
        req._onChunk({ type: "text", text });
        return { text, content: [{ type: "text", text }] };
      }
    }
    const providers = new P(store);
    providers.addProvider({ kind: "openai-compat", toolMode: "text", name: "默认", baseUrl: "https://fake/v1", apiKey: "x", model: "m", isDefault: true });
    const bot: Bot = { id: "a", name: "写手", role: "写作", persona: "", providerId: "", petEnabled: false, createdAt: Date.now() };
    store.saveBot(bot);
    const rt = new BotRuntime({ store, providers, memory: new MemorySystem(home), skills: new SkillRegistry(join(home, "skills")) });
    const r = await rt.handleStream({ bot, from: "orchestrator", text: "写报告", sessionId: "plan-1" }, { onBlock: () => {}, unattended: true });
    expect(systems[0]).toContain("【例行】");
    expect(r.text).toContain("报告正文");
    expect(r.content?.some((b) => b.type === "choice")).toBe(false);
  });

  test("例行里出站发送停在批准点", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-unattended-"));
    const store = new Store(home);
    const seen: string[] = [];
    class P extends ProviderCenter {
      override async streamComplete(_p: any, req: any): Promise<any> {
        seen.push(String(req.user));
        const back = String(req.user).includes("[工具执行返回]");
        const text = back
          ? "等你回来再发。"
          : "```tool\n" + JSON.stringify({ tool: "webhook.post", args: { to: "飞书" } }) + "\n```";
        req._onChunk({ type: "text", text });
        return { text, content: [{ type: "text", text }] };
      }
    }
    const providers = new P(store);
    providers.addProvider({ kind: "openai-compat", toolMode: "text", name: "默认", baseUrl: "https://fake/v1", apiKey: "x", model: "m", isDefault: true });
    const bot: Bot = { id: "a", name: "写手", role: "写作", persona: "", providerId: "", petEnabled: false, createdAt: Date.now() };
    store.saveBot(bot);
    const rt = new BotRuntime({ store, providers, memory: new MemorySystem(home), skills: new SkillRegistry(join(home, "skills")) });
    const r = await rt.handleStream({ bot, from: "scheduler", text: "把早报发出去", sessionId: "sched-1" }, { onBlock: () => {}, unattended: true });
    expect(seen.some((u) => u.includes("批准点"))).toBe(true);
    expect(r.text).toContain("等你回来再发");
  });

  test("例行可 browser.goto，不弹确认卡", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-unattended-"));
    const store = new Store(home);
    const consent = new ConsentCenter(home);
    let asked = 0;
    consent.decider = async () => { asked++; return "deny" as const; };
    const calls: string[] = [];
    const host: BrowserHost = {
      partitionOf: (id) => `persist:bot-browser-${id}`,
      open: async (botId, url) => { calls.push(`open:${url}`); return { ok: true, url: url || "about:blank", title: "t" }; },
      goto: async (_b, url) => { calls.push(`goto:${url}`); return { ok: true, url, title: "t" }; },
      snapshot: async () => ({ ok: false, error: "no" }),
      click: async () => ({ ok: false, error: "no" }),
      type: async () => ({ ok: false, error: "no" }),
      keys: async () => ({ ok: false, error: "no" }),
      read: async () => ({ ok: false, error: "no" }),
      stop: async () => {},
    };
    const browserPresence = new BrowserPresence(host);
    class P extends ProviderCenter {
      override async streamComplete(_p: any, req: any): Promise<any> {
        const back = String(req.user).includes("[工具执行返回]");
        const text = back
          ? "已打开仪表盘。"
          : "```tool\n" + JSON.stringify({ tool: "browser.goto", args: { url: "https://example.com/dash" } }) + "\n```";
        req._onChunk({ type: "text", text });
        return { text, content: [{ type: "text", text }] };
      }
    }
    const providers = new P(store);
    providers.addProvider({ kind: "openai-compat", toolMode: "text", name: "默认", baseUrl: "https://fake/v1", apiKey: "x", model: "m", isDefault: true });
    const bot: Bot = { id: "a", name: "写手", role: "写作", persona: "", providerId: "", petEnabled: false, createdAt: Date.now() };
    store.saveBot(bot);
    const rt = new BotRuntime({
      store, providers, memory: new MemorySystem(home), skills: new SkillRegistry(join(home, "skills")),
      consent, browserPresence,
    });
    const r = await rt.handleStream({ bot, from: "scheduler", text: "打开仪表盘", sessionId: "sched-bb" }, { onBlock: () => {}, unattended: true });
    expect(asked).toBe(0);
    expect(calls.some((c) => c.includes("example.com"))).toBe(true);
    expect(r.text).toContain("仪表盘");
  });
});
