import { existsSync } from "node:fs";
import { contentText, type Provider, type ChatMessage, type ContentBlock, type ToolDescription } from "../types";
import { attachmentPrompt } from "../attachments";
import { fileToDataUrl } from "../image-tool";

export interface CompletionRequest {
  model?: string;
  system?: string;
  user?: string | ContentBlock[];
  history?: ChatMessage[];
  tools?: ToolDescription[];
  stream?: boolean;
  temperature?: number;
  /** 流式回调：每次增量块（text/tool_call） */
  _onChunk?: (b: ContentBlock) => void;
  /** 中止信号：用户点「停止生成」时取消请求 */
  signal?: AbortSignal;
  /** 失败重试次数（默认 API_TIMING.retries；连通性测试传 0） */
  retries?: number;
  /** 本轮工具循环：接在 user 之后的 assistant(tool_calls) / tool 结果 / 追加的 user 消息 */
  tail?: WireTurn[];
}

export type WireTurn =
  | { role: "assistant"; content: string; toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }> }
  | { role: "tool"; id: string; content: string }
  | { role: "user"; content: string };

/** 不支持原生 tools 的端点（400/422 拒收过）：之后不再发 tools，改走文本工具块 */
const NO_NATIVE_TOOLS = new Set<string>();
/** 不认 stream_options 的端点（流式时拿不到用量） */
const NO_STREAM_USAGE = new Set<string>();
const toolsKey = (p: Provider, model?: string) => `${p.baseUrl}::${model || p.model || ""}`;
export function supportsNativeTools(p: Provider, model?: string): boolean {
  return p.kind === "openai-compat" && p.toolMode !== "text" && !NO_NATIVE_TOOLS.has(toolsKey(p, model));
}

export interface CompletionResult {
  text: string;
  raw?: unknown;
  content?: ContentBlock[];
  usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number };
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
    const res = await fetch(`${base}/models`, { headers: { ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}) }, signal: AbortSignal.timeout(10_000) });
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
  const usageKey = `${base}|${body.model}`;
  if (stream && !NO_STREAM_USAGE.has(usageKey)) body.stream_options = { include_usage: true };
  if (req.temperature !== undefined) body.temperature = req.temperature;

  const reqStart = Date.now();
  let res: Response;
  try {
    res = await postJSON(p, url, body, req.signal, req.retries);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (body.stream_options && /^API (400|422)\b/.test(msg) && (/stream_options|include_usage/i.test(msg) || !body.tools)) {
      NO_STREAM_USAGE.add(usageKey);
      return completeChat(p, req, stream);
    }
    if (!body.tools || !/^API (400|404|422)\b/.test(e instanceof Error ? e.message : "")) throw e;
    NO_NATIVE_TOOLS.add(toolsKey(p, req.model));
    return completeChat(p, { ...req, tools: undefined, tail: req.tail ? flattenTail(req.tail) : undefined }, stream);
  }
  if (stream) {
    return streamChat(res, req, reqStart);
  }
  const data = (await res.json()) as any;
  const content: ContentBlock[] = [];
  const msg = data?.choices?.[0]?.message;
  let text = msg?.content ?? "";
  const reasoning = msg?.reasoning_content ?? msg?.reasoning;
  const tagged = typeof text === "string" ? text.match(/^\s*<think>([\s\S]*?)<\/think>\s*/) : null;
  if (tagged) text = text.slice(tagged[0].length);
  const thought = (typeof reasoning === "string" && reasoning.trim()) || tagged?.[1].trim();
  if (thought) content.push({ type: "thinking", text: thought, ms: Date.now() - reqStart });
  if (typeof text === "string" && text) content.push({ type: "text", text });
  for (const tc of msg?.tool_calls ?? []) {
    content.push({ type: "tool_call", callId: tc.id, tool: tc.function?.name ?? "", args: safeParse(tc.function?.arguments) });
  }
  const usage = data?.usage ? usageOf(data.usage) : undefined;
  if (!content.length) throw new Error("API 返回为空（未取到 choices[0].message）");
  return { text: contentTextFromBlocks(content), raw: data, content, usage };
}

/**
 * 把正文增量里的 <think>…</think> 拆出来当思考过程（部分中转把推理模型的思考写进 content）。
 * 标签可能被切在两个增量之间，所以留一点尾巴等下一个增量。
 */
export function thinkSplitter(emit: (kind: "text" | "thinking", s: string) => void) {
  let buf = "";
  let inThink = false;
  let seenText = false;
  const OPEN = "<think>", CLOSE = "</think>";
  const flush = (final: boolean) => {
    while (buf) {
      if (inThink) {
        const i = buf.indexOf(CLOSE);
        if (i >= 0) { if (i) emit("thinking", buf.slice(0, i)); buf = buf.slice(i + CLOSE.length).replace(/^\s+/, ""); inThink = false; continue; }
        const keep = final ? 0 : CLOSE.length - 1;
        if (buf.length > keep) { emit("thinking", buf.slice(0, buf.length - keep)); buf = buf.slice(buf.length - keep); }
        return;
      }
      // 只认回复开头的 <think>，正文中间出现的当普通文字
      if (!seenText) {
        const lead = buf.replace(/^\s+/, "");
        if (lead.startsWith(OPEN)) { buf = lead.slice(OPEN.length); inThink = true; continue; }
        if (!final && OPEN.startsWith(lead)) return;
      }
      seenText = true;
      emit("text", buf);
      buf = "";
    }
  };
  return { push: (s: string) => { buf += s; flush(false); }, end: () => flush(true) };
}

/** SSE 流式解析（data: {...} 行）→ 增量 text / thinking 块 + 工具增量 → done */
async function streamChat(res: Response, req: CompletionRequest, reqStart = Date.now()): Promise<CompletionResult> {
  const usageAcc: NonNullable<CompletionResult["usage"]> = {};
  let text = "", thinking = "";
  // 从发起请求计：很多端点会在服务端想完再一次性吐 reasoning，若从首 token 计会变成「不到 1 秒」
  const streamStart = reqStart;
  let sawThinking = false, thinkMs = 0;
  const emit = (kind: "text" | "thinking", s: string) => {
    if (kind === "thinking") {
      sawThinking = true;
      thinking += s;
    } else {
      if (sawThinking && !thinkMs) thinkMs = Date.now() - streamStart;
      text += s;
    }
    onChunk(req, { type: kind, text: s });
  };
  const split = thinkSplitter(emit);
  /** 工具调用的参数是分片到达的：按 index 拼完整再解析 */
  const calls: Array<{ id: string; name: string; args: string }> = [];
  const { complete } = await consumeSSE(res, (data) => {
    const delta = data?.choices?.[0]?.delta;
    const reasoning = delta?.reasoning_content ?? delta?.reasoning;
    if (typeof reasoning === "string" && reasoning) emit("thinking", reasoning);
    if (delta?.content) split.push(delta.content);
    for (const tc of delta?.tool_calls ?? []) {
      const i = typeof tc.index === "number" ? tc.index : calls.length;
      const c = calls[i] ?? (calls[i] = { id: "", name: "", args: "" });
      if (tc.id) c.id = tc.id;
      if (tc.function?.name) c.name += tc.function.name;
      if (tc.function?.arguments) c.args += tc.function.arguments;
    }
    if (data?.usage) Object.assign(usageAcc, usageOf(data.usage));
  });
  split.end();
  if (!complete && !req.signal?.aborted) emit("text", "\n\n（⚠️ 和模型的连接中途断开，这条回复可能不完整）");
  if (sawThinking && !thinkMs) thinkMs = Date.now() - streamStart;
  const content: ContentBlock[] = [];
  if (thinking.trim()) content.push({ type: "thinking", text: thinking.trim(), ms: thinkMs });
  content.push({ type: "text", text });
  calls.filter((c) => c?.name).forEach((c, i) => content.push({ type: "tool_call", callId: c.id || `call_${Date.now()}_${i}`, tool: c.name, args: safeParse(c.args) }));
  return { text, content, usage: Object.keys(usageAcc).length ? usageAcc : undefined };
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

  const res = await postJSON(p, url, body, req.signal, req.retries);
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
  const usage = data?.usage ? { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens, cachedTokens: data.usage.input_tokens_details?.cached_tokens } : undefined;
  return { text, raw: data, content, usage };
}

// ---- 工具 ----

/** chat/completions 的 usage；命中前缀缓存的输入 token：DeepSeek 叫 prompt_cache_hit_tokens，OpenAI 放在 prompt_tokens_details.cached_tokens */
export function usageOf(u: any): NonNullable<CompletionResult["usage"]> {
  const cached = u?.prompt_cache_hit_tokens ?? u?.prompt_tokens_details?.cached_tokens;
  return { inputTokens: u?.prompt_tokens, outputTokens: u?.completion_tokens, ...(typeof cached === "number" ? { cachedTokens: cached } : {}) };
}

const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
export const API_TIMING = { headerMs: 120_000, idleMs: 90_000, retries: 2, backoffMs: [1500, 4000] };

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(new Error("已停止"));
  const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(new Error("已停止")); };
  signal?.addEventListener("abort", onAbort, { once: true });
});

function retryAfterMs(res: Response): number | null {
  const v = res.headers.get("retry-after");
  if (!v) return null;
  const s = Number(v);
  const ms = Number.isFinite(s) ? s * 1000 : Date.parse(v) - Date.now();
  return ms > 0 ? Math.min(ms, 20_000) : null;
}

/**
 * 发请求：等响应头有超时（流式正文另有空闲超时），429 / 5xx / 网络错误自动退避重试。
 * 返回的 res.body 仍受用户的停止信号控制。
 */
async function postJSON(p: Provider, url: string, body: Record<string, unknown>, signal?: AbortSignal, retries = API_TIMING.retries): Promise<Response> {
  let lastErr: Error = new Error("API 请求失败");
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new Error("已停止");
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, API_TIMING.headerMs);
    let wait: number | null = null;
    let keepListener = false;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      // 成功时保留监听：之后读流式正文时点停止也要能断开
      if (res.ok) { keepListener = true; return res; }
      const t = await res.text().catch(() => "");
      lastErr = new Error(`API ${res.status}: ${t.slice(0, 300)}`);
      if (!RETRY_STATUS.has(res.status)) throw lastErr;
      wait = retryAfterMs(res);
    } catch (e) {
      clearTimeout(timer);
      if (signal?.aborted) throw new Error("已停止");
      if (e === lastErr) throw e;
      lastErr = timedOut
        ? new Error(`API 超时（${Math.round(API_TIMING.headerMs / 1000)} 秒没有响应，${url}）`)
        : new Error(`API 连接失败（${url}）：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (!keepListener) signal?.removeEventListener("abort", onAbort);
    }
    if (attempt < retries) await sleep(wait ?? API_TIMING.backoffMs[attempt] ?? 4000, signal);
  }
  throw lastErr;
}

function buildResponsesMessages(req: CompletionRequest) {
  const msgs: Array<{ role: string; content: string | Array<Record<string, unknown>> }> = [];
  for (const m of req.history ?? []) {
    const role = m.role === "assistant" ? "assistant" : "user";
    msgs.push({ role, content: contentText(m.content) });
  }
  if (req.user) msgs.push({ role: "user", content: contentToWire(req.user) });
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
/** 消费 SSE；中途报错、长时间没有数据、或没收到任何内容就断开时抛错。complete=false 表示收到了一部分但没有正常结束 */
async function consumeSSE(res: Response, onData: (data: any) => void): Promise<{ text: string; complete: boolean }> {
  if (!res.body) throw new Error("响应无 body（无法流式）");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let complete = false;
  let received = false;
  const handle = (line: string) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") { complete = true; return; }
    let data: any;
    try { data = JSON.parse(payload); } catch { return; }
    if (data?.error) throw new Error(`API 流式返回错误：${typeof data.error === "string" ? data.error : data.error.message ?? JSON.stringify(data.error).slice(0, 300)}`);
    received = true;
    if (data?.choices?.[0]?.finish_reason) complete = true;
    onData(data);
    const c = data?.choices?.[0]?.delta?.content;
    if (typeof c === "string") text += c;
  };
  try {
    while (true) {
      let idle: ReturnType<typeof setTimeout> | undefined;
      const r = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => { idle = setTimeout(() => reject(new Error(`模型 ${Math.round(API_TIMING.idleMs / 1000)} 秒没有输出，连接可能已断开`)), API_TIMING.idleMs); }),
      ]).finally(() => clearTimeout(idle));
      if (r.done) break;
      buf += decoder.decode(r.value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        handle(line);
      }
    }
    if (buf.trim()) handle(buf.trim());
  } catch (e) {
    reader.cancel().catch(() => {});
    if (!received) throw e;
    return { text, complete: false };
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  if (!received && !complete) throw new Error("API 流式响应没有任何内容就结束了");
  return { text, complete };
}

export async function testOpenAICompat(p: Provider): Promise<{ ok: boolean; detail?: string }> {
  try {
    const r = await completeOpenAICompat(p, { user: "ping", system: "只回复 pong", retries: 0, signal: AbortSignal.timeout(30_000) });
    return { ok: true, detail: r.text };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

type WireMessage = { role: string; content: string | Array<Record<string, unknown>> };

/** 把内容块转成 OpenAI chat/completions 多模态 content（text + image_url） */
function contentToWire(content: string | ContentBlock[]): string | Array<Record<string, unknown>> {
  if (typeof content === "string") return content;
  const parts: Array<Record<string, unknown>> = [];
  let textBuf = "";
  const flush = () => { if (textBuf) { parts.push({ type: "text", text: textBuf }); textBuf = ""; } };
  for (const b of content) {
    if (b.type === "text") {
      textBuf += b.text ?? "";
      continue;
    }
    if (b.type === "image" && (b.dataUrl || b.url || b.path)) {
      flush();
      const url = b.dataUrl || b.url || (b.path && existsSync(b.path) ? fileToDataUrl(b.path) : "");
      if (url) parts.push({ type: "image_url", image_url: { url } });
      continue;
    }
    if (b.type === "code") textBuf += `\n\`\`\`${b.lang ?? ""}\n${b.code}\n\`\`\``;
    if (b.type === "file") textBuf += `\n\n${attachmentPrompt(b)}\n`;
  }
  flush();
  if (!parts.length) return textBuf;
  if (parts.length === 1 && parts[0].type === "text") return String(parts[0].text);
  return parts;
}

function buildMessages(req: CompletionRequest) {
  const msgs: WireMessage[] = [];
  if (req.system) msgs.push({ role: "system", content: req.system });
  for (const m of req.history ?? []) {
    const role = m.role === "assistant" ? "assistant" : "user";
    // 历史保持文本（当前轮次图片已足够；历史多模态后续升级）
    msgs.push({ role, content: m.meta?.inline ? contentToWire(m.content) : contentText(m.content) || (Array.isArray(m.content) ? "[图片]" : "") });
  }
  msgs.push({ role: "user", content: contentToWire(req.user ?? "") });
  for (const t of req.tail ?? []) {
    if (t.role === "assistant" && t.toolCalls?.length) {
      msgs.push({ role: "assistant", content: t.content || null, tool_calls: t.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) } as unknown as WireMessage);
    } else if (t.role === "tool") {
      msgs.push({ role: "tool", tool_call_id: t.id, content: t.content } as unknown as WireMessage);
    } else {
      msgs.push({ role: t.role, content: t.content });
    }
  }
  return msgs;
}

/** 端点不认原生工具时：把工具轮次改写成普通的问答文本 */
function flattenTail(tail: WireTurn[]): WireTurn[] {
  const out: WireTurn[] = [];
  for (const t of tail) {
    if (t.role === "assistant") {
      const calls = (t.toolCalls ?? []).map((c) => "```tool\n" + JSON.stringify({ tool: c.name, args: c.args }) + "\n```");
      out.push({ role: "assistant", content: [t.content, ...calls].filter(Boolean).join("\n\n") });
    } else if (t.role === "tool") {
      const prev = out.at(-1);
      if (prev?.role === "user" && prev.content.startsWith("[工具执行返回]")) prev.content += `\n${t.content}`;
      else out.push({ role: "user", content: `[工具执行返回]\n${t.content}` });
    } else out.push(t);
  }
  return out;
}
