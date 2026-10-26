import { contentText, type Provider, type ChatMessage, type LLMRequest, type LLMResponse, type ContentBlock, type ToolDescription } from "../types";

export interface CompletionRequest {
  model?: string;
  system?: string;
  user?: string;
  history?: ChatMessage[];
  tools?: ToolDescription[];
  stream?: boolean;
  temperature?: number;
  /** 流式回调：每次增量块（text/tool_call） */
  _onChunk?: (b: ContentBlock) => void;
}

export interface CompletionResult {
  text: string;
  raw?: unknown;
  content?: ContentBlock[];
  usage?: { inputTokens?: number; outputTokens?: number };
}

/** wire_api 探测（新）：/v1/models 返回的对象里常见字段为 responses 标志位 */
const WIRE_CACHE = new Map<string, "chat" | "responses">();
export async function detectWireApi(p: Provider): Promise<"chat" | "responses"> {
  if (p.wireApi) return p.wireApi;
  if (!p.baseUrl) return "chat";
  const key = `${p.baseUrl}::${p.apiKey ?? ""}`;
  const hit = WIRE_CACHE.get(key);
  if (hit) return hit;
  const base = p.baseUrl.replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/models`, { headers: { ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}) } });
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as any;
      const sample = data?.data?.[0] ?? data?.[0];
      if (sample && (sample.id || sample.name)) {
        // CC Switch / newapi 中转常在 model 对象带 responses 标记字段
        if (Array.isArray(sample.capabilities) || sample.wire_api === "responses" || sample.mode === "responses") {
          WIRE_CACHE.set(key, "responses");
          return "responses";
        }
        // 保守：默认 chat/completions（兼容面最广）
      }
    }
  } catch { /* 探测失败走 chat 兼容 */ }
  WIRE_CACHE.set(key, "chat");
  return "chat";
}

/**
 * OpenAI 兼容适配器：POST {baseUrl}/chat/completions。
 * 兼容绝大多数中转站（newapi/oneapi 等）与官方 OpenAI/Azure 兼容端点。
 */
/**
 * OpenAI 兼容适配器（V3）：
 * - chat/completions（默认，兼容 newapi/oneapi/官方）
 * - responses API（CC Switch 等中转 wire_api=responses 时自动探测切换）
 * - SSE 流式（req.stream=true 时增量返回）
 * - 结构化 tools → 映射为 tool_call 块
 * 返回 CompletionResult（text + content 块 + usage），向后兼容旧调用点。
 */
export async function completeOpenAICompat(p: Provider, req: CompletionRequest): Promise<CompletionResult> {
  if (!p.baseUrl) throw new Error(`provider ${p.name} 缺少 baseUrl`);
  const wire = req.stream ? "chat" : await detectWireApi(p);
  if (wire === "responses" && !req.stream) {
    try {
      return await completeResponses(p, req);
    } catch (e) {
      // 探测/实现误判时自动降级 chat/completions（覆盖面最广）
      return completeChat(p, req, false);
    }
  }
  return completeChat(p, req, !!req.stream);
}

/** chat/completions 实现（含 SSE 流式） */
async function completeChat(p: Provider, req: CompletionRequest, stream: boolean): Promise<CompletionResult> {
  if (!p.baseUrl) throw new Error(`provider ${p.name} 缺少 baseUrl`);
  const base = p.baseUrl.replace(/\/+$/, "");
  const url = `${base}/chat/completions`;
  const messages = buildMessages(req);
  const body: Record<string, unknown> = {
    model: req.model || p.model || "gpt-4o-mini",
    messages,
    temperature: req.temperature ?? 0.7,
  };
  if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema ?? { type: "object", properties: {} } } }));
  if (stream) body.stream = true;
  if (req.temperature !== undefined) body.temperature = req.temperature;

  const res = await postJSON(p, url, body);
  if (stream) {
    return streamChat(res, req);
  }
  const data = (await res.json()) as any;
  const content: ContentBlock[] = [];
  const msg = data?.choices?.[0]?.message;
  const text = msg?.content ?? "";
  if (typeof text === "string" && text) content.push({ type: "text", text });
  for (const tc of msg?.tool_calls ?? []) {
    content.push({ type: "tool_call", callId: tc.id, tool: tc.function?.name ?? "", args: safeParse(tc.function?.arguments) });
  }
  const usage = data?.usage ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens } : undefined;
  if (!content.length) throw new Error("API 返回为空（未取到 choices[0].message）");
  return { text: contentTextFromBlocks(content), raw: data, content, usage };
}

/** SSE 流式解析（data: {...} 行）→ 增量 text 块 + 工具增量 → done */
async function streamChat(res: Response, req: CompletionRequest): Promise<CompletionResult> {
  const usageAcc: { inputTokens?: number; outputTokens?: number } = {};
  const text = await consumeSSE(res, (data) => {
    const delta = data?.choices?.[0]?.delta;
    if (delta?.content) onChunk(req, { type: "text", text: delta.content });
    for (const tc of delta?.tool_calls ?? []) {
      onChunk(req, { type: "tool_call", callId: tc.id, tool: tc.function?.name ?? "", args: safeParse(tc.function?.arguments) });
    }
    if (data?.usage) {
      usageAcc.inputTokens = data.usage.prompt_tokens;
      usageAcc.outputTokens = data.usage.completion_tokens;
    }
  });
  return { text, content: [{ type: "text", text }], usage: Object.keys(usageAcc).length ? usageAcc : undefined };
}

/** responses API 实现（CC Switch wire_api=responses） */
async function completeResponses(p: Provider, req: CompletionRequest): Promise<CompletionResult> {
  if (!p.baseUrl) throw new Error(`provider ${p.name} 缺少 baseUrl`);
  const base = p.baseUrl.replace(/\/+$/, "");
  const url = `${base}/responses`;
  const msgs = buildResponsesMessages(req);
  const body: Record<string, unknown> = {
    model: req.model || p.model || "gpt-4o-mini",
    input: msgs,
  };
  if (req.system) body.instructions = req.system;
  if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema ?? { type: "object", properties: {} } }));

  const res = await postJSON(p, url, body);
  const data = (await res.json()) as any;
  const content: ContentBlock[] = [];
  const out = data?.output ?? [];
  for (const item of out) {
    if (item.type === "reasoning") {
      const txt = (item.summary ?? []).map((s: any) => s.text ?? "").join("\n");
      if (txt) content.push({ type: "thinking", text: txt });
    }
    if (item.type === "message" || item.type === "message_output") {
      for (const c of item.content ?? []) {
        if (c.type === "output_text" || c.type === "text") content.push({ type: "text", text: c.text ?? "" });
      }
    }
    if (item.type === "function_call") {
      content.push({ type: "tool_call", callId: item.call_id ?? item.id, tool: item.name ?? "", args: safeParse(item.arguments) });
    }
  }
  const text = contentTextFromBlocks(content);
  if (!text && content.every((b) => b.type !== "tool_call")) throw new Error("API 返回为空（responses output 无内容）");
  const usage = data?.usage ? { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens } : undefined;
  return { text, raw: data, content, usage };
}

// ---- 工具 ----

function postJSON(p: Provider, url: string, body: Record<string, unknown>): Promise<Response> {
  return new Promise((resolve, reject) => {
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    }).then((res) => {
      if (!res.ok) {
        res.text().then((t) => reject(new Error(`API ${res.status}: ${t.slice(0, 300)}`))).catch(() => reject(new Error(`API ${res.status}`)));
        return;
      }
      resolve(res);
    }).catch((e) => reject(new Error(`API 连接失败（${url}）：${e instanceof Error ? e.message : String(e)}`)));
  });
}

function buildResponsesMessages(req: CompletionRequest) {
  const msgs: { role: string; content: string }[] = [];
  for (const m of req.history ?? []) {
    const role = m.role === "assistant" ? "assistant" : "user";
    msgs.push({ role, content: contentText(m.content) });
  }
  if (req.user) msgs.push({ role: "user", content: contentText(req.user as any) });
  return msgs;
}

function safeParse(s: unknown): Record<string, unknown> {
  if (typeof s !== "string" || !s.trim()) return {};
  try { return JSON.parse(s); } catch { return { raw: s }; }
}

function contentTextFromBlocks(blocks: ContentBlock[]): string {
  return blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
}

function onChunk(req: CompletionRequest, block: ContentBlock) {
  req._onChunk?.(block);
}
/** 消费 SSE 响应，逐行回调 data 对象；返回拼接后的纯文本 */
async function consumeSSE(res: Response, onData: (data: any) => void): Promise<string> {
  if (!res.body) throw new Error("响应无 body（无法流式）");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const data = JSON.parse(payload);
          onData(data);
          const c = data?.choices?.[0]?.delta?.content;
          if (typeof c === "string") text += c;
        } catch { /* 忽略无法解析的行 */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return text;
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
    msgs.push({ role, content: contentText(m.content) || (Array.isArray(m.content) ? "[图片]" : "") });
  }
  msgs.push({ role: "user", content: typeof req.user === "string" ? req.user : contentText(req.user ?? []) || "[图片]" });
  return msgs;
}
