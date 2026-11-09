import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import { AgentRegistry } from "../core/agent-registry";
import { MemorySystem } from "../core/memory-system";
import { SkillRegistry, BUILTIN_SKILL_TEMPLATES, parseSkill } from "../core/skill-registry";
import { Scheduler, nextCronTime, isValidCron } from "../core/scheduler";
import { BotRuntime, parseToolBlocks, skillFromText } from "../core/bot-runtime";
import { contentText } from "../core/types";
import { ProviderCenter } from "../core/provider-center";

let home: string;
let store: Store;
let providers: ProviderCenter;
let memory: MemorySystem;
let skills: SkillRegistry;

// 假 provider：返回固定回复，用于测试运行时流程
class FakeProviderCenter extends ProviderCenter {
  lastSystem = "";
  override async complete(p: any, req: any): Promise<any> {
    this.lastSystem = req.system ?? "";
    const user = contentText(req.user ?? "");
    if (user.includes("调用 web-search") || (user.startsWith("执行工具") && user.includes("web-search"))) {
      return { text: "```tool\n{\"tool\":\"skill:web-search\",\"args\":{\"query\":\"最新AI新闻\"}}\n```" };
    }
    return { text: `回复：${req.user ?? ""}`.slice(0, 120) };
  }
  override async streamComplete(p: any, req: any): Promise<any> {
    this.lastSystem = req.system ?? "";
    const user = contentText(req.user ?? "");
    const hasToolResult = user.includes("[工具执行返回]");
    if (!hasToolResult && (user.includes("调用 web-search") || (user.startsWith("执行工具") && user.includes("web-search")))) {
      req._onChunk({ type: "tool_call", tool: "skill:web-search", callId: "c1", args: { query: "最新AI新闻" } });
      return { text: "```tool\n{\"tool\":\"skill:web-search\",\"args\":{\"query\":\"最新AI新闻\"}}\n```", content: [] };
    }
    req._onChunk({ type: "text", text: "你" });
    req._onChunk({ type: "text", text: "好" });
    return { text: "你好", content: [{ type: "text", text: "你好" }], usage: { inputTokens: 11, outputTokens: 2 } };
  }
}

let fake: FakeProviderCenter;
let runtime: BotRuntime;
let reg: AgentRegistry;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "harness-runtime-test-"));
  store = new Store(home);
  providers = new FakeProviderCenter(store);
  memory = new MemorySystem(home);
  skills = new SkillRegistry(join(home, "skills"));
  for (const [k, md] of Object.entries(BUILTIN_SKILL_TEMPLATES)) skills.create(k, md);
  runtime = new BotRuntime({ store, providers, memory, skills });
  reg = new AgentRegistry(store);
  providers.addProvider({ kind: "openai-compat", toolMode: "text", name: "默认", baseUrl: "https://fake/v1", apiKey: "x", model: "gpt-4o-mini", isDefault: true });
});

afterAll(() => store.close());

describe("skill-registry", () => {
  test("SKILL.md frontmatter 解析", () => {
    const s = parseSkill("web-search", "/x/SKILL.md", BUILTIN_SKILL_TEMPLATES["web-search"]);
    expect(s?.name).toBe("网页搜索");
    expect(s?.description).toContain("搜索网页");
    expect(s?.requires).toContain("curl");
    expect(s?.body).toContain("# 网页搜索技能");
  });
  test("工具描述只含 description（渐进披露）", () => {
    const desc = skills.toolDescriptions();
    expect(desc).toContain("web-search");
    expect(desc).not.toContain("curl 请求一个可用的搜索接口"); // body 不泄漏
  });
  test("一句话创建技能", () => {
    const p = skillFromText("创建技能：自动周报，每周五总结本周工作");
    expect(p?.key).toBe("自动周报");
    expect(p?.markdown).toContain("---");
    const s = skills.create(p!.key, p!.markdown);
    expect(s.name).toBe("自动周报");
  });
});

describe("memory-system", () => {
  test("事实记忆持久化 + 检索", () => {
    memory.add("b1", { kind: "fact", content: "用户喜欢简洁的回答", tags: ["偏好"], source: "user" });
    memory.add("b1", { kind: "fact", content: "用户在做 macOS 开发", tags: ["工作"], source: "user" });
    expect(memory.list("b1").length).toBe(2);
    const hits = memory.search("b1", "macOS");
    expect(hits[0].content).toContain("macOS");
    // 重新加载（模拟重启）仍持久
    const mem2 = new MemorySystem(home);
    expect(mem2.list("b1").length).toBe(2);
  });
  test("buildContext 注入记忆", () => {
    const ctx = memory.buildContext("b1", "macOS");
    expect(ctx).toContain("【长期记忆·事实】");
    expect(ctx).toContain("macOS");
  });
});

describe("scheduler", () => {
  test("cron 校验与 next 时间", () => {
    expect(isValidCron("0 9 * * 1")).toBe(true);
    expect(isValidCron("0 9 * *")).toBe(false);
    const next = nextCronTime("0 9 * * *", new Date("2026-10-26T08:00:00").getTime());
    const d = new Date(next);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
  });
  test("创建任务 + tick 触发", async () => {
    const sched = new Scheduler(home);
    const ran: string[] = [];
    sched.onRun = async (t) => { ran.push(t.name); };
    const t = sched.create({ botId: "b1", name: "早报", cron: "*/5 * * * *", prompt: "生成今日早报" });
    expect(t.nextRunAt).toBeGreaterThan(Date.now());
    await sched.tick(t.nextRunAt! + 1);
    expect(ran).toContain("早报");
    expect(sched.list().find((x) => x.id === t.id)?.runCount).toBe(1);
    sched.stop();
  });
});

describe("bot-runtime", () => {
  test("工具调用循环：调用技能 → 最终回复", async () => {
    const bot = await reg.createBotFromText("创建 bot：搜索助手");
    const r = await runtime.handle({ bot, from: "user", text: "请调用 web-search 搜索", sessionId: "s1" });
    expect(r.toolCalls.length).toBeGreaterThan(0);
    expect(r.toolCalls[0].tool).toBe("skill:web-search");
    expect(r.usedSkills).toContain("web-search");
    expect(r.text.length).toBeGreaterThan(0);
  });
  test("无工具时直接回复 + 记忆注入", async () => {
    const bot = await reg.createBotFromText("创建 bot：普通助手");
    const r = await runtime.handle({ bot, from: "user", text: "你好", sessionId: "s2" });
    expect(r.toolCalls.length).toBe(0);
    expect(r.text).toContain("你好");
  });
  test("parseToolBlocks 解析", () => {
    const tools = parseToolBlocks("先查资料\n```tool\n{\"tool\":\"skill:web-search\",\"args\":{\"query\":\"AI\"}}\n```\n然后回答");
    expect(tools.length).toBe(1);
    expect(tools[0].tool).toBe("skill:web-search");
    expect(tools[0].args.query).toBe("AI");
  });
  test("记忆抽取：记住 → fact 入库", async () => {
    const bot = await reg.createBotFromText("创建 bot：记忆助手");
    const r = await runtime.handle({ bot, from: "user", text: "记住：我喜欢喝美式咖啡", sessionId: "s3" });
    expect(r.memoryEvents!.length).toBeGreaterThan(0);
    expect(memory.list("global").some((m) => m.content.includes("美式咖啡"))).toBe(true);
  });
  test("记忆抽取：「我叫什么？」是提问不入库，「我叫小周」记成完整的一句", async () => {
    const bot = await reg.createBotFromText("创建 bot：名字助手");
    await runtime.handle({ bot, from: "user", text: "我叫什么？做什么的？", sessionId: "s3q" });
    expect(memory.list(bot.id)).toEqual([]);
    expect(memory.list("global").some((m) => m.content.includes("什么"))).toBe(false);
    await runtime.handle({ bot, from: "user", text: "我叫小周", sessionId: "s3q" });
    expect(memory.list("global").map((m) => m.content)).toContain("用户叫小周");
  });
});

describe("bot-runtime handleStream（V3 流式 + 富消息）", () => {
  test("流式：增量块回调 + 富消息落盘（含 meta）", async () => {
    const bot = await reg.createBotFromText("创建 bot：流式助手");
    const got: string[] = [];
    const r = await runtime.handleStream(
      { bot, from: "user", text: "调用 web-search 查最新AI新闻", sessionId: "s-stream-1", history: [] },
      { onBlock: (b: any) => got.push(b.type === "text" ? `text:${b.text}` : `tool:${b.tool}`) },
    );
    // 工具回合结束 → 第二轮直接回复
    expect(r.text).toContain("你好");
    // 增量里应看到 tool_call 与 text 块
    expect(got.some((g) => g.startsWith("tool:"))).toBe(true);
    expect(got.some((g) => g.startsWith("text:"))).toBe(true);
    // 富消息落盘：assistant 内容为块数组 + meta
    const msgs = store.listMessages("s-stream-1");
    const asst = msgs.find((m) => m.role === "assistant");
    expect(Array.isArray(asst?.content)).toBe(true);
    expect((asst as any)?.meta?.streamed).toBe(true);
    expect((asst as any)?.meta?.tokensUsed).toBe(13);
  });

  test("流式：用户富内容（图片块）落盘保留", async () => {
    const bot = await reg.createBotFromText("创建 bot：富消息助手");
    const richUser = [{ type: "text", text: "看图说话" }, { type: "image", dataUrl: "data:image/png;base64,AAA" }];
    await runtime.handleStream(
      { bot, from: "user", text: "看图说话", content: richUser as any, sessionId: "s-rich-1", history: [] },
      { onBlock: () => {} },
    );
    const msgs = store.listMessages("s-rich-1");
    const userMsg = msgs.find((m) => m.role === "user");
    expect(Array.isArray(userMsg?.content)).toBe(true);
    expect((userMsg as any)?.content?.some((b: any) => b.type === "image")).toBe(true);
  });
});
