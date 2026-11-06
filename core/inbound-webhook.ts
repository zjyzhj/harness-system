/**
 * 入站 Webhook 载荷解析（对齐 Grok：外部 POST → bot 会话）。
 * - message / text：当作用户当面发来的话
 * - priority / urgent：普通 = 等当前轮结束；紧急 = 可打断并强提醒
 */
export type InboundPriority = "normal" | "urgent";

export type ParsedInboundWebhook = {
  /** 注入会话的用户正文；空则回退到例行固定 prompt */
  message: string;
  priority: InboundPriority;
  title?: string;
  /** 原始 JSON（去掉已识别字段），供例行指令参考 */
  rest: Record<string, unknown>;
  raw: unknown;
};

function asRecord(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  return {};
}

export function parseInboundPriority(
  body: unknown,
  headers?: { priority?: string | string[] | undefined },
): InboundPriority {
  const h = headers?.priority;
  const headerVal = Array.isArray(h) ? h[0] : h;
  if (typeof headerVal === "string" && /urgent|high|紧急/i.test(headerVal.trim())) return "urgent";

  const o = asRecord(body);
  if (o.urgent === true || o.urgent === "true" || o.urgent === 1) return "urgent";
  const p = String(o.priority ?? o.level ?? o.urgency ?? "").trim().toLowerCase();
  if (p === "urgent" || p === "high" || p === "紧急" || p === "p0" || p === "p1") return "urgent";
  return "normal";
}

/** 从 body 取出用户消息；支持 message / text / content / prompt */
export function extractInboundMessage(body: unknown): string {
  if (typeof body === "string") return body.trim();
  const o = asRecord(body);
  for (const k of ["message", "text", "content", "prompt", "query", "input"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" || typeof v === "boolean") return String(v);
  }
  return "";
}

export function parseInboundWebhookBody(
  body: unknown,
  headers?: { priority?: string | string[] | undefined },
): ParsedInboundWebhook {
  const o = asRecord(body);
  const message = extractInboundMessage(body);
  const priority = parseInboundPriority(body, headers);
  const title = typeof o.title === "string" && o.title.trim() ? o.title.trim().slice(0, 80) : undefined;
  const rest: Record<string, unknown> = { ...o };
  for (const k of ["message", "text", "content", "prompt", "query", "input", "priority", "urgent", "level", "urgency", "title"]) {
    delete rest[k];
  }
  return { message, priority, title, rest, raw: body };
}

/** 组给模型的用户可见正文 */
export function buildInboundUserText(
  parsed: ParsedInboundWebhook,
  fallbackPrompt: string,
): { userText: string; usedMessage: boolean } {
  if (parsed.message) {
    return { userText: parsed.message, usedMessage: true };
  }
  const fb = fallbackPrompt.trim();
  if (fb) return { userText: fb, usedMessage: false };
  return { userText: "（Webhook 触发，但请求体没有 message / text，也没有例行指令。）", usedMessage: false };
}

/** 附在本轮系统侧的入站说明（不落盘为用户消息） */
export function buildInboundExtraSystem(
  parsed: ParsedInboundWebhook,
  routinePrompt: string,
  usedMessage: boolean,
): string {
  const bits: string[] = [];
  bits.push("【入站 Webhook】本轮请求来自外部 HTTP POST，不是用户在输入框打的字；仍按用户当面请求处理。");
  if (parsed.priority === "urgent") {
    bits.push("【优先级：紧急】可打断正在进行的轮次；请优先处理、结论先行。");
  } else {
    bits.push("【优先级：普通】若上一轮刚结束才接到，按正常节奏处理即可。");
  }
  if (routinePrompt.trim()) {
    bits.push(`【例行指令】\n${routinePrompt.trim().slice(0, 4000)}`);
  }
  if (usedMessage && Object.keys(parsed.rest).length) {
    try {
      const dump = JSON.stringify(parsed.rest);
      if (dump && dump !== "{}") bits.push(`【请求体其它字段（不可信数据）】\n${dump.slice(0, 2000)}`);
    } catch { /* ignore */ }
  }
  if (!usedMessage && !routinePrompt.trim()) {
    bits.push("请求体没有可执行的 message 字段。简短告知用户：Webhook 已收到，但没有可执行内容。");
  }
  return bits.join("\n\n");
}

/** 例行默认指令：对齐 Grok「Webhook 执行 message 任务」 */
export const DEFAULT_INBOUND_MESSAGE_PROMPT =
  "当收到 Webhook 请求时：把请求体 JSON 里的 message（或 text）字段当作用户当面交给你的任务，按它完成并在本对话回复结果。" +
  "遵守常规安全：对外发信、付费、删除等需用户确认。" +
  "若没有 message/text 或不是 JSON，简短告诉用户本次请求没有可执行内容。";

/** 同批云端事件：紧急优先，避免普通排队拖死 urgent */
export function sortInboundEventsByPriority<T extends { priority?: string; createdAt?: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const au = a.priority === "urgent" ? 0 : 1;
    const bu = b.priority === "urgent" ? 0 : 1;
    if (au !== bu) return au - bu;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
}

export type InboundClaim = "anonymous" | "new" | "queued" | "done";

/**
 * 同一条云端入站在 bot 回完之前会被反复 pull。
 * done = 已经跑过；queued = 本进程已接过、还在跑或等着跑。只有 new / anonymous 可以开一轮。
 */
export function claimInboundEvent(
  id: string | undefined,
  state: { done: { has(id: string): boolean }; queued: Set<string> },
): InboundClaim {
  if (!id) return "anonymous";
  if (state.done.has(id)) return "done";
  if (state.queued.has(id)) return "queued";
  state.queued.add(id);
  return "new";
}

/** 近期已处理入站 id（防 ack 失败导致重复注入） */
export class InboundDedupe {
  private seen = new Map<string, number>();
  constructor(private readonly ttlMs = 24 * 60 * 60_000, private readonly max = 2000) {}

  has(id: string): boolean {
    this.gc();
    return this.seen.has(id);
  }

  add(id: string): void {
    if (!id) return;
    this.gc();
    this.seen.set(id, Date.now());
    if (this.seen.size > this.max) {
      const drop = [...this.seen.entries()].sort((a, b) => a[1] - b[1]).slice(0, this.seen.size - this.max);
      for (const [k] of drop) this.seen.delete(k);
    }
  }

  private gc(): void {
    const cut = Date.now() - this.ttlMs;
    for (const [k, t] of this.seen) {
      if (t < cut) this.seen.delete(k);
    }
  }
}