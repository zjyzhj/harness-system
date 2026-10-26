import { describe, test, expect } from "bun:test";
import type { Provider } from "../core/types";
import { completeOpenAICompat } from "../core/adapters/openai-compat";

const LIVE = process.env.HARNESS_LIVE_E2E === "1";
const baseUrl = process.env.HARNESS_LIVE_BASE || "http://127.0.0.1:15721/v1";

function liveProvider(over: Partial<Provider> = {}): Provider {
  return { id: "live", kind: "openai-compat", name: "live", baseUrl, model: "deepseek-v4.1-flash", isDefault: false, createdAt: 1, ...over };
}

describe("live e2e (真实模型端点，需 HARNESS_LIVE_E2E=1)", () => {
  test("responses 真实调用：thinking + text 块", async () => {
    if (!LIVE) return; // skip when not requested
    const r = await completeOpenAICompat(liveProvider({ wireApi: "responses" }), { user: "只回复 pong" });
    expect(r.text).toContain("pong");
    expect(r.content?.some((b) => b.type === "text")).toBe(true);
  }, 30_000);

  test("SSE 流式真实调用：增量 text", async () => {
    if (!LIVE) return;
    const chunks: string[] = [];
    const r = await completeOpenAICompat(liveProvider({ wireApi: "responses" }), {
      user: "只回复 pong",
      stream: true,
      _onChunk: (b) => { if (b.type === "text") chunks.push((b as any).text); },
    });
    expect(chunks.length).toBeGreaterThan(0);
    expect(r.text).toContain("pong");
  }, 30_000);
});
