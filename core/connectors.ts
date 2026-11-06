/**
 * 本机「连接器」目录：HTTP Webhook 端点登记（非 OAuth 应用市场）。
 * MCP / CLI 状态由 Vault 聚合层从现有模块读取。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./atomic-fs";
import { isPrivateHost, PrivateAddressError, readCapped, safeFetch } from "./web-search";

export interface WebhookEndpoint {
  id: string;
  name: string;
  url: string;
  /** 可选说明；Token 用 {{secret:}} 占位，不存明文 */
  note?: string;
  headers?: Record<string, string>;
  updatedAt: number;
}

/** Connect 安装卡片（本机目录，非 OAuth 市场） */
export interface ConnectInstallCard {
  id: string;
  name: string;
  blurb: string;
  kind: "builtin" | "mcp" | "webhook" | "secret" | "computer" | "share";
  /** MCP 本地命令安装草稿 */
  mcp?: { name: string; command: string; args: string[]; envHint?: string };
  badge?: string;
}

/** 兼容旧配置/文档的示例地址；新用户应走 Connect「用 Cloudflare 开通」得到专属 workers.dev */
export const DEFAULT_SHARE_BRIDGE_BASE = "https://harness-share-bridge.harness-zjy.workers.dev";

export const CONNECT_INSTALL_CARDS: ConnectInstallCard[] = [
  {
    id: "share-bridge",
    name: "云服务 · 短链桥",
    blurb: "粘贴 Cloudflare API Token，软件生成并返回你的 *.workers.dev 公网地址。",
    kind: "share",
    badge: "云",
  },
  {
    id: "computer-use",
    name: "电脑操控",
    blurb: "看屏幕、点按钮、打字（辅助功能树）。本机内置，开开关即可。",
    kind: "computer",
    badge: "内置",
  },
  {
    id: "secrets",
    name: "密钥保险库",
    blurb: "API Key / Token 加密存本机，技能里写 {{secret:名字}}。",
    kind: "secret",
    badge: "本机",
  },
  {
    id: "webhook-out",
    name: "出站 Webhook",
    blurb: "把结果 POST 到你的 HTTP 端点。Header 用 {{secret:…}}，不存明文。",
    kind: "webhook",
  },
  {
    id: "mcp-filesystem",
    name: "Filesystem MCP",
    blurb: "经 MCP 暴露指定目录读写（另有内置 fs.* 工具）。",
    kind: "mcp",
    mcp: {
      name: "filesystem",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "~/Documents"],
    },
  },
  {
    id: "mcp-fetch",
    name: "Fetch MCP",
    blurb: "经 MCP 抓取网页正文（另有内置 web.fetch）。",
    kind: "mcp",
    mcp: {
      name: "fetch",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-fetch"],
    },
  },
  {
    id: "mcp-github",
    name: "GitHub MCP",
    blurb: "仓库/Issue/PR。需先在保险库存 GITHUB_TOKEN。",
    kind: "mcp",
    mcp: {
      name: "github",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      envHint: "GITHUB_PERSONAL_ACCESS_TOKEN={{secret:GITHUB_TOKEN}}",
    },
  },
];

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

  findWebhook(idOrName: string): WebhookEndpoint | undefined {
    const q = idOrName.trim();
    if (!q) return undefined;
    return this.webhooks.find((w) => w.id === q)
      ?? this.webhooks.find((w) => w.name === q)
      ?? this.webhooks.find((w) => w.name.toLowerCase() === q.toLowerCase());
  }

  /**
   * 真正 POST 到已登记端点。headers 经 fillSecrets 展开 {{secret:}}。
   * 默认禁内网；allowPrivate 由调用方在用户授权后传入。
   */
  async postWebhook(
    idOrName: string,
    payload: unknown,
    opts: {
      fillSecrets?: (h: Record<string, string>) => Record<string, string>;
      allowPrivate?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<{ ok: true; status: number; body: string; name: string; url: string } | { ok: false; error: string }> {
    const w = this.findWebhook(idOrName);
    if (!w) return { ok: false, error: `找不到 Webhook「${idOrName}」` };
    let host: string;
    try { host = new URL(w.url).hostname; } catch { return { ok: false, error: "Webhook url 无效" }; }
    const priv = await isPrivateHost(host);
    if (priv && !opts.allowPrivate) {
      return { ok: false, error: `${host} 是本机或局域网地址，需用户授权后再发` };
    }
    const headers = opts.fillSecrets?.(w.headers ?? {}) ?? { ...(w.headers ?? {}) };
    try {
      const res = await safeFetch(w.url, {
        method: "POST",
        allowPrivate: !!opts.allowPrivate,
        signal: opts.signal ?? AbortSignal.timeout(30_000),
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(payload ?? {}),
      });
      const body = await readCapped(res, 64_000);
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
      return { ok: true, status: res.status, body: body.slice(0, 4000), name: w.name, url: w.url };
    } catch (e) {
      if (e instanceof PrivateAddressError) return { ok: false, error: e.message };
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
