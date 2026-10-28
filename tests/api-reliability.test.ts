import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { API_TIMING, completeOpenAICompat } from "../core/adapters/openai-compat";
import type { Provider } from "../core/types";

let script: (req: Request, n: number) => Response | Promise<Response>;
let hits = 0;
const server = Bun.serve({ port: 0, fetch: (req) => script(req, ++hits) });
const p: Provider = { id: "p", kind: "openai-compat", name: "mock", baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "k", model: "m", wireApi: "chat", isDefault: true, createdAt: 0 };
const saved = { ...API_TIMING, backoffMs: [...API_TIMING.backoffMs] };

beforeAll(() => { API_TIMING.backoffMs = [10, 10]; API_TIMING.headerMs = 300; API_TIMING.idleMs = 300; });
afterAll(() => { Object.assign(API_TIMING, saved); server.stop(true); });

const ok = (text: string) => Response.json({ choices: [{ message: { content: text } }] });
const sse = (chunks: string[], delayAfterMs?: number) => new Response(new ReadableStream({
  start(c) {
    for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
    if (delayAfterMs) setTimeout(() => { try { c.close(); } catch {} }, delayAfterMs);
    else c.close();
  },
}), { headers: { "Content-Type": "text/event-stream" } });
const delta = (t: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;

describe("模型调用的重试与超时", () => {
  test("429 / 503 自动退避重试，第三次成功", async () => {
    hits = 0;
    script = (_r, n) => (n === 1 ? new Response("busy", { status: 429, headers: { "Retry-After": "0" } }) : n === 2 ? new Response("down", { status: 503 }) : ok("好了"));
    const r = await completeOpenAICompat(p, { user: "hi" });
    expect(r.text).toBe("好了");
    expect(hits).toBe(3);
  });

  test("400 这类请求错误不重试", async () => {
    hits = 0;
    script = () => new Response("bad", { status: 400 });
    await expect(completeOpenAICompat(p, { user: "hi" })).rejects.toThrow("API 400");
    expect(hits).toBe(1);
  });

  test("一直不响应：超时报错而不是永远卡住", async () => {
    hits = 0;
    script = () => new Promise(() => {});
    await expect(completeOpenAICompat(p, { user: "hi" })).rejects.toThrow("超时");
    expect(hits).toBe(3);
  });

  test("用户停止：立即结束，不再重试", async () => {
    hits = 0;
    script = () => new Promise(() => {});
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    await expect(completeOpenAICompat(p, { user: "hi", signal: ctrl.signal })).rejects.toThrow("已停止");
    expect(hits).toBe(1);
  });
});

describe("流式响应", () => {
  test("正常结束", async () => {
    script = () => sse([delta("你"), delta("好"), "data: [DONE]\n\n"]);
    const r = await completeOpenAICompat(p, { user: "hi", stream: true });
    expect(r.text).toBe("你好");
  });

  test("流里返回 error：抛错而不是当成空回复", async () => {
    script = () => sse([`data: ${JSON.stringify({ error: { message: "quota exceeded" } })}\n\n`]);
    await expect(completeOpenAICompat(p, { user: "hi", stream: true })).rejects.toThrow("quota exceeded");
  });

  test("中途断开：保留已收到的内容并提示不完整", async () => {
    script = () => sse([delta("一半")]);
    const r = await completeOpenAICompat(p, { user: "hi", stream: true });
    expect(r.text).toContain("一半");
    expect(r.text).toContain("可能不完整");
  });

  test("正文输出中途点停止：立即断开", async () => {
    script = () => sse([delta("开头")], 5000);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    const t0 = Date.now();
    const r = await completeOpenAICompat(p, { user: "hi", stream: true, signal: ctrl.signal });
    expect(Date.now() - t0).toBeLessThan(250);
    expect(r.text).toBe("开头");
  });

  test("长时间没有数据：空闲超时", async () => {
    script = () => sse([": ping\n\n"], 2000);
    await expect(completeOpenAICompat(p, { user: "hi", stream: true })).rejects.toThrow("没有输出");
  });
});
