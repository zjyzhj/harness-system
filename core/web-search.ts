/**
 * 联网搜索与网页正文提取：不需要 API Key（Bing 网页结果，失败退到 DuckDuckGo HTML 版）。
 */
export interface SearchResult { title: string; url: string; snippet: string }

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const decodeEntities = (s: string) => s
  .replace(/&nbsp;|&ensp;|&emsp;/g, " ")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, "&");
const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

/** Bing 结果链接是 /ck/a 跳转，真实地址 base64 编码在 u=a1… 里 */
function bingTarget(href: string): string {
  const u = decodeEntities(href);
  const m = u.match(/[?&]u=a1([^&]+)/);
  if (!m) return u;
  try {
    return Buffer.from(m[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return u;
  }
}

export function parseBing(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  for (const block of html.split(/<li class="b_algo"/).slice(1)) {
    const a = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/) ?? block.match(/class="b_lineclamp\d*"[^>]*>([\s\S]*?)<\/div>/);
    const url = bingTarget(a[1]);
    if (!/^https?:\/\//.test(url)) continue;
    out.push({ title: stripTags(a[2]), url, snippet: p ? stripTags(p[1]).replace(/^\d{4}年\d{1,2}月\d{1,2}日\s*·\s*/, "") : "" });
  }
  return out;
}

export function parseDuckDuckGo(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  for (const block of html.split(/class="result results_links/).slice(1)) {
    const a = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let url = decodeEntities(a[1]);
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (url.startsWith("//")) url = "https:" + url;
    const s = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    out.push({ title: stripTags(a[2]), url, snippet: s ? stripTags(s[1]) : "" });
  }
  return out;
}

export async function webSearch(query: string, limit = 6): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q) throw new Error("搜索词为空");
  const zh = /[\u4e00-\u9fa5]/.test(q);
  const tries: [string, (h: string) => SearchResult[]][] = [
    [`https://cn.bing.com/search?q=${encodeURIComponent(q)}${zh ? "" : "&ensearch=1"}`, parseBing],
    [`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, parseDuckDuckGo],
  ];
  let lastErr = "";
  for (const [url, parse] of tries) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": zh ? "zh-CN,zh;q=0.9" : "en-US,en;q=0.9" }, signal: AbortSignal.timeout(12_000) });
      if (!res.ok) { lastErr = `HTTP ${res.status}`; continue; }
      const seen = new Set<string>();
      const hits = parse(await res.text()).filter((r) => !seen.has(r.url) && seen.add(r.url));
      if (hits.length) return hits.slice(0, limit);
      lastErr = "没有结果";
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`搜索失败：${lastErr}`);
}

/** 网页 → 标题 + 可读正文（去掉脚本、样式、导航等） */
export function readableText(html: string): { title: string; text: string } {
  const title = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const body = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  const text = decodeEntities(body.replace(/<[^>]+>/g, " "))
    .split("\n").map((l) => l.replace(/[ \t\r\f\v]+/g, " ").trim()).filter(Boolean).join("\n");
  return { title, text };
}

/** 本机 / 局域网 / 链路本地地址（访问它们要用户授权，防止被网页诱导去扫内网） */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.replace(/^\[|\]$/g, "").toLowerCase();
  if (v === "localhost" || v === "::1" || v === "::" || v.startsWith("fe80:") || v.startsWith("fc") || v.startsWith("fd")) return true;
  const m4 = v.replace(/^::ffff:/, "").match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m4) return false;
  const [a, b] = [Number(m4[1]), Number(m4[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export async function isPrivateHost(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isPrivateAddress(host) || /\.(local|localhost|internal|lan|home)$/i.test(host)) return true;
  try {
    const { lookup } = await import("node:dns/promises");
    const addrs = await lookup(host, { all: true });
    return addrs.some((a) => isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

/** 读响应正文，超过 maxBytes 就停（不把超大文件整个读进内存） */
export async function readCapped(res: Response, maxBytes = 2_000_000): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= maxBytes) { await reader.cancel().catch(() => {}); break; }
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

/** 访问网址：每一跳重定向都检查是不是内网地址；allowPrivate 由调用方在用户授权后传入 */
export async function safeFetch(url: string, opts: {
  allowPrivate?: boolean;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  method?: string;
  body?: BodyInit | null;
} = {}): Promise<Response> {
  let current = url;
  const method = (opts.method ?? "GET").toUpperCase();
  for (let hop = 0; hop < 6; hop++) {
    const u = new URL(current);
    if (!/^https?:$/.test(u.protocol)) throw new Error("URL 需以 http(s):// 开头");
    if (!opts.allowPrivate && (await isPrivateHost(u.hostname))) throw new PrivateAddressError(u.host);
    // 仅首跳带 body；重定向按常见客户端行为改 GET 且不重放 body
    const res = await fetch(current, {
      method: hop === 0 ? method : "GET",
      body: hop === 0 ? opts.body ?? undefined : undefined,
      headers: { "User-Agent": UA, ...opts.headers },
      signal: opts.signal ?? AbortSignal.timeout(20_000),
      redirect: "manual",
    });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!loc) return res;
    current = new URL(loc, current).toString();
  }
  throw new Error("重定向次数太多");
}

export class PrivateAddressError extends Error {
  constructor(public host: string) {
    super(`${host} 是本机或局域网地址`);
  }
}

export async function fetchPage(url: string, maxChars = 12_000, opts: { allowPrivate?: boolean } = {}): Promise<{ title: string; text: string; url: string }> {
  if (!/^https?:\/\//.test(url)) throw new Error("URL 需以 http(s):// 开头");
  const res = await safeFetch(url, { allowPrivate: opts.allowPrivate });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  const raw = await readCapped(res);
  if (!/html/i.test(type) && !/^\s*</.test(raw)) return { title: url, text: raw.slice(0, maxChars), url: res.url || url };
  const { title, text } = readableText(raw);
  return { title: title || url, text: text.length > maxChars ? `${text.slice(0, maxChars)}\n…（正文已截断）` : text, url: res.url || url };
}
