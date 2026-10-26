import { describe, test, expect, afterAll } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Provider } from "../core/types";
import { completeOpenAICompat } from "../core/adapters/openai-compat";

let server: Server | null = null;
let getPort = () => 0;
let captured: any[] = [];

function startMock(routes: {
  models?: (req: any, res: any) => void;
  chat?: (body: unknown, raw?: any) => { status?: number; sse?: boolean; data?: unknown; chunks?: string[] };
  responses?: (body: unknown, raw?: any) => { data?: unknown };
}) {
  server = createServer((req, res) => {
    const url = req.url ?? "";
    let bodyStr = "";
    req.on("data", (d) => (bodyStr += d));
    req.on("end", () => {
      let body: unknown = {};
      try { body = JSON.parse(bodyStr || "{}"); } catch { /* ignore */ }
      if (url.endsWith("/models")) {
        res.setHeader("Content-Type", "application/json");
        if (routes.models) { routes.models(req, res); return; }
        res.end(JSON.stringify({ data: [{ id: "m", name: "m" }] }));
        return;
      }
      if (url.endsWith("/chat/completions")) {
        captured.push({ path: url, body });
        const h = routes.chat?.(body) ?? { data: {} };
        if (h.status) { res.statusCode = h.status; res.end(); return; }
        if (h.sse) {
          res.setHeader("Content-Type", "text/event-stream");
          for (const c of h.chunks ?? []) res.write(`data: ${c}\n\n`);
          res.end("data: [DONE]\n\n");
          return;
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(h.data));
        return;
      }
      if (url.endsWith("/responses")) {
        captured.push({ path: url, body });
        const h = routes.responses?.(body) ?? { data: {} };
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(h.data));
        return;
      }
      res.statusCode = 404; res.end();
    });
  });
  return new Promise<void>((resolve) => {
    captured = [];
    server!.listen(0, "127.0.0.1", () => {
      getPort = () => (server!.address() as AddressInfo).port;
      resolve();
    });
  });
}

function provider(over: Partial<Provider> = {}): Provider {
  return {
    id: "p1", kind: "openai-compat", name: "mock", baseUrl: `http://127.0.0.1:${getPort()}/v1`,
    apiKey: "sk-test", model: "mock-model", isDefault: false, createdAt: 1, ...over,
  };
}

afterAll(() => server?.close());

describe("openai-compat adapter (V3)", () => {
  test("chat/completions 非流式：text + usage", async () => {
    await startMock({
      chat: () => ({ data: {
        choices: [{ message: { role: "assistant", content: "你好" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }}),
    });
    const r = await completeOpenAICompat(provider(), { user: "hi" });
    expect(r.text).toBe("你好");
    expect(r.content?.[0]).toMatchObject({ type: "text", text: "你好" });
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  test("chat/completions 结构化 tool_call → tool_call 块", async () => {
    await startMock({
      chat: () => ({ data: {
        choices: [{ message: { role: "assistant", content: "", tool_calls: [
          { id: "call_1", type: "function", function: { name: "bash.run", arguments: JSON.stringify({ cmd: "ls" }) } },
        ]}}],
      }}),
    });
    const r = await completeOpenAICompat(provider(), { user: "列出目录", tools: [{ name: "bash.run", description: "run" }] });
    expect(r.content).toHaveLength(1);
    expect(r.content?.[0]).toMatchObject({ type: "tool_call", tool: "bash.run", callId: "call_1" });
    expect((r.content?.[0] as any).args).toEqual({ cmd: "ls" });
  });

  test("SSE 流式：增量 text 块回调 + 汇总 text", async () => {
    await startMock({
      chat: () => ({ sse: true, chunks: [
        JSON.stringify({ choices: [{ delta: { content: "你" } }] }),
        JSON.stringify({ choices: [{ delta: { content: "好" } }] }),
      ]}),
    });
    const chunks: string[] = [];
    const r = await completeOpenAICompat(provider(), { user: "hi", stream: true, _onChunk: (b) => { if (b.type === "text") chunks.push((b as any).text); } });
    expect(chunks).toEqual(["你", "好"]);
    expect(r.text).toBe("你好");
  });

  test("responses API：output → text + function_call 块", async () => {
    await startMock({
      models: (req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "m", name: "m", capabilities: ["responses"] }] }));
      },
      responses: () => ({ data: {
        output: [
          { type: "message", content: [{ type: "output_text", text: "我来查一下" }] },
          { type: "function_call", call_id: "fc_1", name: "web.fetch", arguments: JSON.stringify({ url: "https://x" }) },
        ],
        usage: { input_tokens: 3, output_tokens: 2 },
      }}),
    });
    const r = await completeOpenAICompat(provider(), { user: "查一下" });
    expect(r.text).toContain("我来查一下");
    expect(r.content?.some((b) => b.type === "tool_call" && (b as any).tool === "web.fetch")).toBe(true);
    expect(r.usage?.inputTokens).toBe(3);
  });

  test("手动 wireApi=responses 跳过探测", async () => {
    await startMock({
      responses: () => ({ data: { output: [{ type: "message", content: [{ type: "output_text", text: "直接走 responses" }] }] } }),
    });
    const r = await completeOpenAICompat(provider({ wireApi: "responses" }), { user: "hi" });
    expect(r.text).toBe("直接走 responses");
  });
});

describe("openai-compat 多模态 wire（V3-6）", () => {
  test("chat/completions：user 图片块 → image_url content", async () => {
    await startMock({ chat: () => ({ data: { choices: [{ message: { role: "assistant", content: "收到图片" } }] } }) });
    const user: any[] = [
      { type: "text", text: "看这张图" },
      { type: "image", dataUrl: "data:image/png;base64,AAAA" },
    ];
    await completeOpenAICompat(provider(), { user });
    const req = captured.find((c) => c.path.endsWith("/chat/completions"));
    const lastMsg = req.body.messages[req.body.messages.length - 1];
    expect(Array.isArray(lastMsg.content)).toBe(true);
    expect(lastMsg.content[0]).toMatchObject({ type: "text", text: "看这张图" });
    expect(lastMsg.content[1]).toMatchObject({ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } });
  });

  test("responses：user 图片块 → input 多模态 content", async () => {
    await startMock({
      models: (req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ data: [{ id: "m", name: "m", capabilities: ["responses"] }] })); },
      responses: () => ({ data: { output: [{ type: "message", content: [{ type: "output_text", text: "图收到了" }] }] } }),
    });
    const user: any[] = [{ type: "text", text: "描述图" }, { type: "image", url: "https://x/y.png" }];
    await completeOpenAICompat(provider(), { user });
    const req = captured.find((c) => c.path.endsWith("/responses"));
    const last = req.body.input[req.body.input.length - 1];
    expect(Array.isArray(last.content)).toBe(true);
    expect(last.content[1]).toMatchObject({ type: "image_url", image_url: { url: "https://x/y.png" } });
  });

  test("纯文本 user 保持字符串（不破坏 wire）", async () => {
    await startMock({ chat: () => ({ data: { choices: [{ message: { content: "ok" } }] } }) });
    await completeOpenAICompat(provider(), { user: "你好" });
    const req = captured.find((c) => c.path.endsWith("/chat/completions"));
    const lastMsg = req.body.messages[req.body.messages.length - 1];
    expect(lastMsg.content).toBe("你好");
  });
});
