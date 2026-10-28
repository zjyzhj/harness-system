import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import { MemorySystem } from "../core/memory-system";
import { SkillRegistry } from "../core/skill-registry";
import { BotRuntime, looksLikeRule, rulesWhereabouts, skillRuleLines } from "../core/bot-runtime";
import { ProviderCenter } from "../core/provider-center";
import type { Bot } from "../core/types";

const bot: Bot = { id: "a", name: "助手", role: "通用", persona: "", providerId: "", petEnabled: false, createdAt: 1 };

function runWith(calls: { tool: string; args: Record<string, unknown> }[]) {
  const home = mkdtempSync(join(tmpdir(), "harness-rules-"));
  const store = new Store(home);
  class P extends ProviderCenter {
    n = 0;
    override async streamComplete(_p: any, req: any): Promise<any> {
      const c = calls[this.n++];
      const text = c ? "```tool\n" + JSON.stringify(c) + "\n```" : "好的";
      req._onChunk({ type: "text", text });
      return { text, content: [{ type: "text", text }] };
    }
    override async complete(): Promise<any> { return { text: "[]" }; }
  }
  const providers = new P(store);
  providers.addProvider({ kind: "openai-compat", toolMode: "text", name: "m", baseUrl: "https://fake/v1", apiKey: "x", model: "m", isDefault: true });
  store.saveBot(bot);
  const memory = new MemorySystem(home);
  const skills = new SkillRegistry(join(home, "skills"));
  const rt = new BotRuntime({ store, providers, memory, skills });
  return { rt, memory, skills, home };
}

describe("规范与记忆落盘", () => {
  test("「以后称呼我…」即使模型标成 fact 也存成规范", async () => {
    const { rt, home } = runWith([{ tool: "memory.add", args: { content: "用户希望被称呼为周老师", kind: "fact" } }]);
    await rt.handle({ bot, from: "user", text: "以后称呼我为周老师", sessionId: "s-1" });
    const saved = new MemorySystem(home).list("bot:a");
    expect(saved.find((e) => e.content.includes("周老师"))?.kind).toBe("rule");
    expect(looksLikeRule("用户叫小周，是 iOS 开发")).toBe(false);
    expect(looksLikeRule("回答都用中文")).toBe(true);
  });

  test("规范写进停用的技能时自动启用，否则不会生效", async () => {
    const { rt, skills, home } = runWith([{ tool: "skill.update", args: { key: "weekly", append: ["每条开头标完成度【80%】"] } }]);
    skills.save({ key: "weekly", name: "周报", description: "写周报", body: "# 周报", owner: "a", enabled: false });
    const r = await rt.handle({ bot, from: "user", text: "以后周报每条标完成度", sessionId: "s-1" });
    const sk = new SkillRegistry(join(home, "skills")).get("weekly")!;
    expect(sk.enabled).toBe(true);
    expect(sk.body).toContain("【80%】");
    expect(r.content?.some((b) => b.type === "tool_call" && String(b.result).includes("已经启用"))).toBe(true);
  });

  test("规范清单里带上技能里的规范原文，问「规范在哪」时说得出内容", () => {
    const body = "# 周报\n正文\n\n## 用户补充的规范（与上文冲突时以这里为准）\n- 每条开头标完成度【80%】（2026-10-28）";
    expect(skillRuleLines(body)).toEqual(["- 每条开头标完成度【80%】（2026-10-28）"]);
    const s = rulesWhereabouts(bot, [{ key: "weekly", name: "周报", owner: "a", enabled: true, body }]);
    expect(s).toContain("[周报](app:skill/weekly)");
    expect(s).toContain("【80%】");
  });
});
