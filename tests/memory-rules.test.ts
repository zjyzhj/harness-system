import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import { MemorySystem } from "../core/memory-system";
import { SkillRegistry } from "../core/skill-registry";
import { BotRuntime, CLAIMS_SAVED, isDuplicateRule, memoryFromText, rulesWhereabouts } from "../core/bot-runtime";
import { ProviderCenter } from "../core/provider-center";
import type { Bot, ContentBlock } from "../core/types";

describe("从用户原话识别要记的东西", () => {
  test("定规范 / 以后 / 从现在起 → 规范；记住我… / 我叫 → 事实", () => {
    expect(memoryFromText("定下规范：你是主控")).toEqual([{ kind: "rule", scope: "bot", content: "用户定下的规范：你是主控" }]);
    expect(memoryFromText("以后都先给结论再展开")[0]).toMatchObject({ kind: "rule" });
    expect(memoryFromText("从现在起所有助手都用中文回答")[0]).toMatchObject({ kind: "rule", scope: "all" });
    expect(memoryFromText("记住：我喜欢喝美式")).toEqual([{ kind: "fact", scope: "all", content: "用户喜欢喝美式" }]);
    expect(memoryFromText("好，帮我记住：回复别超过三段")[0]).toMatchObject({ kind: "rule", content: "回复别超过三段" });
    expect(memoryFromText("我叫小周")[0]).toMatchObject({ kind: "fact", scope: "all", content: "用户叫小周" });
  });

  test("「以后 / 从现在开始」用在一次性的话里不算规范", () => {
    expect(memoryFromText("以后再说吧")).toEqual([]);
    expect(memoryFromText("从现在开始帮我查天气")).toEqual([]);
    expect(memoryFromText("以后有空聊")).toEqual([]);
    expect(memoryFromText("以后回复不要超过三段")[0]).toMatchObject({ kind: "rule" });
  });

  test("同一句话再记一次不会多一条；只合并完全相同的，意思相反的不合并", () => {
    const m = new MemorySystem(mkdtempSync(join(tmpdir(), "harness-dedupe-")));
    m.add("b", { kind: "rule", content: "回复用中文" });
    m.add("b", { kind: "rule", content: "回复用中文。" });
    m.add("b", { kind: "rule", content: "回复不要用中文" });
    expect(m.list("b").length).toBe(2);
    expect(m.mergeDuplicate("b")).toBe(0);
    expect(m.list("b").at(-1)!.content).toBe("回复不要用中文");
    expect(m.buildContext("b")).toContain("以靠后的为准");
  });

  test("容量淘汰不删规范", () => {
    const m = new MemorySystem(mkdtempSync(join(tmpdir(), "harness-evict-")));
    m.add("b", { kind: "rule", content: "规范一" });
    for (let i = 0; i < 5; i++) m.add("b", { kind: "note", content: `笔记${i}` });
    m.evict("b", 2);
    expect(m.list("b").some((e) => e.content === "规范一")).toBe(true);
    expect(m.list("b").length).toBe(2);
  });

  test("规范去重：带否定和不带否定的是相反要求，不算重复", () => {
    expect(isDuplicateRule("人物不要用渐隐", "- 人物用渐隐\n")).toBe(false);
    expect(isDuplicateRule("人物用渐隐过渡", "- 人物用渐隐过渡。\n")).toBe(true);
  });

  test("提问和普通请求不记", () => {
    expect(memoryFromText("我叫什么？")).toEqual([]);
    expect(memoryFromText("你还记住什么吗？")).toEqual([]);
    expect(memoryFromText("帮我写一份周报")).toEqual([]);
    expect(memoryFromText("要求你帮我写一篇文章")).toEqual([]);
    expect(memoryFromText("规范有哪些？")).toEqual([]);
  });

  test("「规范：…」「加一条规则：…」「每次回复…」也算规范", () => {
    expect(memoryFromText("规范：最后收尾加一个表情")[0]).toMatchObject({ kind: "rule", content: "用户定下的规范：最后收尾加一个表情" });
    expect(memoryFromText("加一条规则：先给结论")[0]).toMatchObject({ kind: "rule" });
    expect(memoryFromText("要求：回答不超过三段")[0]).toMatchObject({ kind: "rule" });
    expect(memoryFromText("每次回复都用中文")[0]).toMatchObject({ kind: "rule", content: "用户定下的规范：每次回复都用中文" });
  });

  test("回复里说「规范已加上」也算声称记下了", () => {
    expect(CLAIMS_SAVED.test("好的，规范已加上：每次回复最后收一个表情")).toBe(true);
    expect(CLAIMS_SAVED.test("已添加这条规则")).toBe(true);
    expect(CLAIMS_SAVED.test("当前规范如下：1. 我是主控")).toBe(false);
  });
});

describe("规范存放位置", () => {
  test("给出记忆规范链接（用 bot id，重名也不会打开错）和写了规范的技能链接", () => {
    const b = { id: "b-1", name: "灵感助手" } as Bot;
    const text = rulesWhereabouts(b, [
      { key: "mine", name: "我的技能", owner: "b-1", body: "# x" },
      { key: "shared-ruled", name: "共享带规范", body: "# y\n\n## 用户补充的规范（与上文冲突时以这里为准）\n- a" },
      { key: "shared-plain", name: "共享普通", body: "# z" },
      { key: "others", name: "别人的", owner: "b-2", body: "# w" },
    ], { own: ["你是主控", "收尾加一个表情"], shared: [] });
    expect(text).toContain("[灵感助手 的规范](app:memory/b-1/rule)，共 2 条");
    expect(text).toContain("2. 收尾加一个表情");
    expect(text).toContain("共 0 条");
    expect(text).toContain("[我的技能](app:skill/mine)");
    expect(text).toContain("[共享带规范](app:skill/shared-ruled)");
    expect(text).not.toContain("shared-plain");
    expect(text).not.toContain("others");
  });

  test("主控能看到其他 bot 的私有规范，不会误说「它没有」", () => {
    const b = { id: "master", name: "灵感助手" } as Bot;
    const text = rulesWhereabouts(b, [], {
      own: ["你是主控"],
      shared: [],
      teammates: [
        { name: "飞书机器人", id: "feishu", rules: ["用户确认：我是「飞书机器人」，对外身份固定为飞书机器人，不要自称其他名字。"] },
        { name: "代码助手", id: "code", rules: [] },
      ],
    });
    expect(text).toContain("其他 bot 各自的私有规范");
    expect(text).toContain("[飞书机器人 的规范](app:memory/feishu/rule)，共 1 条");
    expect(text).toContain("对外身份固定为飞书机器人");
    expect(text).toContain("[代码助手 的规范](app:memory/code/rule)：0 条");
    expect(text).toContain("memory.list");
  });
});

describe("规范常驻注入", () => {
  test("规范全部注入，不会被事实挤掉；无关的事件不进「相关记忆」", () => {
    const mem = new MemorySystem(mkdtempSync(join(tmpdir(), "harness-mem-")));
    mem.add("b", { kind: "rule", content: "你是主控，负责拆解和分派任务" });
    for (let i = 0; i < 30; i++) mem.add("b", { kind: "fact", content: `用户事实 ${i} 号` });
    mem.add("b", { kind: "event", content: "图片生成失败，账号额度不足" });
    mem.add("global", { kind: "rule", content: "所有回答用中文" });
    const ctx = mem.buildContext("b", "帮我写周报");
    expect(ctx).toContain("你是主控");
    expect(ctx).toContain("所有回答用中文");
    expect(ctx).not.toContain("额度不足");
    expect(mem.buildContext("b", "图片生成怎么又失败了")).toContain("额度不足");
  });
});

describe("说记住就真的记住", () => {
  const home = mkdtempSync(join(tmpdir(), "harness-mem-rt-"));
  const store = new Store(home);
  afterAll(() => store.close());
  const bot: Bot = { id: "m", name: "主控", role: "通用", persona: "", providerId: "", petEnabled: false, createdAt: Date.now() };
  store.saveBot(bot);

  const make = (reply: (req: any) => string, extract = "[]") => {
    const seen: { stream: number; complete: number } = { stream: 0, complete: 0 };
    class P extends ProviderCenter {
      override async streamComplete(_p: any, req: any): Promise<any> {
        seen.stream++;
        const text = reply(req);
        req._onChunk({ type: "text", text });
        return { text };
      }
      override async complete(): Promise<any> {
        seen.complete++;
        return { text: extract };
      }
    }
    const providers = new P(store);
    providers.addProvider({ kind: "openai-compat", name: "默认", baseUrl: "https://fake/v1", apiKey: "x", model: "m", isDefault: true });
    const memory = new MemorySystem(home);
    const rt = new BotRuntime({ store, providers, memory, skills: new SkillRegistry(join(home, "skills")) });
    return { rt, memory, seen };
  };

  test("「定下规范：你是主控」落盘为规范，回复里出现「已记住」卡片，下一轮注入系统提示", async () => {
    let lastSystem = "";
    const { rt, memory } = make((req) => { lastSystem = req.system; return "收到，规范我记下了"; });
    const blocks: ContentBlock[] = [];
    const r = await rt.handleStream({ bot, from: "user", text: "定下规范：你是主控", sessionId: "s1" }, { onBlock: (b) => blocks.push(b) });
    expect(memory.list("m").map((e) => [e.kind, e.content])).toContainEqual(["rule", "用户定下的规范：你是主控"]);
    expect(r.content?.some((b) => b.type === "tool_call" && b.tool === "memory.add")).toBe(true);
    await rt.handleStream({ bot, from: "user", text: "今天做什么", sessionId: "s1" }, { onBlock: () => {} });
    expect(lastSystem).toContain("你是主控");
  });

  test("没有明说「记住」但 bot 声称记下了：请模型抽取后落盘", async () => {
    const { rt, memory, seen } = make(() => "好的，我记住了", '[{"kind":"rule","scope":"bot","content":"写文案时先给三个标题备选"}]');
    await rt.handleStream({ bot, from: "user", text: "写文案时你先给我三个标题备选，我挑", sessionId: "s2" }, { onBlock: () => {} });
    expect(seen.complete).toBe(1);
    expect(memory.list("m").some((e) => e.content === "写文案时先给三个标题备选")).toBe(true);
  });

  test("bot 自己调了 memory.add 就不重复记", async () => {
    let n = 0;
    const { rt, memory } = make((req) => (n++ === 0
      ? '```tool\n{"tool":"memory.add","args":{"content":"回复别超过三段","kind":"rule"}}\n```'
      : "记下了"));
    const before = memory.list("m").length;
    await rt.handleStream({ bot, from: "user", text: "以后回复别超过三段", sessionId: "s3" }, { onBlock: () => {} });
    const added = memory.list("m").slice(before);
    expect(added.map((e) => [e.kind, e.content])).toEqual([["rule", "回复别超过三段"]]);
  });

  test("规范写进对应技能：追加到固定小节、可替换冲突旧规则，不再重复记到记忆里", async () => {
    const skills = new SkillRegistry(join(home, "skills"));
    const sk = skills.save({ name: "商店图规范", description: "生成 App Store 商店图时使用", body: "# 商店图\n- 档位：高档偏保守\n- 人物可以缩小以避开界面\n", owner: "m" });
    let n = 0;
    const call = JSON.stringify({ tool: "skill.update", args: { key: sk.key, replace: [{ find: "高档偏保守", with: "高档在 4+ 范围内尽量大胆" }, { find: "不存在的原文", with: "x" }], append: ["人物宁大勿小", "人物在画布边缘自然出画，不用生硬渐隐"] } });
    const { rt, memory } = make(() => (n++ === 0 ? "我把这三条写进技能。\n```tool\n" + call + "\n```" : "三条都已经写进规范了"));
    const before = memory.list("m").length;
    const r = await rt.handleStream({ bot, from: "user", text: "需要更新规范要求：高档就该大胆一点；人物偏小；以后人物自然出画", sessionId: "s5" }, { onBlock: () => {} });
    const body = new SkillRegistry(join(home, "skills")).get(sk.key)!.body;
    expect(body).toContain("高档在 4+ 范围内尽量大胆");
    expect(body).not.toContain("高档偏保守");
    expect(body).toContain("## 用户补充的规范");
    expect(body).toContain("- 人物宁大勿小");
    const card = r.content?.find((b) => b.type === "tool_call" && b.tool === "skill.update") as any;
    expect(card.result).toContain(`(app:skill/${sk.key})`);
    expect(card.result).toContain("没找到");
    expect(memory.list("m").length).toBe(before);
  });

  test("同一条规范既 replace 又 append 时不重复追加", async () => {
    const skills = new SkillRegistry(join(home, "skills"));
    const sk = skills.save({ name: "出画", description: "x", body: "# x\n- 人物边缘用渐隐过渡到背景。\n", owner: "m" });
    let n = 0;
    const call = JSON.stringify({ tool: "skill.update", args: { key: sk.key, replace: [{ find: "人物边缘用渐隐过渡到背景。", with: "人物自然出画，不要用生硬的渐隐过渡。" }], append: ["人物自然出画，不要用生硬的渐隐过渡", "背景用品牌主色"] } });
    const { rt } = make(() => (n++ === 0 ? "```tool\n" + call + "\n```" : "好"));
    const r = await rt.handleStream({ bot, from: "user", text: "以后人物自然出画", sessionId: "s7" }, { onBlock: () => {} });
    const body = new SkillRegistry(join(home, "skills")).get(sk.key)!.body;
    expect(body.match(/自然出画/g)!.length).toBe(1);
    expect(body).toContain("- 背景用品牌主色");
    expect((r.content?.find((b) => b.type === "tool_call") as any).result).toContain("1 条和已有内容重复");
  });

  test("bot 没存、反而弹选项问存哪里：这一轮结束前照样把规范存下", async () => {
    const ask = JSON.stringify({ tool: "ui.ask", args: { question: "存到哪一层？", options: ["只给我", "所有 bot"] } });
    const { rt, memory } = make(() => "好的，我记下这条规范。\n```tool\n" + ask + "\n```");
    const r = await rt.handleStream({ bot, from: "user", text: "规范：最后收尾加一个表情", sessionId: "s8" }, { onBlock: () => {} });
    expect(memory.list("m").some((e) => e.kind === "rule" && e.content.includes("收尾加一个表情"))).toBe(true);
    expect((r.content?.find((b) => b.type === "tool_call" && b.tool === "memory.add") as any).result).toContain("(app:memory/m/rule)");
  });

  test("别的 bot 的私有技能改不了", async () => {
    const skills = new SkillRegistry(join(home, "skills"));
    const sk = skills.save({ name: "别人的技能", description: "x", body: "# x\n", owner: "other" });
    let n = 0;
    const { rt } = make(() => (n++ === 0 ? "```tool\n" + JSON.stringify({ tool: "skill.update", args: { key: sk.key, append: ["y"] } }) + "\n```" : "好"));
    const r = await rt.handleStream({ bot, from: "user", text: "改一下", sessionId: "s6" }, { onBlock: () => {} });
    expect((r.content?.find((b) => b.type === "tool_call") as any).result).toContain("❌");
    expect(new SkillRegistry(join(home, "skills")).get(sk.key)!.body).toBe(sk.body);
  });

  test("模型判断没什么要记（[]）时不硬记原话；模型调用失败才兜底", async () => {
    const { rt, memory } = make(() => "好的，我记住了", "[]");
    const before = memory.list("m").length;
    await rt.handleStream({ bot, from: "user", text: "这次先这样，明天再看", sessionId: "s9" }, { onBlock: () => {} });
    expect(memory.list("m").length).toBe(before);
  });

  test("memory.update 改原来那条、memory.forget 删掉，match 不唯一时让 bot 写具体", async () => {
    const { memory } = make(() => "");
    memory.add("m", { kind: "rule", content: "用户定下的规范：回复用中文" });
    memory.add("m", { kind: "rule", content: "用户定下的规范：回复带一个表情" });
    let n = 0;
    const calls = [
      { tool: "memory.update", args: { match: "回复", content: "x" } },
      { tool: "memory.update", args: { match: "用中文", content: "用户定下的规范：回复用英文" } },
      { tool: "memory.forget", args: { match: "回复带一个表情" } },
    ];
    const { rt } = make(() => (n < calls.length ? "```tool\n" + JSON.stringify(calls[n++]) + "\n```" : "好"));
    const r = await rt.handleStream({ bot, from: "user", text: "改成英文，表情不用了", sessionId: "s10" }, { onBlock: () => {} });
    const results = (r.content ?? []).filter((b) => b.type === "tool_call").map((b: any) => b.result as string);
    expect(results[0]).toContain("条都包含");
    expect(results[1]).toContain("已修改");
    expect(results[2]).toContain("已删除");
    const rules = new MemorySystem(home).list("m").filter((e) => e.kind === "rule").map((e) => e.content);
    expect(rules).toContain("用户定下的规范：回复用英文");
    expect(rules.some((c) => c.includes("用中文") || c.includes("回复带一个表情"))).toBe(false);
  });

  test("系统提示里每条规范只出现一次", async () => {
    let sys = "";
    const { rt, memory } = make((req) => { sys = req.system; return "好"; });
    memory.add("m", { kind: "rule", content: "独一无二的规范XYZ" });
    await rt.handleStream({ bot, from: "user", text: "你好", sessionId: "s11" }, { onBlock: () => {} });
    expect(sys.split("独一无二的规范XYZ").length - 1).toBe(1);
    expect(sys).toContain("必须遵守的规范");
  });

  test("改共享技能要用户确认；拒绝就不写", async () => {
    const skills = new SkillRegistry(join(home, "skills"));
    const sk = skills.save({ name: "共享写作", description: "x", body: "# x\n- 旧\n" });
    const asked: string[] = [];
    const consent = { request: async (_b: string, cap: string, desc: string) => { asked.push(`${cap}|${desc}`); return { granted: false }; } };
    let n = 0;
    const { memory } = make(() => "");
    class P extends ProviderCenter {
      override async streamComplete(_p: any, req: any): Promise<any> {
        const text = n++ === 0 ? "```tool\n" + JSON.stringify({ tool: "skill.update", args: { key: sk.key, append: ["新规范 $& 不会被替换"] } }) + "\n```" : "好";
        req._onChunk({ type: "text", text });
        return { text };
      }
      override async complete(): Promise<any> { return { text: "[]" }; }
    }
    const providers = new P(store);
    const rt = new BotRuntime({ store, providers, memory, skills: new SkillRegistry(join(home, "skills")), consent: consent as never });
    const r = await rt.handleStream({ bot, from: "user", text: "加一条", sessionId: "s12" }, { onBlock: () => {} });
    expect(asked[0]).toStartWith("skill:shared|修改共享技能「共享写作」");
    expect((r.content?.find((b) => b.type === "tool_call") as any).result).toContain("没有批准");
    expect(new SkillRegistry(join(home, "skills")).get(sk.key)!.body).toBe(sk.body);
  });

  test("普通回复里出现「完成 / 成功」不再自动记成事件", async () => {
    const { rt, memory } = make(() => "已经完成，上传成功");
    const before = memory.list("m").length;
    await rt.handleStream({ bot, from: "user", text: "上传一下", sessionId: "s4" }, { onBlock: () => {} });
    expect(memory.list("m").length).toBe(before);
  });
});

describe("跨 bot 规范可见", () => {
  test("系统提示带上其他 bot 的私有规范；memory.list 能按名字列出", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-xbot-"));
    const store = new Store(home);
    const memory = new MemorySystem(home);
    const master: Bot = { id: "master", name: "灵感助手", role: "主控", persona: "", providerId: "", petEnabled: false, isMaster: true, createdAt: 1 };
    const feishu: Bot = { id: "feishu", name: "飞书机器人", role: "机器人", persona: "", providerId: "", petEnabled: false, createdAt: 2 };
    store.saveBot(master);
    store.saveBot(feishu);
    memory.add("feishu", { kind: "rule", content: "用户确认：我是「飞书机器人」，对外身份固定为飞书机器人，不要自称其他名字。" });
    const rt = new BotRuntime({
      store,
      providers: new ProviderCenter(store),
      memory,
      skills: new SkillRegistry(join(home, "skills")),
    });
    const ctx = (rt as any).prompt.buildContext(master, "飞书机器人有规范吗");
    expect(ctx).toContain("[飞书机器人 的规范](app:memory/feishu/rule)，共 1 条");
    expect(ctx).toContain("对外身份固定为飞书机器人");

    const listed = await (rt as any).executeBuiltin(master, { tool: "memory.list", args: { bot: "飞书机器人", kind: "rule" } }, "", 0, "s-x");
    expect(listed.output).toContain("共 1 条");
    expect(listed.output).toContain("对外身份固定为飞书机器人");
    expect(listed.output).toContain("app:memory/feishu/rule");

    const state = await (rt as any).appTool(master, "app.state", {});
    expect(state.output).toContain("飞书机器人");
    expect(state.output).toContain("规范 1 条");
  });

  test("主控能用 memory.add bot= 直接给其他 bot 写规范", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-xbot-write-"));
    const store = new Store(home);
    const memory = new MemorySystem(home);
    const master: Bot = { id: "master", name: "灵感助手", role: "主控", persona: "", providerId: "", petEnabled: false, isMaster: true, createdAt: 1 };
    const feishu: Bot = { id: "feishu", name: "飞书机器人", role: "机器人", persona: "", providerId: "", petEnabled: false, createdAt: 2 };
    store.saveBot(master);
    store.saveBot(feishu);
    const rt = new BotRuntime({
      store,
      providers: new ProviderCenter(store),
      memory,
      skills: new SkillRegistry(join(home, "skills")),
    });
    const added = await (rt as any).executeBuiltin(master, {
      tool: "memory.add",
      args: { bot: "飞书机器人", kind: "rule", content: "对外身份固定为飞书机器人" },
    }, "", 0, "s-w");
    expect(added.output).toContain("写给 飞书机器人");
    expect(added.output).toContain("app:memory/feishu/rule");
    expect(memory.list("feishu").some((e) => e.content.includes("对外身份固定"))).toBe(true);
    expect(memory.list("master")).toEqual([]);
  });
});
