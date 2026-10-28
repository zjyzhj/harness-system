import type { Bot, ChatMessage, ContentBlock } from "./types";
import type { Store } from "./store";
import type { Transport, TransportMessage } from "./transport";

/** recorded=true：handler（通常是 runtime）已落盘回复，总线不再写一条重复的 assistant */
export type HandlerReply = string | { text: string; recorded?: boolean };
export type BotMessageHandler = (from: Bot, to: Bot, text: string, ctx: MessageContext) => Promise<HandlerReply>;
export type ContentLike = string | ContentBlock[];

function replyText(r: HandlerReply): string {
  return typeof r === "string" ? r : r.text;
}
function replyRecorded(r: HandlerReply): boolean {
  return typeof r === "object" && !!r.recorded;
}

export interface MessageContext {
  sessionId: string;
  bus: MessageBus;
}

export interface MessageBusOptions {
  handlers: Map<string, BotMessageHandler>;
}

/**
 * 进程内多 bot 通信总线。
 * send(from → to)：把消息投递给目标 bot 的 handler，并把 handler 的回复作为新消息回流。
 */
export class MessageBus {
  private handlers = new Map<string, BotMessageHandler>();
  private listeners = new Set<(m: ChatMessage) => void>();
  private transports: Transport[] = [];

  constructor(private store: Store) {}

  /** 注册远程 transport（可多个） */
  addTransport(t: Transport) {
    this.transports.push(t);
    t.onMessage((msg) => this.handleRemote(msg));
  }

  /** G4：网关投递远程消息（可等 handler 完成，返回是否路由成功） */
  async deliverRemote(msg: TransportMessage): Promise<boolean> {
    const bot = this.store.getBot(msg.to);
    if (!bot) return false;
    const handler = this.handlers.get(msg.to);
    if (!handler) return false;
    const from = this.store.getBot(msg.from) ?? { id: msg.from, name: msg.from, role: "远程", persona: "", providerId: "", petEnabled: false, createdAt: Date.now() };
    const rich = msg.content && Array.isArray(msg.content) ? msg.content : msg.text;
    const sid = msg.sessionId ?? `x-${Date.now()}`;
    const reply = await handler(from, bot, msg.text, { sessionId: sid, bus: this });
    const text = replyText(reply);
    const replyMsg: ChatMessage = {
      sessionId: sid, from: bot.id, to: msg.from, role: "assistant", content: text, kind: "bot-to-bot", createdAt: Date.now(),
    };
    if (!replyRecorded(reply)) { this.store.addMessage(replyMsg); this.emit(replyMsg); }
    for (const t of this.transports) {
      void t.send({ from: bot.id, to: msg.from, text, content: rich, sessionId: sid, timestamp: Date.now() });
    }
    return true;
  }

  private handleRemote(msg: TransportMessage) {
    // 远程 bot 发来消息 → 找本地 handler 处理并回执
    const bot = this.store.getBot(msg.to);
    if (!bot) return;
    const handler = this.handlers.get(msg.to);
    if (!handler) return;
    const from = this.store.getBot(msg.from) ?? { id: msg.from, name: msg.from, role: "远程", persona: "", providerId: "", petEnabled: false, createdAt: Date.now() };
    const sid = msg.sessionId ?? `x-${Date.now()}`;
    void handler(from, bot, msg.text, { sessionId: sid, bus: this }).then((reply) => {
      const text = replyText(reply);
      const replyMsg: ChatMessage = {
        sessionId: sid, from: bot.id, to: msg.from, role: "assistant", content: text, kind: "bot-to-bot", createdAt: Date.now(),
      };
      if (!replyRecorded(reply)) { this.store.addMessage(replyMsg); this.emit(replyMsg); }
      for (const t of this.transports) {
        void t.send({ from: bot.id, to: msg.from, text, content: text, sessionId: sid, timestamp: Date.now() });
      }
    });
  }

  register(botId: string, handler: BotMessageHandler) {
    this.handlers.set(botId, handler);
  }
  unregister(botId: string) {
    this.handlers.delete(botId);
  }
  has(botId: string) {
    return this.handlers.has(botId);
  }
  onMessage(fn: (m: ChatMessage) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async send(from: Bot, to: Bot, text: string | ContentBlock[], sessionId?: string): Promise<ChatMessage[]> {
    const sid = sessionId || `s-${Date.now()}`;
    const outgoing: ChatMessage = {
      sessionId: sid, from: from.id, to: to.id, role: "user", content: text,
      kind: "bot-to-bot", createdAt: Date.now(),
    };
    this.store.addMessage(outgoing);
    this.emit(outgoing);

    const handler = this.handlers.get(to.id);
    if (!handler) {
      // 尝试走远程 transport（目标不在本地）
      if (this.transports.length) {
        let delivered = false;
        for (const t of this.transports) {
          if (await t.send({ from: from.id, to: to.id, text: typeof text === "string" ? text : text.map((b) => (b as any).text ?? "").join("\n"), content: text, sessionId: sid, timestamp: Date.now() })) delivered = true;
        }
        if (delivered) return [outgoing];
      }
      const err: ChatMessage = {
        sessionId: sid, from: to.id, to: from.id, role: "assistant", content: `⚠️ bot ${to.name} 未注册消息处理器（当前仅主控可调用它）。`,
        kind: "bot-to-bot", createdAt: Date.now(),
      };
      this.store.addMessage(err);
      this.emit(err);
      return [outgoing, err];
    }

    const textForLLM = typeof text === "string" ? text : text.filter((b) => (b as any).type === "text").map((b) => (b as any).text ?? "").join("\n");
    const raw = await handler(from, to, textForLLM, { sessionId: sid, bus: this }).catch((e: unknown) => {
      const reply: ChatMessage = {
        sessionId: sid, from: to.id, to: from.id, role: "assistant",
        content: `❌ ${to.name} 处理失败：${e instanceof Error ? e.message : String(e)}`,
        kind: "bot-to-bot", createdAt: Date.now(),
      };
      this.store.addMessage(reply);
      this.emit(reply);
      return "" as HandlerReply;
    });
    const textOut = replyText(raw);
    if (!textOut) return [outgoing];
    const reply: ChatMessage = {
      sessionId: sid, from: to.id, to: from.id, role: "assistant", content: textOut,
      kind: "bot-to-bot", createdAt: Date.now(),
    };
    if (!replyRecorded(raw)) { this.store.addMessage(reply); this.emit(reply); }
    return [outgoing, reply];
  }

  /** G4：群组广播 — 向组内所有成员 bot 发同一消息（各自独立会话） */
  async broadcast(groupId: string, from: Bot, text: string | ContentBlock[], sessionIdPrefix = "group"): Promise<ChatMessage[]> {
    const members = this.groups ? this.groups.members(groupId) : [];
    const results: ChatMessage[] = [];
    for (const botId of members) {
      const bot = this.store.getBot(botId);
      if (!bot || bot.id === from.id) continue;
      const sid = `${sessionIdPrefix}-${groupId}-${Date.now()}-${botId}`;
      const msgs = await this.send(from, bot, text, sid).catch(() => [] as ChatMessage[]);
      results.push(...msgs);
    }
    return results;
  }

  /** G4：注入群组注册表（广播成员解析用） */
  setGroups(g: import("./group-registry").GroupRegistry) {
    this.groups = g;
  }
  private groups: import("./group-registry").GroupRegistry | null = null;

  /** 主控向某 bot 发消息（用户→bot） */
  async chat(bot: Bot, text: string | ContentBlock[], sessionId?: string): Promise<ChatMessage[]> {
    const sid = sessionId || `s-${Date.now()}`;
    const userMsg: ChatMessage = {
      sessionId: sid, from: "user", to: bot.id, role: "user", content: text,
      kind: "chat", createdAt: Date.now(),
    };
    this.store.addMessage(userMsg);
    this.emit(userMsg);
    const handler = this.handlers.get(bot.id);
    if (!handler) {
      const err: ChatMessage = {
        sessionId: sid, from: bot.id, to: "user", role: "assistant",
        content: `⚠️ ${bot.name} 尚未激活（无消息处理器）。请先在主控面板启用它或配置 provider。`,
        kind: "chat", createdAt: Date.now(),
      };
      this.store.addMessage(err);
      this.emit(err);
      return [userMsg, err];
    }
    const textForLLM = typeof text === "string" ? text : text.filter((b) => (b as any).type === "text").map((b) => (b as any).text ?? "").join("\n");
    // from 必须是 user，不能传 bot 自己：否则 runtime 会把回复记成 bot-to-bot，系统通知也会被跳过
    const userFrom: Bot = { id: "user", name: "用户", role: "user", persona: "", providerId: "", petEnabled: false, createdAt: 0 };
    const raw = await handler(userFrom, bot, textForLLM, { sessionId: sid, bus: this }).catch((e: unknown) => {
      const err: ChatMessage = {
        sessionId: sid, from: bot.id, to: "user", role: "assistant",
        content: `❌ ${bot.name} 回复失败：${e instanceof Error ? e.message : String(e)}`,
        kind: "chat", createdAt: Date.now(),
      };
      this.store.addMessage(err);
      this.emit(err);
      return "" as HandlerReply;
    });
    const textOut = replyText(raw);
    if (!textOut) return [userMsg];
    const a: ChatMessage = {
      sessionId: sid, from: bot.id, to: "user", role: "assistant", content: textOut,
      kind: "chat", createdAt: Date.now(),
    };
    if (!replyRecorded(raw)) { this.store.addMessage(a); this.emit(a); }
    return [userMsg, a];
  }

  private emit(m: ChatMessage) {
    for (const fn of this.listeners) fn(m);
  }
}
