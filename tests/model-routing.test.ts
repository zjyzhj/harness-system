import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import { MemorySystem } from "../core/memory-system";
import { SkillRegistry } from "../core/skill-registry";
import { BotRuntime, needsReasoning, parseVerdict } from "../core/bot-runtime";
import { ProviderCenter } from "../core/provider-center";
import type { Bot } from "../core/types";

const master: Bot = { id: "m", name: "主控", role: "调度", persona: "", providerId: "", petEnabled: false, createdAt: 1, isMaster: true };
const worker: Bot = { ...master, id: "w", name: "写手", isMaster: false };

describe("模型路由判定", () => {
  test("主控遇到规划类 / 长任务才走推理路线", () => {
    expect(needsReasoning(master, "帮我把这个需求拆解成开发任务", {})).toBe(true);
    expect(needsReasoning(master, "你好", {})).toBe(false);
    expect(needsReasoning(master, "x".repeat(220), {})).toBe(true);
    expect(needsReasoning(worker, "帮我把这个需求拆解成开发任务", {})).toBe(false);
    expect(needsReasoning({ ...worker, reasoning: "always" }, "你好", {})).toBe(true);
    expect(needsReasoning(master, "帮我把这个需求拆解成开发任务", { think: true })).toBe(false);
    expect(needsReasoning(master, "帮我把这个需求拆解成开发任务", { depth: 1 })).toBe(false);
  });

  test("自检结论解析：坏 JSON 按通过处理", () => {
    expect(parseVerdict('{"ok":false,"issues":["漏了第3点"]}')).toEqual({ ok: false, issues: ["漏了第3点"] });
    expect(parseVerdict("好的 {\"ok\":true}")).toEqual({ ok: true, issues: [] });
    expect(parseVerdict("乱写").ok).toBe(true);
    expect(parseVerdict('{"ok":false,"issues":[]}').ok).toBe(true);
  });
});

function setup(stream: (req: any, n: number) => string, complete: (req: any) => string) {
  const home = mkdtempSync(join(tmpdir(), "harness-route-"));
  const store = new Store(home);
  const calls = { stream: [] as any[], complete: [] as any[] };
  class P extends ProviderCenter {
    override async streamComplete(_p: any, req: any): Promise<any> {
      if (req.model === "deepseek-reasoner") {
        calls.complete.push(req);
        const plan = complete(req);
        req._onChunk({ type: "thinking", text: "推理中…" });
        req._onChunk({ type: "text", text: plan });
        return { text: plan, content: [{ type: "text", text: plan }], usage: { inputTokens: 100, outputTokens: 50 } };
      }
      calls.stream.push(req);
      const text = stream(req, calls.stream.length);
      req._onChunk({ type: "text", text });
      return { text, content: [{ type: "text", text }], usage: { inputTokens: 10, outputTokens: 5 } };
    }
    override async complete(_p: any, req: any): Promise<any> {
      calls.complete.push(req);
      return { text: complete(req) };
    }
  }
  const providers = new P(store);
  providers.addProvider({ kind: "openai-compat", toolMode: "text", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", apiKey: "x", model: "deepseek-chat", isDefault: true });
  store.saveBot(master);
  const rt = new BotRuntime({ store, providers, memory: new MemorySystem(home), skills: new SkillRegistry(join(home, "skills")) });
  return { rt, calls };
}

describe("推理模型先想 → 执行 → 自检", () => {
  test("先用 deepseek-reasoner 想思路并注入上下文，自检不过就修正一次", async () => {
    const { rt, calls } = setup(
      (_req, n) => (n === 1 ? "任务1、任务2" : "任务1、任务2、任务3"),
      (req) => (req.model === "deepseek-reasoner" ? "分三步：数据、PDF、导出" : String(req.user).includes("任务3") ? '{"ok":true}' : '{"ok":false,"issues":["只给了两个任务，要求是三个"]}'),
    );
    const live: string[] = [];
    const r = await rt.handleStream({ bot: master, from: "user", text: "把周报导出 PDF 拆解成 3 个开发任务", sessionId: "s-1" }, { onBlock: (b) => { if (b.type === "thinking") live.push(b.text); } });
    expect(live.join("")).toContain("推理中…");
    expect(calls.complete[0].model).toBe("deepseek-reasoner");
    expect(String(calls.stream[0].user)).toContain("分三步：数据、PDF、导出");
    expect(calls.stream[0].system).not.toContain("分三步");
    expect(calls.stream[1].user).toContain("只给了两个任务");
    expect(r.text).toBe("任务1、任务2、任务3");
    expect(r.content?.[0]).toMatchObject({ type: "thinking", text: "分三步：数据、PDF、导出" });
    expect(r.content?.some((b) => b.type === "text" && b.text === "任务1、任务2")).toBe(false);
  });

  test("闲聊不走推理路线，不多花调用", async () => {
    const { rt, calls } = setup(() => "你好呀", () => "不该被调用");
    const r = await rt.handleStream({ bot: master, from: "user", text: "你好", sessionId: "s-2" }, { onBlock: () => {} });
    expect(r.text).toBe("你好呀");
    expect(calls.complete.length).toBe(0);
  });

  test("工具轮数用完时收尾总结，而不是直接报错", async () => {
    const { rt } = setup(
      () => "```tool\n" + JSON.stringify({ tool: "memory.list", args: {} }) + "\n```",
      (req) => (String(req.system).includes("轮数已经用完") ? "已完成前两步，第三步回复「继续」接着做" : "思路"),
    );
    const r = await rt.handleStream({ bot: master, from: "user", text: "你好", sessionId: "s-3" }, { onBlock: () => {}, maxToolRounds: 2 });
    expect(r.text).toContain("继续");
  });
});
