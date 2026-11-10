import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemoSkillEngine, isDemoTopic, redactArgs, summarizeResult } from "../core/demo-skill";
import { Store } from "../core/store";
import { MemorySystem } from "../core/memory-system";
import { SkillRegistry } from "../core/skill-registry";
import { Scheduler } from "../core/scheduler";
import { BotRuntime } from "../core/bot-runtime";
import { ProviderCenter } from "../core/provider-center";
import type { Bot } from "../core/types";

describe("DemoSkillEngine", () => {
  test("start / record / finish 生成草稿；密钥打码", () => {
    const eng = new DemoSkillEngine();
    eng.start("b1", { title: "整理日报" });
    expect(eng.isRecording("b1")).toBe(true);
    eng.record("b1", {
      tool: "fs.read",
      args: { path: "/tmp/a.md", apiKey: "sk-secret-should-hide" },
      output: "正文",
    });
    eng.record("b1", {
      tool: "bash.run",
      args: { command: "echo $TOKEN", token: "xoxb-aaaaaaaaaaaaaaaaaaaa" },
      output: "ok",
    });
    // demo.* 与查询类不记
    expect(eng.record("b1", { tool: "demo.status", output: "x" })).toBe(false);
    expect(eng.record("b1", { tool: "app.state", output: "x" })).toBe(false);

    const fin = eng.finish("b1", { name: "整理日报", description: "每天整理日报" });
    expect(fin.ok).toBe(true);
    if (!fin.ok) return;
    expect(fin.draft.steps).toBe(2);
    expect(fin.draft.name).toBe("整理日报");
    expect(fin.draft.body).toContain("fs.read");
    expect(fin.draft.body).toContain("bash.run");
    expect(fin.draft.body).toContain("## 何时使用");
    expect(fin.draft.body).toContain("## 工作步骤");
    expect(fin.draft.body).toContain("## 需要批准");
    expect(fin.draft.body).not.toContain("sk-secret-should-hide");
    expect(JSON.stringify(fin.session.steps[0].args)).toContain("[redacted]");
    expect(eng.isRecording("b1")).toBe(false);
  });

  test("无步骤不能 finish；cancel 清空", () => {
    const eng = new DemoSkillEngine();
    eng.start("b1");
    const empty = eng.finish("b1");
    expect(empty.ok).toBe(false);
    eng.start("b1");
    eng.record("b1", { tool: "web.search", args: { query: "x" }, output: "1" });
    const cancelled = eng.cancel("b1");
    expect(cancelled?.steps.length).toBe(1);
    expect(eng.finish("b1").ok).toBe(false);
  });

  test("isDemoTopic / redact / summarize", () => {
    expect(isDemoTopic("教你一遍这个流程")).toBe(true);
    expect(isDemoTopic("今天天气")).toBe(false);
    expect(redactArgs({ password: "p", ok: 1 }).password).toBe("[redacted]");
    expect(summarizeResult("a".repeat(400)).length).toBeLessThan(300);
  });
});

describe("Runtime demo.* → 技能 + 定时", () => {
  const tool = (name: string, args: object = {}) => "```tool\n" + JSON.stringify({ tool: name, args }) + "\n```";

  function setup(script: string[]) {
    const home = mkdtempSync(join(tmpdir(), "harness-demo-"));
    const store = new Store(home);
    let i = 0;
    class P extends ProviderCenter {
      override async streamComplete(_p: any, req: any): Promise<any> {
        const text = script[Math.min(i++, script.length - 1)];
        req._onChunk?.({ type: "text", text });
        return { text, content: [{ type: "text", text }] };
      }
    }
    const providers = new P(store);
    providers.addProvider({ kind: "openai-compat", name: "默认", baseUrl: "https://fake/v1", apiKey: "x", model: "m", isDefault: true });
    const bot: Bot = { id: "a", name: "助手", role: "助手", persona: "", providerId: "", petEnabled: false, createdAt: 1 };
    store.saveBot(bot);
    const skills = new SkillRegistry(join(home, "skills"));
    const tasks = new Scheduler(home);
    const demo = new DemoSkillEngine();
    const rt = new BotRuntime({
      store,
      providers,
      memory: new MemorySystem(home),
      skills,
      tasks,
      demo,
    });
    return { rt, bot, skills, tasks, demo };
  }

  test("demo.start 后工具被录制，finish 落盘技能并可挂 once 任务", async () => {
    const { rt, bot, skills, tasks, demo } = setup(["好"]);

    await rt.toolRegistry().run({ bot, tool: "demo.start", args: { title: "读改通知" }, originalText: "", depth: 0 });
    expect(demo.isRecording(bot.id)).toBe(true);

    // 模拟 executeTool 钩子写入的步骤
    demo.record(bot.id, { tool: "fs.list", args: { path: "/tmp" }, output: "a.txt" });
    demo.record(bot.id, { tool: "notify", args: { title: "好了" }, output: "已通知" });

    const out = await rt.toolRegistry().run({
      bot,
      tool: "demo.finish",
      args: { name: "读改通知", description: "演示流程", in: "30m" },
      originalText: "",
      depth: 0,
      sessionId: "s-demo-1",
    });
    expect(out.output).toContain("app:skill/");
    expect(out.output).toMatch(/重跑|定时|一次性/);
    const saved = skills.list().find((s) => s.name === "读改通知");
    expect(saved).toBeTruthy();
    expect(saved!.body).toContain("fs.list");
    expect(saved!.owner).toBe(bot.id);
    expect(tasks.listForBot(bot.id).some((t) => t.name.includes("读改通知"))).toBe(true);
    expect(demo.isRecording(bot.id)).toBe(false);
  });

  test("executeTool 钩子会把非 demo 工具写入录制", async () => {
    const { rt, bot, demo } = setup([
      tool("web.search", { query: "harness" }),
      "搜完了",
    ]);
    demo.start(bot.id, { title: "搜一下" });
    await rt.handleStream(
      { bot, from: "user", text: "教你搜", sessionId: "s-demo-hook" },
      { onBlock: () => {} },
    );
    const s = demo.status(bot.id);
    expect(s?.steps.some((x) => x.tool === "web.search")).toBe(true);
  });

  test("未注入 demo 时无 demo.* 工具", () => {
    const home = mkdtempSync(join(tmpdir(), "harness-demo-off-"));
    const store = new Store(home);
    const providers = new ProviderCenter(store);
    providers.addProvider({ kind: "openai-compat", name: "默认", baseUrl: "https://fake/v1", apiKey: "x", model: "m", isDefault: true });
    const rt = new BotRuntime({
      store,
      providers,
      memory: new MemorySystem(home),
      skills: new SkillRegistry(join(home, "skills")),
    });
    expect(rt.toolRegistry().has("demo.start")).toBe(false);
  });
});
