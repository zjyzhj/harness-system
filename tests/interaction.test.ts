import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import { MemorySystem } from "../core/memory-system";
import { SkillRegistry } from "../core/skill-registry";
import { GroupRegistry } from "../core/group-registry";
import { SecretStore } from "../core/secret-store";
import { BotRuntime, uiTool } from "../core/bot-runtime";
import { ProviderCenter } from "../core/provider-center";
import { contentText, type Bot, type ContentBlock } from "../core/types";

const home = mkdtempSync(join(tmpdir(), "harness-interact-"));
const store = new Store(home);
afterAll(() => store.close());
const identity = { encrypt: (v: string) => `x:${v}`, decrypt: (c: string) => c.slice(2) };
const mk = (id: string, name: string): Bot => ({ id, name, role: "助手", persona: "", providerId: "", petEnabled: false, createdAt: Date.now() });
store.saveBot(mk("a", "法务"));
store.saveBot(mk("b", "提审"));
const tool = (name: string, args: object) => "```tool\n" + JSON.stringify({ tool: name, args }) + "\n```";

/** 按轮次脚本回复：scripts[i] 是第 i 次调用模型时的输出 */
class Scripted extends ProviderCenter {
  calls = 0;
  scripts: string[] = [];
  override async streamComplete(_p: any, req: any): Promise<any> {
    const text = this.scripts[this.calls++] ?? "完成";
    req._onChunk({ type: "text", text });
    return { text, content: [{ type: "text", text }] };
  }
}

const skills = new SkillRegistry(join(home, "skills"));
const groups = new GroupRegistry(home);
const secrets = new SecretStore(home, identity);
const providers = new Scripted(store);
providers.addProvider({ kind: "openai-compat", name: "DeepSeek", baseUrl: "https://fake/v1", apiKey: "x", model: "deepseek-chat", isDefault: true });
const changes: string[] = [];
const rt = new BotRuntime({ store, providers, memory: new MemorySystem(home), skills, groups, secrets, workspaceRoot: join(home, "ws"), onAppChanged: (w) => changes.push(w) });
const run = async (scripts: string[], text = "开始", sid = `s-${Math.random()}`, bot = store.getBot("a")!) => {
  providers.calls = 0;
  providers.scripts = scripts;
  const r = await rt.handleStream({ bot, from: "user", text, sessionId: sid }, { onBlock: () => {} });
  return { r, sid, saved: store.listMessages(sid).at(-1)!.content as ContentBlock[] };
};

describe("交互卡片", () => {
  test("system 提示含两级选择卡约定（意图卡 → CLI 卡）", async () => {
    const systems: string[] = [];
    const orig = providers.streamComplete.bind(providers);
    providers.streamComplete = async (p: any, req: any) => {
      systems.push(req.system ?? "");
      return orig(p, req);
    };
    await run(["ok"], "你好");
    providers.streamComplete = orig;
    const sys = systems[0] ?? "";
    expect(sys).toContain("两级选择卡");
    expect(sys).toContain("只看/找文件（不打开终端）");
    expect(sys).toContain("打开终端 shell");
    expect(sys).toContain("进 Coding CLI 改仓库");
    expect(sys).toContain("用 bot 浏览器打开网页");
    expect(sys).toContain("再 ui.ask 一张 CLI 卡");
    expect(sys).toContain("agentCli");
    expect(sys).toContain("不要因为「不在工程名单」就去 MCP");
    expect(sys).toContain("Grok 六段");
  });

  test("ui.ask：旁白 + 选项卡片，本轮结束不再调模型", async () => {
    const { r, saved } = await run([`提审文案有三种出法，你选一个\n${tool("ui.ask", { question: "提审文案怎么出？", options: ["等合进 main", "按草案出并推 Mattermost", "只写 Baserow"] })}`]);
    expect(providers.calls).toBe(1);
    expect(saved.map((b) => b.type)).toEqual(["text", "choice"]);
    const c = saved[1] as Extract<ContentBlock, { type: "choice" }>;
    expect(c.options.length).toBe(3);
    expect(r.text).toBe("提审文案有三种出法，你选一个");
    expect(contentText(saved)).toContain("B. 按草案出并推 Mattermost");
  });

  test("ui.choice 别名静默当成 ui.ask，不出「工具不可用」", async () => {
    const { saved } = await run([`请选\n${tool("ui.choice", { question: "走哪条？", choices: ["甲", "乙"] })}`]);
    expect(providers.calls).toBe(1);
    expect(saved.some((b) => b.type === "choice")).toBe(true);
    const c = saved.find((b) => b.type === "choice") as Extract<ContentBlock, { type: "choice" }>;
    expect(c.options).toEqual(["甲", "乙"]);
    expect(contentText(saved)).not.toContain("不可用");
  });

  test("ui.ask 的选项写成对象时取出文字，不显示 [object Object]", () => {
    const r = uiTool("ui.ask", { question: "出图走哪条路？", options: [{ label: "A", description: "充值后直接出图" }, { text: "写脚本出图" }, "先不出图"] });
    const c = r.blocks![0] as Extract<ContentBlock, { type: "choice" }>;
    expect(c.options).toEqual(["A：充值后直接出图", "写脚本出图", "先不出图"]);
  });

  test("ui.confirm 是 确认/修改/取消；ui.secret 生成密钥卡片", async () => {
    const a = await run([tool("ui.confirm", { action: "上传 10 套正式版到 Baserow", detail: "会覆盖美女截图字段" })]);
    const c = a.saved.find((b) => b.type === "choice") as any;
    expect(c.mode).toBe("confirm");
    expect(c.options).toEqual(["确认", "修改", "取消"]);
    const s = await run([`请在下面填飞书 App Secret\n${tool("ui.secret", { name: "FEISHU_APP_SECRET", label: "飞书机器人 App Secret" })}`]);
    expect(s.saved.at(-1)).toMatchObject({ type: "secret", name: "FEISHU_APP_SECRET", label: "飞书机器人 App Secret" });
  });

  test("用户的选择写回卡片", async () => {
    const { sid, saved } = await run([tool("ui.ask", { question: "选哪个", options: ["甲", "乙"] })]);
    const msg = store.listMessages(sid).at(-1)!;
    const id = (saved.find((b) => b.type === "choice") as any).id;
    store.updateMessage(sid, msg.id!, (m) => ({ ...m, content: (m.content as ContentBlock[]).map((b) => (b.type === "choice" && b.id === id ? { ...b, answer: "乙" } : b)) }));
    const again = new Store(home);
    expect(contentText(again.listMessages(sid).at(-1)!.content)).toContain("用户已选：乙");
    again.close();
  });

  test("强选择话术却没 ui.ask：同轮直接出卡，不烧检查轮", async () => {
    const { r, saved } = await run([
      "提审有三种出法，你选一个：\n1. 等合进 main\n2. 按草案出\n3. 只写 Baserow",
    ]);
    expect(providers.calls).toBe(1);
    expect(saved.some((b) => b.type === "choice")).toBe(true);
    const c = saved.find((b) => b.type === "choice") as Extract<ContentBlock, { type: "choice" }>;
    expect(c.options).toEqual(["等合进 main", "按草案出", "只写 Baserow"]);
    expect(r.content!.some((b: any) => b.type === "choice")).toBe(true);
  });

  test("建议方案枚举：软芯片进 meta.suggestions，不出硬卡", async () => {
    const { sid, saved } = await run([
      "建议下一步可以：\n1. 先核对 skill 边界\n2. 改挂 package lane\n3. 继续只跑工厂产包",
    ]);
    expect(saved.some((b) => b.type === "choice")).toBe(false);
    const msg = store.listMessages(sid).at(-1)!;
    expect(msg.meta?.suggestions).toEqual(["先核对 skill 边界", "改挂 package lane", "继续只跑工厂产包"]);
  });

  test("被转问时不出硬卡纠偏", async () => {
    providers.calls = 0;
    providers.scripts = ["你可以选：\n1. 甲\n2. 乙\n请选择一个"];
    const r = await rt.handleStream(
      { bot: store.getBot("a")!, from: "b", text: "帮我看看", sessionId: "b2b-b-a" },
      { depth: 1, onBlock: () => {} },
    );
    expect(providers.calls).toBe(1);
    expect(r.content?.some((b: any) => b.type === "choice")).toBe(false);
  });
});

describe("边做边说", () => {
  test("每轮旁白和工具卡片按顺序保存，工具块文本不进旁白", async () => {
    const { saved } = await run([`我先看看团队里有谁\n${tool("bot.list", {})}`, "团队里还有提审，我去问问它"]);
    expect(saved.map((b) => b.type)).toEqual(["text", "tool_call", "text"]);
    expect((saved[0] as any).text).toBe("我先看看团队里有谁");
    expect((saved[1] as any).tool).toBe("bot.list");
  });
});

describe("密钥", () => {
  test("{{secret:名字}} 执行时替换、输出打码；缺失时提示用 ui.secret", async () => {
    secrets.set("TOKEN", "sk-very-secret", "测试 token");
    const f = secrets.fill({ url: "https://x/?t={{secret:TOKEN}}", h: ["{{ secret:NOPE }}"] });
    expect(f.args.url).toBe("https://x/?t=sk-very-secret");
    expect(f.missing).toEqual(["NOPE"]);
    expect(secrets.redact("echo sk-very-secret", ["TOKEN"])).toBe("echo ***TOKEN***");
    expect(new SecretStore(home, identity).get("TOKEN")).toBe("sk-very-secret");
    const { saved } = await run([tool("notify", { title: "t", body: "{{secret:MISSING}}" }), "好的"]);
    expect((saved.find((b) => b.type === "tool_call") as any).result).toContain("ui.secret");
    const web = await run([tool("web.fetch", { url: "https://x/?t={{secret:TOKEN}}" }), "好的"]);
    expect((web.saved.find((b) => b.type === "tool_call") as any).result).toContain("不能带");
  });
});

describe("软件现状", () => {
  test("系统提示带群聊等现状，app.state 给完整清单", async () => {
    groups.create("评审组", "user", ["a", "b"]);
    const sys: string[] = [];
    const orig = providers.streamComplete.bind(providers);
    providers.streamComplete = async (p: any, req: any) => { sys.push(req.system); return orig(p, req); };
    const { saved } = await run([tool("app.state", {}), "好"]);
    providers.streamComplete = orig;
    expect(sys[0]).toContain("【软件现状】");
    expect(sys[0]).toContain("[评审组](app:group/");
    expect((saved.find((b) => b.type === "tool_call") as any).result).toContain("评审组");
  });
});

describe("bot 操作软件", () => {
  test("改人设、切模型、建 bot、建群", async () => {
    changes.length = 0;
    await run([tool("app.updateSelf", { persona: "严谨的法务" }), "改好了"]);
    expect(store.getBot("a")!.persona).toBe("严谨的法务");
    await run([tool("app.setModel", { provider: "DeepSeek" }), "切好了"]);
    expect(store.getBot("a")!.providerId).toBe(providers.list()[0].id);
    await run([tool("app.createBot", { name: "设计", role: "出图" }), "建好了"]);
    expect(store.listBots().some((b) => b.name === "设计")).toBe(true);
    await run([tool("app.createGroup", { name: "提审组", members: ["提审", "设计"] }), "建好了"]);
    expect(groups.findByName("提审组")!.members.length).toBe(3);
    expect(changes).toEqual(["bots", "bots", "bots", "groups"]);
  });

  test("私有技能：只有自己看得到、别人删不了；持久化后保留归属和停用状态", async () => {
    await run([tool("skill.save", { name: "商店图规范", description: "生成商店截图时使用", instructions: "# 规范\n- 1320×2868" }), "记住了"]);
    const sk = skills.list().find((x) => x.name === "商店图规范")!;
    expect(sk.owner).toBe("a");
    expect(skills.toolDescriptions("a")).toContain("商店图规范");
    expect(skills.toolDescriptions("b")).not.toContain("商店图规范");
    const { saved } = await run([tool("skill.delete", { key: sk.key }), "好"], "删", undefined, store.getBot("b")!);
    expect((saved.find((b) => b.type === "tool_call") as any).result).toContain("只能删除你自己的");
    skills.setEnabled(sk.key, false);
    const reloaded = new SkillRegistry(join(home, "skills")).get(sk.key)!;
    expect(reloaded).toMatchObject({ owner: "a", enabled: false, name: "商店图规范" });
    expect(reloaded.body).toContain("1320×2868");
  });
});

describe("群聊记忆", () => {
  const mem = () => new MemorySystem(home);
  test("只从用户原话提取；接力回合不提取；群聊不自动记事件；用户事实进全局", async () => {
    const beforeBot = mem().list("b").length;
    const beforeGlobal = mem().list("global").length;
    const bot = store.getBot("b")!;
    const go = async (text: string, reply: string, opts: object) => {
      providers.calls = 0;
      providers.scripts = [reply];
      await rt.handleStream({ bot, from: "user", text, sessionId: "g-mem" }, { onBlock: () => {}, skipUserRecord: true, autoEventMemory: false, ...opts });
    };
    await go("[群聊「组」] 用户说：记住 我喜欢深色模式\n（群聊规则：……很长的规则文字……）", "收到，已经完成", { memoryText: "记住 我喜欢深色模式" });
    await go("[群聊「组」] 法务 在群里点到了你。用户最初说的是：记住 我喜欢深色模式", "好的，搞定", { memoryText: null });
    expect(mem().list("b").slice(beforeBot)).toEqual([]); // 用户事实不进 bot 私有
    expect(mem().list("global").slice(beforeGlobal).map((m) => m.content)).toEqual(["用户喜欢深色模式"]);
  });
});
