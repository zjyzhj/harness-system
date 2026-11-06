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
  const home = mkdtempSync(join(tmpdir(), "harness-group-tools-"));
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
  const rt = new BotRuntime({ store, providers, memory: new MemorySystem(home), skills: new SkillRegistry(join(home, "skills")), groups });
  const result = (r: { content?: ContentBlock[] }, name: string) => (r.content?.find((x) => x.type === "tool_call" && (x as any).tool === name) as any)?.result as string;
  return { rt, a, groups, result, store };
}

describe("bot 在聊天里管理群聊", () => {
  test("plan.* 已下线，返回引导而不是未知工具", async () => {
    const { rt, a, result } = setup([tool("plan.start", { task: "让写作助手写" }), "好"]);
    const r = await rt.handleStream({ bot: a, from: "user", text: "编排一下", sessionId: "s-plan" }, { onBlock: () => {} });
    expect(result(r, "plan.start")).toContain("编排已下线");
    expect(result(r, "plan.start")).toContain("bot.ask");
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
