import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import { MemorySystem } from "../core/memory-system";
import { SkillRegistry } from "../core/skill-registry";
import { BotRuntime } from "../core/bot-runtime";
import { ProviderCenter } from "../core/provider-center";
import type { Bot, ContentBlock } from "../core/types";

/** 本地假模型：第一轮用原生 tool_calls（参数分 3 片下发），第二轮看到 tool 结果后作答 */
const bodies: any[] = [];
let rejectTools = false;
const sse = (chunks: object[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = await req.json() as any;
    bodies.push(body);
    if (rejectTools && body.tools) return new Response(JSON.stringify({ error: "tools not supported" }), { status: 400 });
    const last = body.messages.at(-1);
    if (last.role === "tool" || String(last.content).includes("[工具执行返回]")) {
      return sse([{ choices: [{ delta: { content: "目录里有 a.txt" } }] }]);
    }
    if (body.tools) {
      const args = JSON.stringify({ tool: "fs.list", args: { path: "/tmp" } });
      return sse([
        { choices: [{ delta: { content: "我看看目录" } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "call_tool", arguments: args.slice(0, 10) } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(10, 25) } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(25) } }] } }] },
      ]);
    }
    return sse([{ choices: [{ delta: { content: "我看看目录\n```tool\n" + JSON.stringify({ tool: "fs.list", args: { path: "/tmp" } }) + "\n```" } }] }]);
  },
});
afterAll(() => server.stop(true));

function setup() {
  const home = mkdtempSync(join(tmpdir(), "harness-native-"));
  const store = new Store(home);
  const providers = new ProviderCenter(store);
  providers.addProvider({ kind: "openai-compat", name: "本地", baseUrl: `http://localhost:${server.port}/v1`, apiKey: "x", model: `m-${Math.random()}`, isDefault: true });
  const bot: Bot = { id: "a", name: "助手", role: "助手", persona: "", providerId: "", petEnabled: false, createdAt: Date.now() };
  store.saveBot(bot);
  const rt = new BotRuntime({ store, providers, memory: new MemorySystem(home), skills: new SkillRegistry(join(home, "skills")) });
  return { rt, bot };
}

describe("原生 function calling", () => {
  test("分片下发的参数拼完整后执行，第二轮按 assistant(tool_calls) + tool 消息回给模型", async () => {
    bodies.length = 0;
    rejectTools = false;
    const { rt, bot } = setup();
    const r = await rt.handleStream({ bot, from: "user", text: "看看 /tmp", sessionId: "s1" }, { onBlock: () => {} });
    expect(bodies[0].tools[0].function.name).toBe("call_tool");
    expect(bodies[0].messages[0].content).toContain("调用函数 call_tool");
    const card = r.content?.find((b) => b.type === "tool_call") as Extract<ContentBlock, { type: "tool_call" }>;
    expect(card.tool).toBe("fs.list");
    expect(card.args).toEqual({ path: "/tmp" });
    const msgs = bodies[1].messages;
    const assistant = msgs.at(-2);
    expect(assistant.tool_calls[0]).toMatchObject({ id: "call_1", type: "function", function: { name: "call_tool" } });
    expect(JSON.parse(assistant.tool_calls[0].function.arguments)).toEqual({ tool: "fs.list", args: { path: "/tmp" } });
    expect(msgs.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_1" });
    expect(msgs.at(-1).content).toContain("工具 fs.list 结果");
    expect(r.text).toBe("目录里有 a.txt");
  });

  test("端点拒收 tools：自动退回文本工具块，之后不再发 tools", async () => {
    bodies.length = 0;
    rejectTools = true;
    const { rt, bot } = setup();
    const r = await rt.handleStream({ bot, from: "user", text: "看看 /tmp", sessionId: "s2" }, { onBlock: () => {} });
    expect(bodies[0].tools).toBeDefined();
    expect(bodies[1].tools).toBeUndefined();
    expect(bodies.at(-1).tools).toBeUndefined();
    expect(r.content?.some((b) => b.type === "tool_call" && (b as any).tool === "fs.list")).toBe(true);
    expect(r.text).toBe("目录里有 a.txt");
  });
});
