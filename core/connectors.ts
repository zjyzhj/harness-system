/**
 * 本机「连接器」目录：HTTP Webhook 端点登记（非 OAuth 应用市场）。
 * MCP / CLI 状态由 Vault 聚合层从现有模块读取。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./atomic-fs";

export interface WebhookEndpoint {
  id: string;
  name: string;
  url: string;
  /** 可选说明；Token 用 {{secret:}} 占位，不存明文 */
  note?: string;
  headers?: Record<string, string>;
  updatedAt: number;
}

export class ConnectorStore {
  private file: string;
  private webhooks: WebhookEndpoint[] = [];

  constructor(home: string) {
    this.file = join(home, "connectors.json");
    const data = readJsonSafe<{ webhooks?: WebhookEndpoint[] }>(this.file, {});
    this.webhooks = Array.isArray(data?.webhooks) ? data.webhooks.filter((w) => w?.id && w?.url) : [];
  }

  private persist() {
    writeJsonAtomic(this.file, { webhooks: this.webhooks }, { mode: 0o600 });
  }

  listWebhooks(): WebhookEndpoint[] {
    return [...this.webhooks].sort((a, b) => a.name.localeCompare(b.name, "zh"));
  }

  upsertWebhook(input: { id?: string; name: string; url: string; note?: string; headers?: Record<string, string> }): WebhookEndpoint {
    const name = input.name.trim();
    const url = input.url.trim();
    if (!name || !url) throw new Error("Webhook 需要 name 和 url");
    if (!/^https?:\/\//i.test(url)) throw new Error("Webhook url 需以 http(s):// 开头");
    const id = input.id?.trim() || randomUUID();
    const w: WebhookEndpoint = {
      id,
      name,
      url,
      note: input.note?.trim() || undefined,
      headers: input.headers,
      updatedAt: Date.now(),
    };
    const i = this.webhooks.findIndex((x) => x.id === id);
    if (i >= 0) this.webhooks[i] = w;
    else this.webhooks.push(w);
    this.persist();
    return w;
  }

  removeWebhook(id: string): boolean {
    const before = this.webhooks.length;
    this.webhooks = this.webhooks.filter((w) => w.id !== id);
    if (this.webhooks.length === before) return false;
    this.persist();
    return true;
  }
}
