import type { Bot, ChatMessage } from "./types";

/**
 * 跨进程/跨机器 bot 通信 Transport — 对标 CowAgent agent/multiagent/transport.py
 * 契约：send(peer, msg) + onMessage 回调。默认无 transport（进程内总线即可）。
 */

export interface TransportMessage {
  from: string;          // bot id
  to: string;            // bot id（远程）
  text: string;
  sessionId?: string;
  kind?: "bot-to-bot";
  timestamp: number;
}

export interface Transport {
  readonly kind: string;
  /** 向远程 peer 发消息（远程 bot 收到后回调 onMessage） */
  send(msg: TransportMessage): Promise<boolean>;
  /** 注册收到远程消息的回调 */
  onMessage(cb: (msg: TransportMessage) => void): () => void;
  /** 健康检查 */
  ping?(): Promise<boolean>;
}

/** 进程内 Transport：直接回调（同进程 peer 用，MessageBus 默认路径） */
export class LocalTransport implements Transport {
  readonly kind = "local";
  private listeners = new Set<(msg: TransportMessage) => void>();
  constructor(private resolveBot: (id: string) => Bot | null) {}
  async send(msg: TransportMessage): Promise<boolean> {
    if (!this.resolveBot(msg.to)) return false;
    for (const fn of this.listeners) fn(msg);
    return true;
  }
  onMessage(cb: (msg: TransportMessage) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

/** HTTP Transport：通过远程 gateway 转发（预留；MVP 不启用） */
export class HttpTransport implements Transport {
  readonly kind = "http";
  private listeners = new Set<(msg: TransportMessage) => void>();
  constructor(private gatewayUrl: string, private token?: string) {}

  async send(msg: TransportMessage): Promise<boolean> {
    try {
      const res = await fetch(this.gatewayUrl.replace(/\/$/, "") + "/bots/msg", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify(msg),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
  onMessage(cb: (msg: TransportMessage) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  /** 接收来自 gateway 的投递（网关回调此方法） */
  deliver(msg: TransportMessage) {
    for (const fn of this.listeners) fn(msg);
  }
  async ping(): Promise<boolean> {
    try {
      const res = await fetch(this.gatewayUrl.replace(/\/$/, "") + "/health", { method: "GET" });
      return res.ok;
    } catch {
      return false;
    }
  }
}
