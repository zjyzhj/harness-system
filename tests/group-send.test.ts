import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import { MemorySystem } from "../core/memory-system";
import { SkillRegistry } from "../core/skill-registry";
import { BotRuntime, claimsGroupSend } from "../core/bot-runtime";
import { ProviderCenter } from "../core/provider-center";
import { GroupRegistry } from "../core/group-registry";
import { GroupSessionRunner } from "../core/group-session";
import { contentText, type Bot, type ContentBlock } from "../core/types";

const bot: Bot = { id: "a", name: "灵感助手", role: "主控", persona: "", providerId: "", petEnabled: false, createdAt: 1, isMaster: true };

function setup(reply: (user: string, n: number) => string) {
  const home = mkdtempSync(join(tmpdir(), "harness-group-send-"));
  const store = new Store(home);
  let n = 0;
  class P extends ProviderCenter {
    override async streamComplete(_p: any, req: any): Promise<any> {
      const text = reply(contentText(req.user ?? ""), n++);
      req._onChunk({ type: "text", text });
      return { text, content: [{ type: "text", text }] };
    }
  }
  const providers = new P(store);
  providers.addProvider({ kind: "openai-compat", toolMode: "text", name: "DS", baseUrl: "https://fake/v1", apiKey: "x", model: "deepseek-chat", isDefault: true });
  store.saveBot(bot);
  const posted: { group: string; message: string }[] = [];
  const rt = new BotRuntime({
    store, providers, memory: new MemorySystem(home), skills: new SkillRegistry(join(home, "skills")),
    groupPost: async (_from, group, message) => {
      if (group !== "测试") return { ok: false as const, error: "没有这个群" };
      posted.push({ group, message });
      return { ok: true as const, group, replies: [{ name: "写作助手", text: "收到，欢迎！" }], reason: "没有人再被点名" };
    },
  });
  return { rt, posted };
}

const send = (group: string, message: string) => "```tool\n" + JSON.stringify({ tool: "group.send", args: { group, message } }) + "\n```";

describe("bot 在群里发言，成员真的回应", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-group-post-"));
  const store = new Store(dir);
  const groups = new GroupRegistry(dir);
  const mk = (id: string, name: string): Bot => ({ id, name, role: "", persona: "", providerId: "", petEnabled: false, createdAt: 0 });
  [mk("m", "灵感助手"), mk("w", "写作助手"), mk("t", "翻译助手")].forEach((b) => store.saveBot(b));
  const g = groups.create("测试", "user", ["m", "w", "t"]);
  const spoken: string[] = [];
  const runtime = {
    handleStream: async (req: { bot: Bot; text: string; sessionId: string }, opts: { onBlock: (b: ContentBlock) => void }) => {
      spoken.push(req.bot.id);
      const text = req.bot.id === "w" ? "收到，我是写作助手" : "收到，我是翻译助手";
      opts.onBlock({ type: "text", text });
      store.addMessage({ sessionId: req.sessionId, from: req.bot.id, to: "user", role: "assistant", content: text, kind: "chat", createdAt: Date.now() });
      return { text, content: [{ type: "text", text }] };
    },
  };
  const runner = new GroupSessionRunner({ store, groups, runtime: runtime as any, providers: new ProviderCenter(store) });
  const hooks = { onProgress: () => {}, onStream: () => {}, setRunning: () => {}, setIdle: () => {} };

  test("没 @ 人：其他成员各回一次，回复写进群聊并带回给发言者，发言者不被重新叫起", async () => {
    const r = await runner.post(g.id, store.getBot("m")!, "大家好，我是灵感助手", hooks);
    expect(spoken).toEqual(["w", "t"]);
    expect(r.replies.map((x) => x.name)).toEqual(["写作助手", "翻译助手"]);
    const msgs = store.listMessages(`group-${g.id}`).filter((m) => m.kind !== "event");
    expect(msgs.map((m) => m.from)).toEqual(["m", "w", "t"]);
  });

  test("@ 了谁就只有谁先回", async () => {
    spoken.length = 0;
    const r = await runner.post(g.id, store.getBot("m")!, "@翻译助手 这句怎么翻", hooks);
    expect(spoken).toEqual(["t"]);
    expect(r.replies).toEqual([{ name: "翻译助手", text: "收到，我是翻译助手" }]);
  });
});

describe("往群聊发消息", () => {
  test("group.send 真的发进群里，回复里带群链接", async () => {
    const { rt, posted } = setup((_u, n) => (n === 0 ? send("测试", "大家好") : "发好了"));
    const blocks: any[] = [];
    await rt.handleStream({ bot, from: "user", text: "向群聊测试说一句大家好", sessionId: "s1" }, { onBlock: (b) => blocks.push(b) });
    expect(posted).toEqual([{ group: "测试", message: "大家好" }]);
    const card = blocks.find((b) => b.type === "tool_call" && b.tool === "group.send" && b.status !== "running");
    expect(String(card?.result)).toContain("app:group/");
    expect(String(card?.result)).toContain("写作助手：收到，欢迎！");
  });

  test("没调用 group.send 却说已发到群里：打回去真的发", async () => {
    const { rt, posted } = setup((u, n) => (n === 0 ? "消息已发到群聊测试：大家好" : u.includes("[系统检查]") ? send("测试", "大家好") : "发好了"));
    const r = await rt.handleStream({ bot, from: "user", text: "向群聊测试说一句大家好", sessionId: "s2" }, { onBlock: () => {} });
    expect(posted.length).toBe(1);
    expect(r.text).toBe("发好了");
  });

  test("识别「已发到群」的说法，提议和提问不算", () => {
    expect(claimsGroupSend("消息已发到群聊 测试：大家好")).toBe(true);
    expect(claimsGroupSend("已经发到测试群里了")).toBe(true);
    expect(claimsGroupSend("要不要我发到群里？")).toBe(false);
    expect(claimsGroupSend("我这就把消息发到群聊测试")).toBe(false);
  });

  test("被别的 bot 转问时不能弹确认卡片", async () => {
    const { rt } = setup((u, n) => (n === 0 ? "```tool\n" + JSON.stringify({ tool: "ui.confirm", args: { question: "发吗" } }) + "\n```" : u.includes("点不了卡片") ? "需要用户确认后再发" : "?"));
    const r = await rt.handleStream({ bot, from: "b", text: "帮我发群消息", sessionId: "b2b-x" }, { onBlock: () => {}, depth: 1 });
    expect(r.text).toBe("需要用户确认后再发");
    expect(r.content?.some((b) => b.type === "choice")).toBe(false);
  });
});
