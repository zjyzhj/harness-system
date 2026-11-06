/**
 * Cloudflare Worker 短链桥：把超长 harnessbot:// 换成可转发的 HTTPS。
 * 凭证默认读 ~/.config/harness-bot/share-bridge.env（deploy 脚本或设置页写入）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SHARE_BRIDGE_BASE } from "./connectors";

export type ShareBridgeCreds = { base: string; putKey: string; ttlDays: number };
export { DEFAULT_SHARE_BRIDGE_BASE };

export type ShareBridgeStatus = {
  configured: boolean;
  base: string;
  /** 是否已有 PUT_KEY（不回传明文） */
  hasKey: boolean;
  /** 脱敏预览，如 ab…xy */
  keyHint: string;
  path: string;
  /** 新建短链默认有效天数（1–365） */
  ttlDays: number;
  /** 环境变量覆盖时提示不可用设置页改写 */
  fromEnv: boolean;
};

export function clampShareTtlDays(raw: unknown, fallback = 90): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(365, Math.floor(n)));
}

export function shareBridgeDir(home = join(homedir(), ".config/harness-bot")): string {
  return home;
}

export function shareBridgeEnvPath(home = join(homedir(), ".config/harness-bot")): string {
  return join(home, "share-bridge.env");
}

function loadEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    out[t.slice(0, i)] = t.slice(i + 1).trim();
  }
  return out;
}

function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 6) return "••••";
  return `${key.slice(0, 2)}…${key.slice(-2)}`;
}

/** 本地 deploy / 设置页写入的凭证；也可用环境变量覆盖 */
export function shareBridgeCreds(home = join(homedir(), ".config/harness-bot")): ShareBridgeCreds | null {
  const env = loadEnvFile(shareBridgeEnvPath(home));
  const base = (process.env.SHARE_BRIDGE_BASE || env.SHARE_BRIDGE_BASE || "").replace(/\/$/, "");
  const putKey = process.env.SHARE_BRIDGE_PUT_KEY || process.env.PUT_KEY || env.PUT_KEY || "";
  if (!base || !putKey) return null;
  const ttlDays = clampShareTtlDays(process.env.SHARE_BRIDGE_TTL_DAYS || env.SHARE_BRIDGE_TTL_DAYS || 90);
  return { base, putKey, ttlDays };
}

/** 设置页状态（不含明文密钥） */
export function shareBridgeStatus(home = join(homedir(), ".config/harness-bot")): ShareBridgeStatus {
  const path = shareBridgeEnvPath(home);
  const file = loadEnvFile(path);
  const fromEnv = !!(process.env.SHARE_BRIDGE_BASE || process.env.SHARE_BRIDGE_PUT_KEY || process.env.PUT_KEY);
  const base = (process.env.SHARE_BRIDGE_BASE || file.SHARE_BRIDGE_BASE || "").replace(/\/$/, "");
  const putKey = process.env.SHARE_BRIDGE_PUT_KEY || process.env.PUT_KEY || file.PUT_KEY || "";
  const ttlDays = clampShareTtlDays(process.env.SHARE_BRIDGE_TTL_DAYS || file.SHARE_BRIDGE_TTL_DAYS || 90);
  return {
    configured: !!(base && putKey),
    base,
    hasKey: !!putKey,
    keyHint: maskKey(putKey),
    path,
    ttlDays,
    fromEnv,
  };
}

/** 保存凭证到 share-bridge.env（mode 0600）；putKey 空字符串表示保留原值 */
export function saveShareBridgeCreds(
  input: { base: string; putKey?: string; ttlDays?: number },
  home = join(homedir(), ".config/harness-bot"),
): ShareBridgeStatus {
  const base = String(input.base ?? "").trim().replace(/\/$/, "");
  if (!base) throw new Error("请填写短链服务地址（https://…workers.dev）");
  let u: URL;
  try { u = new URL(base); } catch { throw new Error("短链服务地址不是合法 URL"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("短链服务地址需以 http(s):// 开头");
  const path = shareBridgeEnvPath(home);
  const prev = loadEnvFile(path);
  const nextKey = (input.putKey != null && String(input.putKey).trim())
    ? String(input.putKey).trim()
    : (prev.PUT_KEY || "");
  if (!nextKey) throw new Error("请填写 PUT_KEY（部署短链桥时生成的密钥）");
  const ttlDays = clampShareTtlDays(
    input.ttlDays != null ? input.ttlDays : (prev.SHARE_BRIDGE_TTL_DAYS || 90),
  );
  mkdirSync(home, { recursive: true });
  writeFileSync(
    path,
    `PUT_KEY=${nextKey}\nSHARE_BRIDGE_BASE=${base}\nSHARE_BRIDGE_TTL_DAYS=${ttlDays}\n`,
    { mode: 0o600 },
  );
  return shareBridgeStatus(home);
}

/** 清除本机短链凭证文件（不影响进程环境变量） */
export function clearShareBridgeCreds(home = join(homedir(), ".config/harness-bot")): ShareBridgeStatus {
  const path = shareBridgeEnvPath(home);
  if (existsSync(path)) writeFileSync(path, "", { mode: 0o600 });
  return shareBridgeStatus(home);
}

export type ShortLinkResult = { id: string; url: string; open: string };

async function dohA(host: string): Promise<string | null> {
  try {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`, {
      headers: { accept: "application/dns-json" },
    });
    const j = await r.json() as { Answer?: { type: number; data: string }[] };
    return j.Answer?.find((a) => a.type === 1)?.data?.trim() || null;
  } catch {
    return null;
  }
}

/** 本机若把 workers.dev 指到假 IP（常见于代理 fake-ip），用 DoH + curl --resolve 绕过 */
async function fetchShareBridge(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (first) {
    const host = new URL(url).hostname;
    if (!host.endsWith(".workers.dev")) throw first;
    const ip = await dohA(host);
    if (!ip) throw first;
    const { spawnSync } = await import("node:child_process");
    const method = (init?.method || "GET").toUpperCase();
    const headers = init?.headers ? Object.entries(init.headers as Record<string, string>).flatMap(([k, v]) => ["-H", `${k}: ${v}`]) : [];
    const body = init?.body != null ? ["--data-binary", String(init.body)] : [];
    const args = ["-sS", "--resolve", `${host}:443:${ip}`, "-X", method, ...headers, ...body, "-w", "\n__HTTP__:%{http_code}", url];
    const out = spawnSync("curl", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    if (out.error || out.status !== 0) throw first;
    const raw = out.stdout ?? "";
    const m = raw.match(/\n__HTTP__:(\d+)\s*$/);
    const status = m ? Number(m[1]) : 200;
    const bodyText = m ? raw.slice(0, m.index) : raw;
    return new Response(bodyText, { status, headers: { "Content-Type": "application/json" } });
  }
}

/** 探测短链桥是否可达（GET /health） */
export async function probeShareBridge(creds = shareBridgeCreds()): Promise<{
  ok: boolean;
  status?: number;
  base?: string;
  error?: string;
  service?: string;
}> {
  if (!creds) return { ok: false, error: "尚未配置短链桥地址与 PUT_KEY" };
  try {
    const r = await fetchShareBridge(`${creds.base}/health`);
    const text = await r.text();
    let service: string | undefined;
    try { service = (JSON.parse(text) as { service?: string }).service; } catch { /* ignore */ }
    if (!r.ok) return { ok: false, status: r.status, base: creds.base, error: `HTTP ${r.status}` };
    return { ok: true, status: r.status, base: creds.base, service: service || "harness-share-bridge" };
  } catch (e) {
    return { ok: false, base: creds.base, error: e instanceof Error ? e.message : String(e) };
  }
}

export type ShareLinkItem = {
  id: string;
  name: string;
  role: string;
  createdAt: number;
  expiresInDays?: number;
  url: string;
  open: string;
};

async function authJson(
  path: string,
  init: RequestInit,
  creds: ShareBridgeCreds,
): Promise<{ status: number; data: any }> {
  const r = await fetchShareBridge(`${creds.base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${creds.putKey}`,
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const text = await r.text();
  let data: any = {};
  try { data = text.trim() ? JSON.parse(text) : {}; } catch { /* ignore */ }
  return { status: r.status, data };
}

/** 上传 harnessbot:// 链接，返回短链；失败抛错 */
export async function putHarnessShortLink(
  link: string,
  meta?: { name?: string; role?: string },
  creds = shareBridgeCreds(),
): Promise<ShortLinkResult & { expiresInDays?: number }> {
  if (!creds) throw new Error("未配置短链桥（缺少 share-bridge.env）");
  if (!link.startsWith("harnessbot://")) throw new Error("只接受 harnessbot:// 链接");
  const { status, data } = await authJson("/api/put", {
    method: "POST",
    body: JSON.stringify({
      link,
      name: meta?.name ?? "",
      role: meta?.role ?? "",
      ttlDays: creds.ttlDays,
    }),
  }, creds);
  if (status !== 200 || !data.ok || !data.url || !data.id) {
    throw new Error(data.error || `短链失败 HTTP ${status}`);
  }
  return {
    id: data.id,
    url: data.url,
    open: data.open || `${data.url}?open=1`,
    expiresInDays: data.expiresInDays,
  };
}

/** 列出本机 PUT_KEY 下的短链（不含协议内容） */
export async function listShareBridgeLinks(creds = shareBridgeCreds()): Promise<{
  items: ShareLinkItem[];
  truncated: boolean;
  ttlDays: number;
}> {
  if (!creds) throw new Error("尚未配置短链桥");
  const { status, data } = await authJson("/api/list", { method: "GET" }, creds);
  if (status !== 200 || !data.ok) throw new Error(data.error || `列出失败 HTTP ${status}`);
  return {
    items: Array.isArray(data.items) ? data.items : [],
    truncated: !!data.truncated,
    ttlDays: Number(data.ttlDays) || 90,
  };
}

/** 撤销一条短链（立刻失效） */
export async function deleteShareBridgeLink(id: string, creds = shareBridgeCreds()): Promise<void> {
  if (!creds) throw new Error("尚未配置短链桥");
  const clean = String(id || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!clean) throw new Error("短链 id 无效");
  const { status, data } = await authJson(`/api/b/${clean}`, { method: "DELETE" }, creds);
  if (status === 404) throw new Error("短链不存在或已过期");
  if (status !== 200 || !data.ok) throw new Error(data.error || `删除失败 HTTP ${status}`);
}

/** 公网入站 URL（外部系统 POST；本机轮询拉取） */
export function cloudInboundWebhookUrl(token: string, creds = shareBridgeCreds()): string | undefined {
  if (!creds?.base || !token) return undefined;
  const clean = String(token).replace(/[^A-Za-z0-9_-]/g, "");
  if (clean.length < 8) return undefined;
  return `${creds.base.replace(/\/$/, "")}/w/${clean}`;
}

export type CloudInboundEvent = {
  id: string;
  token: string;
  body: unknown;
  priority: string;
  createdAt: number;
  kvKey: string;
};

function cleanInboundTokens(tokens: string[]): string[] {
  return [...new Set(tokens.map((t) => String(t || "").replace(/[^A-Za-z0-9_-]/g, "")).filter((t) => t.length >= 8 && t.length <= 128))];
}

/** 向短链桥登记能力令牌（未登记的 /w/:token 会 404，防扫号灌库） */
export async function registerCloudInboundTokens(
  tokens: string[],
  creds = shareBridgeCreds(),
): Promise<number> {
  if (!creds) return 0;
  const clean = cleanInboundTokens(tokens);
  if (!clean.length) return 0;
  const { status, data } = await authJson("/api/inbound/register", {
    method: "POST",
    body: JSON.stringify({ tokens: clean }),
  }, creds);
  if (status !== 200 || !data.ok) throw new Error(data.error || `入站登记失败 HTTP ${status}`);
  return Number(data.registered) || 0;
}

/** 撤销云端能力令牌登记（关闭 / 换新时） */
export async function unregisterCloudInboundTokens(
  tokens: string[],
  creds = shareBridgeCreds(),
): Promise<number> {
  if (!creds) return 0;
  const clean = cleanInboundTokens(tokens);
  if (!clean.length) return 0;
  const { status, data } = await authJson("/api/inbound/unregister", {
    method: "POST",
    body: JSON.stringify({ tokens: clean }),
  }, creds);
  if (status !== 200 || !data.ok) throw new Error(data.error || `入站注销失败 HTTP ${status}`);
  return Number(data.unregistered) || 0;
}

/** 本机拉取云端入站队列（需 PUT_KEY；tokens 放 POST body，避免进 access log） */
export async function pullCloudInboundEvents(
  tokens: string[],
  creds = shareBridgeCreds(),
): Promise<CloudInboundEvent[]> {
  if (!creds) return [];
  const clean = cleanInboundTokens(tokens);
  if (!clean.length) return [];
  const { status, data } = await authJson("/api/inbound/pull", {
    method: "POST",
    body: JSON.stringify({ tokens: clean }),
  }, creds);
  if (status !== 200 || !data.ok) throw new Error(data.error || `入站拉取失败 HTTP ${status}`);
  return Array.isArray(data.items) ? data.items : [];
}

/** 确认已处理的入站事件（传 pull 返回的 kvKey） */
export async function ackCloudInboundEvents(
  kvKeys: string[],
  creds = shareBridgeCreds(),
): Promise<number> {
  if (!creds || !kvKeys.length) return 0;
  const { status, data } = await authJson("/api/inbound/ack", {
    method: "POST",
    body: JSON.stringify({ keys: kvKeys }),
  }, creds);
  if (status !== 200 || !data.ok) throw new Error(data.error || `入站确认失败 HTTP ${status}`);
  return Number(data.acked) || 0;
}

function sameShareHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}

/**
 * 导入输入归一：仅允许本机配置的短链桥 HTTPS → harnessbot://。
 * 任意其它 URL 不拉（防 SSRF）；非 URL 原样返回。
 */
export async function resolveTemplateInput(input: string): Promise<string> {
  const text = input.trim();
  if (!/^https?:\/\//i.test(text)) return text;
  let url: URL;
  try { url = new URL(text); } catch { return text; }

  const creds = shareBridgeCreds();
  if (!creds?.base || !sameShareHost(url.href, creds.base)) {
    throw new Error("只支持本机短链桥地址导入；请粘贴 harnessbot:// 链接，或选择 .harnessbot 文件");
  }
  if (!/^\/b\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) {
    throw new Error("短链路径不对：应为 /b/<id>");
  }

  const api = new URL(url.href);
  api.search = "format=json";
  const r = await fetchShareBridge(api.toString());
  if (!r.ok) throw new Error(`短链不存在或已过期（HTTP ${r.status}）`);
  let data: { link?: string };
  try {
    data = JSON.parse(await r.text()) as { link?: string };
  } catch {
    throw new Error("短链内容不是 bot 模板");
  }
  if (!data.link?.startsWith("harnessbot://")) throw new Error("短链内容不是 bot 模板");
  return data.link;
}
