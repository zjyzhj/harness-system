/**
 * 本机保险库聚合：密钥 + 环境 + 通讯录 + 连接器目录（只读清单给 bot / 设置页）。
 * 值仍经 {{secret:}} / EnvStore；不做云邮箱身份、不做 OAuth 应用市场。
 */
import type { SecretStore, SecretInfo } from "./secret-store";
import type { EnvStore, EnvEntry } from "./env-store";
import type { ContactStore, Contact } from "./contacts";
import type { ConnectorStore, WebhookEndpoint } from "./connectors";

export type VaultKind = "secret" | "env" | "contact" | "webhook" | "mcp" | "cli";

export interface VaultItem {
  kind: VaultKind;
  id: string;
  title: string;
  detail?: string;
  /** 绝不含密钥明文 */
  meta?: Record<string, string | number | boolean | undefined>;
}

export interface McpCatalogEntry {
  id: string;
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  tools: number;
  error?: string;
}

export interface CliAdapterStatus {
  id: string;
  name: string;
  ready: boolean;
  detail?: string;
}

export interface VaultSources {
  secrets: SecretStore;
  env: EnvStore;
  contacts: ContactStore;
  connectors: ConnectorStore;
  mcp?: () => McpCatalogEntry[];
  cli?: () => CliAdapterStatus[];
}

export class Vault {
  constructor(private src: VaultSources) {}

  list(botId?: string): VaultItem[] {
    const items: VaultItem[] = [];
    for (const s of this.src.secrets.list(botId)) items.push(secretItem(s));
    for (const e of botId ? this.src.env.visibleTo(botId) : this.src.env.list()) items.push(envItem(e));
    for (const c of this.src.contacts.list()) items.push(contactItem(c));
    for (const w of this.src.connectors.listWebhooks()) items.push(webhookItem(w));
    for (const m of this.src.mcp?.() ?? []) items.push(mcpItem(m));
    for (const c of this.src.cli?.() ?? []) items.push(cliItem(c));
    return items;
  }

  search(query: string, botId?: string): VaultItem[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.list(botId);
    return this.list(botId).filter(
      (x) =>
        x.title.toLowerCase().includes(q) ||
        (x.detail ?? "").toLowerCase().includes(q) ||
        x.kind.includes(q) ||
        x.id.toLowerCase().includes(q),
    );
  }

  contact(idOrName: string): Contact | undefined {
    return this.src.contacts.get(idOrName);
  }

  contacts(): Contact[] {
    return this.src.contacts.list();
  }

  webhooks(): WebhookEndpoint[] {
    return this.src.connectors.listWebhooks();
  }

  catalog(): {
    secrets: number;
    env: number;
    contacts: number;
    webhooks: number;
    mcp: McpCatalogEntry[];
    cli: CliAdapterStatus[];
  } {
    return {
      secrets: this.src.secrets.list().length,
      env: this.src.env.list().length,
      contacts: this.src.contacts.list().length,
      webhooks: this.src.connectors.listWebhooks().length,
      mcp: this.src.mcp?.() ?? [],
      cli: this.src.cli?.() ?? [],
    };
  }
}

function secretItem(s: SecretInfo): VaultItem {
  return {
    kind: "secret",
    id: s.name,
    title: s.label && s.label !== s.name ? `${s.label}（${s.name}）` : s.name,
    detail: [s.note, "账号级共用"].filter(Boolean).join(" · "),
    meta: { botId: s.botId, savedAt: s.savedAt },
  };
}

function envItem(e: EnvEntry): VaultItem {
  const preview = e.value.length > 80 ? `${e.value.slice(0, 80)}…` : e.value;
  return {
    kind: "env",
    id: e.key,
    title: e.label ? `${e.label}（${e.key}）` : e.key,
    detail: [preview, e.note].filter(Boolean).join(" · "),
    meta: { botId: e.botId },
  };
}

function contactItem(c: Contact): VaultItem {
  return {
    kind: "contact",
    id: c.id,
    title: c.name,
    detail: [c.email, c.note].filter(Boolean).join(" · "),
  };
}

function webhookItem(w: WebhookEndpoint): VaultItem {
  return {
    kind: "webhook",
    id: w.id,
    title: w.name,
    detail: [w.url, w.note].filter(Boolean).join(" · "),
  };
}

function mcpItem(m: McpCatalogEntry): VaultItem {
  return {
    kind: "mcp",
    id: m.id,
    title: m.name,
    detail: m.error ? `✕ ${m.error}` : `${m.tools} 工具 · ${m.url ?? [m.command, ...(m.args ?? [])].filter(Boolean).join(" ")}`,
    meta: { tools: m.tools, error: !!m.error },
  };
}

function cliItem(c: CliAdapterStatus): VaultItem {
  return {
    kind: "cli",
    id: c.id,
    title: c.name,
    detail: c.ready ? c.detail || "可用" : `未就绪${c.detail ? `：${c.detail}` : ""}`,
    meta: { ready: c.ready },
  };
}
