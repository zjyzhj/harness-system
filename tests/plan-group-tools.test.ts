import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import { MemorySystem } from "../core/memory-system";
import { SkillRegistry } from "../core/skill-registry";
import { BotRuntime } from "../core/bot-runtime";
import { ProviderCenter } from "../core/provider-center";
import { GroupRegistry } from "../core/group-registry";
import type { Bot, ContentBlock } from "../core/types";

const tool = (name: string, args: object) => "```tool\n" + JSON.stringify({ tool: name, args }) + "\n```";

function setup(script: string[]) {
  const home = mkdtempSync(join(tmpdir(), "harness-plan-tools-"));
  const store = new Store(home);
  let i = 0;
  class P extends ProviderCenter {
    override async streamComplete(_p: any, req: any): Promise<any> {
      const text = script[Math.min(i++, script.length - 1)];
      req._onChunk({ type: "text", text });
      return { text, content: [{ type: "text", text }] };
    }
  }
  const providers = new P(store);
  providers.addProvider({ kind: "openai-compat", name: "默认", baseUrl: "https://fake/v1", apiKey: "x", model: "m", isDefault: true });
  const mk = (id: string, name: string): Bot => ({ id, name, role: "助手", persona: "", providerId: "", petEnabled: false, createdAt: Date.now() });
  const [a, b, c] = [mk("a", "主控"), mk("b", "写作助手"), mk("c", "翻译助手")];
  [a, b, c].forEach((x) => store.saveBot(x));
  const groups = new GroupRegistry(home);
  const started: any[] = [];
  const plans = {
    start: async (req: any) => { started.push(req); return { title: "调研报告", steps: ["写作助手：调研", "翻译助手：翻译"] }; },
    list: () => [{ id: "p1", title: "调研报告", status: "running" }],
    cancel: (m: string) => (m === "调研报告" ? m : null),
  };
  const rt = new BotRuntime({ store, providers, memory: new MemorySystem(home), skills: new SkillRegistry(join(home, "skills")), groups, plans });
  const result = (r: { content?: ContentBlock[] }, name: string) => (r.content?.find((x) => x.type === "tool_call" && (x as any).tool === name) as any)?.result as string;
  return { rt, a, groups, started, result, store };
}

describe("bot 在聊天里发起编排、管理群聊", () => {
  test("plan.start 带上发起会话，返回已开始而不是结果", async () => {
    const { rt, a, started, result } = setup([tool("plan.start", { stages: [{ bot: "写作助手", prompt: "调研" }, { bot: "翻译助手", prompt: "翻译" }] }), "已经开始了"]);
    const r = await rt.handleStream({ bot: a, from: "user", text: "安排一下", sessionId: "s-1" }, { onBlock: () => {} });
    expect(started[0].sessionId).toBe("s-1");
    expect(started[0].stages.map((x: any) => x.bot)).toEqual(["写作助手", "翻译助手"]);
    expect(result(r, "plan.start")).toContain("已开始编排「调研报告」");
    const g = setup([tool("plan.start", { goal: "中英介绍页", stages: [{ bot: "写作助手", task: "写" }] }), "好"]);
    await g.rt.handleStream({ bot: g.a, from: "user", text: "x", sessionId: "s-9" }, { onBlock: () => {} });
    expect(g.started[0].title).toBe("中英介绍页");
    expect(g.started[0].stages[0].prompt).toBe("写");
  });

  test("无人值守时不能再嵌套发起编排", async () => {
    const { rt, a, started, result } = setup([tool("plan.start", { task: "让写作助手写" }), "好"]);
    const r = await rt.handleStream({ bot: a, from: "orchestrator", text: "x", sessionId: "plan-1" }, { onBlock: () => {}, unattended: true });
    expect(started.length).toBe(0);
    expect(result(r, "plan.start")).toContain("不能再发起编排");
  });

  test("app.updateGroup 加人、移人、改名；不认识的名字直接报错", async () => {
    const { rt, a, groups, result } = setup([
      tool("app.updateGroup", { group: "测试", add: ["翻译助手"], remove: ["写作助手"], rename: "翻译组" }), "改好了",
    ]);
    groups.create("测试", "a", ["a", "b"]);
    const r = await rt.handleStream({ bot: a, from: "user", text: "改群", sessionId: "s-2" }, { onBlock: () => {} });
    expect(result(r, "app.updateGroup")).toContain("翻译组");
    const g = groups.findByName("翻译组")!;
    expect(g.members.sort()).toEqual(["a", "c"]);

    const bad = setup([tool("app.updateGroup", { group: "测试", add: ["不存在"] }), "好"]);
    bad.groups.create("测试", "a", ["a", "b"]);
    const r2 = await bad.rt.handleStream({ bot: bad.a, from: "user", text: "改群", sessionId: "s-3" }, { onBlock: () => {} });
    expect(bad.result(r2, "app.updateGroup")).toContain("找不到 bot：不存在");
  });
});
