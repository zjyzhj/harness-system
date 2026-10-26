import type { Provider, ChatMessage } from "../types";

export interface CompletionRequest {
  model?: string;
  system?: string;
  user?: string;
  history?: ChatMessage[];
}

export interface CompletionResult {
  text: string;
  raw?: unknown;
}

/**
 * OpenAI 兼容适配器：POST {baseUrl}/chat/completions。
 * 兼容绝大多数中转站（newapi/oneapi 等）与官方 OpenAI/Azure 兼容端点。
 */
export async function completeOpenAICompat(p: Provider, req: CompletionRequest): Promise<CompletionResult> {
  if (!p.baseUrl) throw new Error(`provider ${p.name} 缺少 baseUrl`);
  const url = p.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const messages = buildMessages(req);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: req.model || p.model || "gpt-4o-mini",
      messages,
      temperature: 0.7,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as any;
  const text = data?.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("API 返回为空（未取到 choices[0].message.content）");
  return { text, raw: data };
}

export async function testOpenAICompat(p: Provider): Promise<{ ok: boolean; detail?: string }> {
  try {
    const r = await completeOpenAICompat(p, { user: "ping", system: "只回复 pong" });
    return { ok: true, detail: r.text };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

function buildMessages(req: CompletionRequest) {
  const msgs: { role: string; content: string }[] = [];
  if (req.system) msgs.push({ role: "system", content: req.system });
  for (const m of req.history ?? []) {
    const role = m.role === "assistant" ? "assistant" : "user";
    msgs.push({ role, content: m.content });
  }
  msgs.push({ role: "user", content: req.user ?? "" });
  return msgs;
}
