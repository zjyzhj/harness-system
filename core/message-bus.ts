import type { Bot, ChatMessage } from "./types";
import type { Store } from "./store";

export type BotMessageHandler = (from: Bot, to: Bot, text: string, ctx: MessageContext) => Promise<string>;

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

  constructor(private store: Store) {}

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

  async send(from: Bot, to: Bot, text: string, sessionId?: string): Promise<ChatMessage[]> {
    const sid = sessionId || `s-${Date.now()}`;
    const outgoing: ChatMessage = {
      sessionId: sid, from: from.id, to: to.id, role: "user", content: text,
      kind: "bot-to-bot", createdAt: Date.now(),
    };
    this.store.addMessage(outgoing);
    this.emit(outgoing);

    const handler = this.handlers.get(to.id);
    if (!handler) {
      const err: ChatMessage = {
        sessionId: sid, from: to.id, to: from.id, role: "assistant", content: `⚠️ bot ${to.name} 未注册消息处理器（当前仅主控可调用它）。`,
        kind: "bot-to-bot", createdAt: Date.now(),
      };
      this.store.addMessage(err);
      this.emit(err);
      return [outgoing, err];
    }

    const replyText = await handler(from, to, text, { sessionId: sid, bus: this }).catch((e: unknown) => {
      const reply: ChatMessage = {
        sessionId: sid, from: to.id, to: from.id, role: "assistant",
        content: `❌ ${to.name} 处理失败：${e instanceof Error ? e.message : String(e)}`,
        kind: "bot-to-bot", createdAt: Date.now(),
      };
      this.store.addMessage(reply);
      this.emit(reply);
      return "" as string & void;
    });
    if (typeof replyText === "string" && replyText) {
      const reply: ChatMessage = {
        sessionId: sid, from: to.id, to: from.id, role: "assistant", content: replyText,
        kind: "bot-to-bot", createdAt: Date.now(),
      };
      this.store.addMessage(reply);
      this.emit(reply);
      return [outgoing, reply];
    }
    return [outgoing];
  }

  /** 主控向某 bot 发消息（用户→bot） */
  async chat(bot: Bot, text: string, sessionId?: string): Promise<ChatMessage[]> {
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
    const reply = await handler(bot, bot, text, { sessionId: sid, bus: this }).catch((e: unknown) => {
      const err: ChatMessage = {
        sessionId: sid, from: bot.id, to: "user", role: "assistant",
        content: `❌ ${bot.name} 回复失败：${e instanceof Error ? e.message : String(e)}`,
        kind: "chat", createdAt: Date.now(),
      };
      this.store.addMessage(err);
      this.emit(err);
      return "" as string & void;
    });
    if (typeof reply === "string" && reply) {
      const a: ChatMessage = {
        sessionId: sid, from: bot.id, to: "user", role: "assistant", content: reply,
        kind: "chat", createdAt: Date.now(),
      };
      this.store.addMessage(a);
      this.emit(a);
      return [userMsg, a];
    }
    return [userMsg];
  }

  private emit(m: ChatMessage) {
    for (const fn of this.listeners) fn(m);
  }
}
