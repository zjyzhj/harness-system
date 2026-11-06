import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import { MemorySystem } from "../core/memory-system";
import { SkillRegistry } from "../core/skill-registry";
import { BotRuntime } from "../core/bot-runtime";
import { ProviderCenter } from "../core/provider-center";
import { contentText, type Bot } from "../core/types";

// 假 provider：「问翻译」时先输出 bot.ask 工具块，拿到工具结果后整合回复；被问的 bot 直接作答
class ScriptedProvider extends ProviderCenter {
  systems: string[] = [];
  histories: any[][] = [];
  users: string[] = [];
  override async streamComplete(_p: any, req: any): Promise<any> {
    this.systems.push(req.system ?? "");
    this.histories.push(req.history ?? []);
    const user = contentText(req.user ?? "").replace(/^<系统附注[\s\S]*?<\/系统附注>\s*/, "");
    this.users.push(user);
    const toolResult = user.includes("[工具执行返回]") ? user : undefined;
    let text: string;
    if (user.startsWith("[来自")) text = "hello";
    else if (user.includes("[系统检查]")) text = '好，我真的去问\n```tool\n{"tool":"bot.ask","args":{"to":"翻译","message":"你在干嘛"}}\n```';
    else if (user.includes("编一个")) text = "我去问一下翻译助手。翻译助手说它在待命。";
    else if (toolResult) text = `整合：${toolResult}`;
    else if (user.includes("问翻译")) text = '```tool\n{"tool":"bot.ask","args":{"to":"翻译","message":"你好 怎么说"}}\n```';
    else text = "ok";
    req._onChunk({ type: "text", text });
    return { text, content: [{ type: "text", text }] };
  }
}

let home: string;
let store: Store;
let providers: ScriptedProvider;
let runtime: BotRuntime;
const mk = (id: string, name: string, role: string): Bot => ({ id, name, role, persona: `${role}人设`, providerId: "", petEnabled: false, createdAt: Date.now() });

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "harness-team-test-"));
  store = new Store(home);
  providers = new ScriptedProvider(store);
  providers.addProvider({ kind: "openai-compat", toolMode: "text", name: "默认", baseUrl: "https://fake/v1", apiKey: "x", model: "m", isDefault: true });
  store.saveBot(mk("a", "灵感助手", "创意"));
  store.saveBot(mk("b", "翻译助手", "翻译"));
  runtime = new BotRuntime({
    store, providers, memory: new MemorySystem(home), skills: new SkillRegistry(join(home, "skills")),
    askBot: async (from, target, message, depth) => {
      const to = store.listBots().find((x) => x.id !== from.id && x.name.includes(target))!;
      const r = await runtime.handleStream({ bot: to, from: from.id, text: `[来自 ${from.name} 的提问] ${message}`, sessionId: "b2b" }, { depth, onBlock: () => {} });
      return `${to.name} 回复：${r.text}`;
    },
  });
});

afterAll(() => store.close());

describe("bot 团队", () => {
  test("上下文注入团队成员与 bot.ask 用法", async () => {
    providers.systems = [];
    await runtime.handleStream({ bot: store.getBot("a")!, from: "user", text: "当前有几个 bot", sessionId: "s1" }, { onBlock: () => {} });
    const sys = providers.systems[0];
    expect(sys).toContain("共有 2 个 bot");
    expect(sys).toContain("翻译助手（翻译）");
    expect(sys.slice(sys.indexOf("【团队】"))).not.toContain("灵感助手（创意）");
    expect(sys).toContain('"tool":"bot.ask"');
  });

  test("bot.ask 转问另一个 bot 并整合回复", async () => {
    const blocks: any[] = [];
    const r = await runtime.handleStream({ bot: store.getBot("a")!, from: "user", text: "帮我问翻译", sessionId: "s2" }, { onBlock: (b) => blocks.push(b) });
    expect(blocks.some((b) => b.type === "tool_call" && b.tool === "bot.ask" && String(b.result).includes("翻译助手 回复：hello"))).toBe(true);
    expect(r.text).toContain("翻译助手 回复：hello");
  });

  test("声称问过别的 bot 却没调用 bot.ask：同轮直接代跑，不烧检查轮", async () => {
    providers.users = [];
    const blocks: any[] = [];
    const r = await runtime.handleStream({ bot: store.getBot("a")!, from: "user", text: "编一个", sessionId: "s-fake" }, { onBlock: (b) => blocks.push(b) });
    expect(blocks.some((b) => b.type === "tool_call" && b.tool === "bot.ask" && String(b.result).includes("翻译助手 回复：hello"))).toBe(true);
    expect(r.text).not.toContain("待命");
    expect(providers.users.some((u) => u.includes("[系统检查]"))).toBe(false);
  });

  test("用户 @ 了别的 bot：当前 bot 必须用 bot.ask 去找它", async () => {
    const blocks: any[] = [];
    await runtime.handleStream({ bot: store.getBot("a")!, from: "user", text: "@翻译助手 向他问好", sessionId: "s-at" }, { onBlock: (b) => blocks.push(b) });
    expect(blocks.some((b) => b.type === "tool_call" && b.tool === "bot.ask")).toBe(true);
    expect(providers.systems.length).toBeGreaterThan(0);
  });

  test("漏了围栏的单行工具调用也能识别，且不显示给用户", async () => {
    const { parseToolBlocks, stripToolBlocks } = await import("../core/bot-runtime");
    const t = '我去问它。\n{"tool":"bot.ask","args":{"to":"翻译","message":"hi"}}';
    expect(parseToolBlocks(t).map((x) => x.tool)).toEqual(["bot.ask"]);
    expect(stripToolBlocks(t)).toBe("我去问它。");
    expect(parseToolBlocks('配置示例 {"tool": 1} 写在句子里')).toEqual([]);
  });

  test("正文里夹着的裸工具 JSON：句中不执行也不削文案；顶格才解析并剥展示", async () => {
    const { parseToolBlocks, stripToolBlocks } = await import("../core/bot-runtime");
    const inline = '先看终端进度。建议下一步可以：{"tool":"ui.choices","args":{"title":"建议下一步可以","options":[{"label":"甲"},{"label":"乙"},{"label":"丙"}]}}建议下一步可以：';
    expect(parseToolBlocks(inline)).toEqual([]);
    expect(stripToolBlocks(inline)).toBe(inline.trim());
    const lined = '先看终端进度。\n{"tool":"ui.choices","args":{"title":"建议下一步可以","options":[{"label":"甲"},{"label":"乙"}]}}\n建议下一步可以：';
    expect(parseToolBlocks(lined).map((x) => x.tool)).toEqual(["ui.ask"]);
    expect(stripToolBlocks(lined)).not.toContain('"tool"');
    expect(stripToolBlocks(lined)).toContain("先看终端进度。");
  });

  test("句号后漏换行的裸工具 JSON：仍解析并剥展示", async () => {
    const { parseToolBlocks, stripToolBlocks } = await import("../core/bot-runtime");
    const stuck = '记下这套定向取证法，以后写日报优先走它。{"tool":"memory.add","args":{"content":"优先扫会话区","kind":"rule"}}';
    expect(parseToolBlocks(stuck).map((x) => x.tool)).toEqual(["memory.add"]);
    expect(stripToolBlocks(stuck)).toBe("记下这套定向取证法，以后写日报优先走它。");
    expect(stripToolBlocks(stuck)).not.toContain('"tool"');
  });

  test("只是提议去问，不算编造", async () => {
    const rt = (runtime as any).prompt;
    expect(rt.fakedDelegation(store.getBot("a")!, "要不要我去问一下翻译助手？", [])).toBeNull();
    expect(rt.fakedDelegation(store.getBot("a")!, "翻译助手说它在待命。", [])).toBe("翻译助手");
    expect(rt.fakedDelegation(store.getBot("a")!, "翻译助手说它在待命。", [{ id: "1", tool: "bot.ask", args: { to: "翻译" } }])).toBeNull();
  });

  test("声称建好了技能却没调用 skill.save：打回去真的创建", async () => {
    const { claimsSkillWrite } = await import("../core/bot-runtime");
    expect(claimsSkillWrite("建好了：[提审文案](app:skill/appstore-copy)")).toBe(true);
    expect(claimsSkillWrite("要不要我帮你创建一个技能？")).toBe(false);

    class P extends ScriptedProvider {
      override async streamComplete(_p: any, req: any): Promise<any> {
        this.systems.push(req.system ?? "");
        const user = contentText(req.user ?? "").replace(/^<系统附注[\s\S]*?<\/系统附注>\s*/, "");
        let text: string;
        if (user.includes("[系统检查]")) {
          text = '```tool\n{"tool":"skill.save","args":{"name":"提审文案","description":"写 App Store 文案","instructions":"痛点开头"}}\n```';
        } else if (user.includes("[工具执行返回]")) {
          text = "好了，已落盘";
        } else {
          text = "建好了：[App Store 提审文案生成](app:skill/appstore-copy)";
        }
        req._onChunk?.({ type: "text", text });
        return { text, content: [{ type: "text", text }] };
      }
    }
    const providers2 = new P(store);
    providers2.addProvider({ kind: "openai-compat", toolMode: "text", name: "默认", baseUrl: "https://fake/v1", apiKey: "x", model: "m", isDefault: true });
    const home2 = mkdtempSync(join(tmpdir(), "harness-skill-fake-"));
    const { SkillRegistry } = await import("../core/skill-registry");
    const { MemorySystem } = await import("../core/memory-system");
    const skills = new SkillRegistry(join(home2, "skills"));
    const rt = new BotRuntime({
      store, providers: providers2, memory: new MemorySystem(home2), skills,
      // 单测替身：生产由 actionGrounding 模型判决
      judgeAction: async ({ reply, facts }) => {
        if (claimsSkillWrite(reply) && !/skill\.(save|update|delete)/.test(facts)) {
          return { ok: false, issues: ["声称技能已建好，但事实里没有 skill.save"] };
        }
        return { ok: true, issues: [] };
      },
    });
    const blocks: any[] = [];
    await rt.handleStream({ bot: store.getBot("a")!, from: "user", text: "随便创建一个 skill", sessionId: "s-skill-fake" }, { onBlock: (b) => blocks.push(b) });
    expect(blocks.some((b) => b.type === "tool_call" && b.tool === "skill.save")).toBe(true);
    expect(skills.list().some((s) => s.name === "提审文案")).toBe(true);
  });

  test("被转问还可再转一手；第三手才停（防环）", async () => {
    providers.systems = [];
    await runtime.handleStream({ bot: store.getBot("b")!, from: "a", text: "[来自 灵感助手 的提问] hi", sessionId: "s3" }, { depth: 1, onBlock: () => {} });
    expect(providers.systems[0]).toContain("其他成员");
    expect(providers.systems[0]).toContain("直接问它"); // depth 1 仍可 bot.ask（对齐 Grok 协作）
    const orig = providers.streamComplete.bind(providers);
    providers.streamComplete = async (p: any, req: any) => {
      const user = contentText(req.user ?? "");
      if (!user.includes("[工具执行返回]")) {
        const text = '```tool\n{"tool":"bot.ask","args":{"to":"灵感助手","message":"再问一层"}}\n```';
        req._onChunk({ type: "text", text });
        return { text, content: [{ type: "text", text }] };
      }
      return orig(p, req);
    };
    const blocks: any[] = [];
    await runtime.handleStream({ bot: store.getBot("b")!, from: "a", text: "再转", sessionId: "s3b" }, { depth: 2, onBlock: (b) => blocks.push(b) });
    providers.streamComplete = orig;
    const ask = [...blocks].reverse().find((b) => b.type === "tool_call" && b.tool === "bot.ask" && b.result);
    expect(String(ask?.result ?? "")).toContain("转过两手");
  });
});

describe("@ 提及共享会话", () => {
  test("被 @ 的 bot 把其他 bot 的回复当作他人发言，而不是自己的", async () => {
    providers.histories = [];
    const history = [
      { id: 1, sessionId: "s9", from: "user", to: "a", role: "user", content: "写个标题", kind: "chat", createdAt: 1 },
      { id: 2, sessionId: "s9", from: "a", to: "user", role: "assistant", content: "春日来信", kind: "chat", createdAt: 2 },
    ] as any;
    await runtime.handleStream({ bot: store.getBot("b")!, from: "user", text: "@翻译助手 翻成英文", sessionId: "s9", history }, { onBlock: () => {} });
    const h = providers.histories[0].map((m: any) => ({ role: m.role, content: contentText(m.content) }));
    expect(h).toContainEqual({ role: "user", content: "[灵感助手 说] 春日来信" });
    expect(h.some((m: any) => m.role === "assistant")).toBe(false);
  });
});

describe("bot 定时任务工具", () => {
  test("parseRunAt：in 分钟 / HH:mm / 日期字符串", async () => {
    const { parseRunAt } = await import("../core/bot-runtime");
    const now = new Date(2026, 9, 28, 10, 0).getTime();
    expect(parseRunAt({ in: 5 }, now)).toBe(now + 5 * 60_000);
    expect(parseRunAt({ at: "10:30" }, now)).toBe(new Date(2026, 9, 28, 10, 30).getTime());
    expect(parseRunAt({ at: "09:00" }, now)).toBe(new Date(2026, 9, 29, 9, 0).getTime());
    expect(parseRunAt({ at: "2026-10-30 08:15" }, now)).toBe(new Date(2026, 9, 30, 8, 15).getTime());
    expect(parseRunAt({}, now)).toBeNull();
  });

  test("parseRunAt：in 支持 5m / 5分钟 / 1h30m / 90s 等写法", async () => {
    const { parseRunAt } = await import("../core/bot-runtime");
    const now = new Date(2026, 9, 28, 10, 0).getTime();
    expect(parseRunAt({ in: "5m" }, now)).toBe(now + 5 * 60_000);
    expect(parseRunAt({ in: "5分钟" }, now)).toBe(now + 5 * 60_000);
    expect(parseRunAt({ in: "1h30m" }, now)).toBe(now + 90 * 60_000);
    expect(parseRunAt({ in: "2小时" }, now)).toBe(now + 120 * 60_000);
    expect(parseRunAt({ in: "90s" }, now)).toBe(now + 90_000);
    expect(parseRunAt({ in: "10" }, now)).toBe(now + 10 * 60_000);
    expect(parseRunAt({ in: "soon" }, now)).toBeNull();
  });

  test("在会话里创建的任务记住会话，到点能发回原聊天", async () => {
    const { Scheduler } = await import("../core/scheduler");
    const { runTaskTool } = await import("../core/runtime/tool-helpers");
    const sched = new Scheduler(mkdtempSync(join(tmpdir(), "harness-sched-")));
    const out = runTaskTool(sched, { id: "b1", name: "代码助手" } as any, "task.create", { name: "提醒", in: "5m" }, "s-123");
    expect(out.output).toContain("已创建一次性任务");
    expect(out.blocks?.[0]?.type).toBe("routine");
    expect(sched.listForBot("b1")[0].sessionId).toBe("s-123");
  });

  test("一次性任务执行 prompt 后自动删除", async () => {
    const { Scheduler } = await import("../core/scheduler");
    const sched = new Scheduler(mkdtempSync(join(tmpdir(), "harness-sched-")));
    const ran: string[] = [];
    sched.onRun = async (t) => { ran.push(t.prompt ?? ""); };
    const t = sched.create({ botId: "a", name: "一次", prompt: "整理今天的待办", cron: "* * * * *", kind: "once", alarmAt: Date.now() - 1000, runPrompt: true, deleteAfterRun: true });
    await sched.tick();
    expect(ran).toEqual(["整理今天的待办"]);
    expect(sched.list().some((x) => x.id === t.id)).toBe(false);
  });

  test("bot 通过 task.create 工具建任务、task.list 能看到、task.delete 能删", async () => {
    const { Scheduler } = await import("../core/scheduler");
    const sched = new Scheduler(mkdtempSync(join(tmpdir(), "harness-sched-")));
    const rt = new BotRuntime({ store, providers, memory: new MemorySystem(home), skills: new SkillRegistry(join(home, "skills")), tasks: sched });
    const exec = (tool: string, args: Record<string, unknown>) => (rt as any).executeTool(store.getBot("a")!, { callId: "x", tool, args }, "", 0);
    expect((await exec("task.create", { name: "喝水", prompt: "提醒喝水", in: 10 })).output).toContain("执行后自动删除");
    expect((await exec("task.create", { name: "日报", prompt: "写日报", cron: "0 18 * * 1-5" })).output).toContain("创建");
    expect((await exec("task.list", {})).output).toContain("喝水");
    expect((await exec("task.delete", { name: "喝水" })).output).toContain("已删除");
    expect(sched.listForBot("a").map((x) => x.name)).not.toContain("喝水");
  });

  test("task.create / task.delete 触发 Scheduler.onChange，供面板刷新", async () => {
    const { Scheduler } = await import("../core/scheduler");
    const sched = new Scheduler(mkdtempSync(join(tmpdir(), "harness-sched-")));
    let n = 0;
    sched.onChange = () => { n++; };
    const rt = new BotRuntime({ store, providers, memory: new MemorySystem(home), skills: new SkillRegistry(join(home, "skills")), tasks: sched });
    const exec = (tool: string, args: Record<string, unknown>) => (rt as any).executeTool(store.getBot("a")!, { callId: "x", tool, args }, "", 0);
    await exec("task.create", { name: "面板测", prompt: "x", in: 5 });
    await exec("task.delete", { name: "面板测" });
    expect(n).toBe(2);
  });

  test("task.delete 空 key / 过短前缀不会误删", async () => {
    const { Scheduler } = await import("../core/scheduler");
    const { runTaskTool } = await import("../core/runtime/tool-helpers");
    const sched = new Scheduler(mkdtempSync(join(tmpdir(), "harness-sched-")));
    const bot = { id: "b1", name: "代码助手" } as any;
    runTaskTool(sched, bot, "task.create", { name: "留着", prompt: "x", in: 10 });
    expect(runTaskTool(sched, bot, "task.delete", {}).output).toContain("需要 id 或 name");
    expect(runTaskTool(sched, bot, "task.delete", { id: "" }).output).toContain("需要 id 或 name");
    expect(runTaskTool(sched, bot, "task.delete", { id: "ab" }).output).toContain("找不到");
    expect(sched.listForBot("b1")).toHaveLength(1);
  });
});

describe("bot 间会话记录", () => {
  test("被问方的会话记录真实发送方，并触发新消息事件", async () => {
    const seen: any[] = [];
    const off = store.onMessageAdded((m) => seen.push(m));
    await runtime.handleStream({ bot: store.getBot("b")!, from: "a", text: "[来自 灵感助手 的提问] hi", sessionId: "b2b-a-b" }, { depth: 1, onBlock: () => {} });
    off();
    expect(seen.map((m) => [m.from, m.to, m.kind])).toEqual([["a", "b", "bot-to-bot"], ["b", "a", "bot-to-bot"]]);
    expect(typeof seen[0].id).toBe("number");
  });

  test("bot.ask 先推 running 再推结果，最终消息里只保留一次", async () => {
    const blocks: any[] = [];
    const r = await runtime.handleStream({ bot: store.getBot("a")!, from: "user", text: "帮我问翻译", sessionId: "s20" }, { onBlock: (b) => blocks.push(b) });
    const asks = blocks.filter((b) => b.type === "tool_call" && b.tool === "bot.ask");
    expect(asks.map((b) => b.status)).toEqual(["running", "ok"]);
    expect(r.content!.filter((b: any) => b.type === "tool_call")).toHaveLength(1);
  });

  test("相同 to+message 的 bot.ask 短时复用，不二次调用；软失败不缓存", async () => {
    let n = 0;
    const dir = mkdtempSync(join(tmpdir(), "harness-ask-dedupe-"));
    const s = new Store(dir);
    class P extends ProviderCenter {
      override async streamComplete(_p: any, req: any): Promise<any> {
        const u = contentText(req.user ?? "");
        const text = u.includes("[工具执行返回]")
          ? "好了"
          : '```tool\n{"tool":"bot.ask","args":{"to":"翻译","message":"固定原话"}}\n```';
        req._onChunk({ type: "text", text });
        return { text, content: [{ type: "text", text }] };
      }
    }
    const p = new P(s);
    p.addProvider({ kind: "openai-compat", toolMode: "text", name: "默认", baseUrl: "https://fake/v1", apiKey: "x", model: "m", isDefault: true });
    s.saveBot(mk("a", "灵感助手", "创意"));
    s.saveBot(mk("b", "翻译助手", "翻译"));
    let mode: "fail" | "ok" = "fail";
    const rt = new BotRuntime({
      store: s, providers: p, memory: new MemorySystem(dir), skills: new SkillRegistry(join(dir, "skills")),
      askBot: async () => {
        n++;
        if (mode === "fail") return "找不到名为「翻译」的 bot。现有成员：灵感助手";
        return "翻译助手 回复：ok";
      },
    });
    await rt.handleStream({ bot: s.getBot("a")!, from: "user", text: "问一次", sessionId: "dedupe-fail-1" }, { onBlock: () => {} });
    await rt.handleStream({ bot: s.getBot("a")!, from: "user", text: "再问一次同样的", sessionId: "dedupe-fail-2" }, { onBlock: () => {} });
    expect(n).toBe(2); // 软失败不进 recentAsks
    n = 0;
    mode = "ok";
    await rt.handleStream({ bot: s.getBot("a")!, from: "user", text: "问一次", sessionId: "dedupe-1" }, { onBlock: () => {} });
    await rt.handleStream({ bot: s.getBot("a")!, from: "user", text: "再问一次同样的", sessionId: "dedupe-2" }, { onBlock: () => {} });
    expect(n).toBe(1); // 成功结果短时复用
    s.close();
  });

  test("同轮并行两次相同 bot.ask 只打一次 askBot，界面只留一张转问卡", async () => {
    let n = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const dir = mkdtempSync(join(tmpdir(), "harness-ask-parallel-"));
    const s = new Store(dir);
    class P extends ProviderCenter {
      override async streamComplete(_p: any, req: any): Promise<any> {
        const u = contentText(req.user ?? "");
        const text = u.includes("[工具执行返回]")
          ? "好了"
          : '```tool\n{"tool":"bot.ask","args":{"to":"翻译","message":"同一句"}}\n```\n```tool\n{"tool":"bot.ask","args":{"to":"翻译","message":"同一句"}}\n```';
        req._onChunk({ type: "text", text });
        return { text, content: [{ type: "text", text }] };
      }
    }
    const p = new P(s);
    p.addProvider({ kind: "openai-compat", toolMode: "text", name: "默认", baseUrl: "https://fake/v1", apiKey: "x", model: "m", isDefault: true });
    s.saveBot(mk("a", "灵感助手", "创意"));
    s.saveBot(mk("b", "翻译助手", "翻译"));
    const rt = new BotRuntime({
      store: s, providers: p, memory: new MemorySystem(dir), skills: new SkillRegistry(join(dir, "skills")),
      askBot: async () => {
        n++;
        await gate;
        return "翻译助手 回复：ok";
      },
    });
    const blocks: any[] = [];
    const done = rt.handleStream({ bot: s.getBot("a")!, from: "user", text: "并行问", sessionId: "dedupe-p" }, { onBlock: (b) => blocks.push(b) });
    const t0 = Date.now();
    while (n < 1 && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 5));
    // 再让出几拍，确保第二个并行 ask 已挂上 inflight
    await new Promise((r) => setTimeout(r, 20));
    release();
    const r = await done;
    expect(n).toBe(1);
    const askCards = blocks.filter((b) => b.type === "tool_call" && b.tool === "bot.ask");
    expect(askCards.filter((b) => b.status === "running")).toHaveLength(1);
    expect(askCards.filter((b) => b.status === "ok")).toHaveLength(1);
    expect(r.content!.filter((b: any) => b.type === "tool_call" && b.tool === "bot.ask")).toHaveLength(1);
    s.close();
  });
});
