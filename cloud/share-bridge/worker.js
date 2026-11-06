/**
 * Harness bot 模板短链 + 入站 Webhook 云收件：
 * POST   /api/put              Authorization: Bearer $PUT_KEY  { link, name?, role? }
 * GET    /api/list             Authorization: Bearer $PUT_KEY  本钥下短链列表
 * DELETE /api/b/:id            Authorization: Bearer $PUT_KEY  撤销短链
 * POST   /api/inbound/register Authorization: Bearer $PUT_KEY  { tokens: string[] } 登记能力令牌
 * POST   /api/inbound/unregister Authorization: Bearer $PUT_KEY { tokens: string[] }
 * POST   /w/:token             公网入站（须已登记；可选 X-Harness-Signature）→ 入队，202
 *                              REQUIRE_INBOUND_HMAC=1 时强制签名（HMAC-SHA256(token, rawBody) hex）
 * POST   /api/inbound/pull     Authorization: Bearer $PUT_KEY  { tokens: string[] } 本机拉取（仅本钥名下）
 * POST   /api/inbound/ack      Authorization: Bearer $PUT_KEY  { keys: string[] }
 * GET    /b/:id                预览页
 * GET    /b/:id?open=1         唤起 harnessbot://
 * GET    /b/:id?format=json
 */
const MAX_LINK = 900_000;
const DEFAULT_TTL_DAYS = 90;
const LIST_LIMIT = 100;
const INBOUND_TTL_SEC = 7 * 86400; // 未拉取的入站事件最多留 7 天
const INBOUND_REG_TTL_SEC = 365 * 86400;
const INBOUND_PULL_LIMIT = 40;
const INBOUND_QUEUE_MAX = 40; // 单令牌未 ack 上限
const INBOUND_BODY_MAX = 64_000;
const W_PER_MIN = 30;
const W_URGENT_PER_MIN = 5;

function clampTtlDays(raw, fallback = DEFAULT_TTL_DAYS) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(365, Math.floor(n)));
}

function ttlSeconds(days) {
  return clampTtlDays(days) * 86400;
}
/** PUT 限流：每分钟 / 每天（按 PUT_KEY 指纹，防钥泄露刷爆 KV） */
const PUT_PER_MIN = 20;
const PUT_PER_DAY = 200;

async function rateOk(env, bucket, limit, windowSec) {
  const slot = Math.floor(Date.now() / 1000 / windowSec);
  const key = `rl:${bucket}:${slot}`;
  const n = Number((await env.SHARE.get(key)) || "0");
  if (n >= limit) return false;
  await env.SHARE.put(key, String(n + 1), { expirationTtl: windowSec * 2 });
  return true;
}

function keyFingerprint(putKey) {
  // 不落完整密钥；短指纹够做限流分桶
  let h = 0;
  for (let i = 0; i < putKey.length; i++) h = ((h << 5) - h + putKey.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Harness-Priority, X-Priority, X-Harness-Signature",
  };
}

function safeStrEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let v = 0;
  for (let i = 0; i < x.length; i++) v |= x[i] ^ y[i];
  return v === 0;
}

function parsePriority(req, body) {
  const h = req.headers.get("x-harness-priority") || req.headers.get("x-priority") || "";
  if (/urgent|high|紧急/i.test(h)) return "urgent";
  if (body && typeof body === "object") {
    if (body.urgent === true || body.urgent === "true" || body.urgent === 1) return "urgent";
    const p = String(body.priority ?? body.level ?? body.urgency ?? "").toLowerCase();
    if (p === "urgent" || p === "high" || p === "紧急" || p === "p0" || p === "p1") return "urgent";
  }
  return "normal";
}

function hexOf(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeHexEqual(a, b) {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

/** 可选 HMAC：与本机网关一致；带了头就必须对。REQUIRE_INBOUND_HMAC=1 时强制要求签名 */
async function inboundSignatureOk(token, rawBody, header, requireSig) {
  const raw = typeof header === "string" ? header.trim() : "";
  if (!raw) return !requireSig;
  const want = raw.replace(/^sha256=/i, "").toLowerCase();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  return safeHexEqual(want, hexOf(sig));
}

function cleanToken(raw) {
  const t = String(raw || "").replace(/[^A-Za-z0-9_-]/g, "");
  return t.length >= 8 && t.length <= 128 ? t : "";
}

async function tokenOwnerFp(env, token) {
  const raw = await env.SHARE.get(`wi:reg:${token}`);
  if (!raw) return null;
  try {
    const meta = JSON.parse(raw);
    return typeof meta?.ownerFp === "string" ? meta.ownerFp : null;
  } catch {
    return null;
  }
}

async function registerTokens(env, fp, tokens) {
  let n = 0;
  for (const raw of tokens) {
    const token = cleanToken(raw);
    if (!token) continue;
    const prev = await tokenOwnerFp(env, token);
    if (prev && prev !== fp) continue; // 不抢别人的令牌
    await env.SHARE.put(
      `wi:reg:${token}`,
      JSON.stringify({ ownerFp: fp, createdAt: Date.now() }),
      { expirationTtl: INBOUND_REG_TTL_SEC },
    );
    await env.SHARE.put(`o:${fp}:w:${token}`, "1", { expirationTtl: INBOUND_REG_TTL_SEC });
    n++;
  }
  return n;
}

async function unregisterTokens(env, fp, tokens) {
  let n = 0;
  for (const raw of tokens) {
    const token = cleanToken(raw);
    if (!token) continue;
    const owner = await tokenOwnerFp(env, token);
    if (owner && owner !== fp) continue;
    await env.SHARE.delete(`wi:reg:${token}`);
    await env.SHARE.delete(`o:${fp}:w:${token}`);
    n++;
  }
  return n;
}

/** 入站队列：单 key 索引，避免 KV.list（免费账户 list 日配额极易打满 → 1101） */
async function readInboundIndex(env, token) {
  const idxKey = `wi:idx:${token}`;
  let items = [];
  try {
    const raw = await env.SHARE.get(idxKey);
    if (raw) items = JSON.parse(raw);
  } catch { /* ignore */ }
  if (!Array.isArray(items)) items = [];
  const now = Date.now();
  const ttlMs = INBOUND_TTL_SEC * 1000;
  items = items.filter((ev) => now - (ev?.createdAt || 0) < ttlMs);
  return { idxKey, items };
}

async function enqueueInbound(env, token, body, priority) {
  const { idxKey, items } = await readInboundIndex(env, token);
  if (items.length >= INBOUND_QUEUE_MAX) {
    return { overflow: true };
  }
  const id = newId();
  const ev = {
    id,
    token,
    body: body ?? {},
    priority,
    createdAt: Date.now(),
    kvKey: `${idxKey}#${id}`,
  };
  items.push(ev);
  await env.SHARE.put(idxKey, JSON.stringify(items), { expirationTtl: INBOUND_TTL_SEC });
  return { ...ev, overflow: false };
}

async function pullInbound(env, fp, tokens) {
  const out = [];
  const uniq = [...new Set(tokens.map((t) => cleanToken(t)).filter(Boolean))];
  for (const token of uniq) {
    if (out.length >= INBOUND_PULL_LIMIT) break;
    const owner = await tokenOwnerFp(env, token);
    if (owner !== fp) continue;
    const { items } = await readInboundIndex(env, token);
    for (const ev of items) {
      if (out.length >= INBOUND_PULL_LIMIT) break;
      out.push({
        id: ev.id,
        token: ev.token || token,
        body: ev.body ?? {},
        priority: ev.priority || "normal",
        createdAt: ev.createdAt || 0,
        kvKey: ev.kvKey || `wi:idx:${token}#${ev.id}`,
      });
    }
  }
  out.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return out;
}

async function ackInbound(env, fp, keys) {
  let n = 0;
  const byTok = new Map();
  for (const raw of keys) {
    const k = String(raw || "");
    // 新格式 wi:idx:TOKEN#ID ；兼容旧 wi:t:TOKEN:ID
    let m = k.match(/^wi:idx:([A-Za-z0-9_-]+)#([A-Za-z0-9_-]+)$/);
    if (!m) m = k.match(/^wi:t:([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/);
    if (!m) continue;
    const token = m[1];
    const id = m[2];
    const owner = await tokenOwnerFp(env, token);
    if (owner !== fp) continue;
    if (!byTok.has(token)) byTok.set(token, new Set());
    byTok.get(token).add(id);
  }
  for (const [token, ids] of byTok) {
    const { idxKey, items } = await readInboundIndex(env, token);
    const next = items.filter((ev) => !ids.has(ev.id));
    n += items.length - next.length;
    if (next.length) {
      await env.SHARE.put(idxKey, JSON.stringify(next), { expirationTtl: INBOUND_TTL_SEC });
    } else {
      await env.SHARE.delete(idxKey);
    }
  }
  return n;
}

function requirePutKey(req, env) {
  const auth = req.headers.get("authorization") || "";
  if (!env.PUT_KEY || !safeStrEqual(auth, `Bearer ${env.PUT_KEY}`)) return null;
  return keyFingerprint(env.PUT_KEY);
}

async function readOwnedIndex(env, fp) {
  const idxKey = `oidx:${fp}`;
  let ids = [];
  try {
    const raw = await env.SHARE.get(idxKey);
    if (raw) ids = JSON.parse(raw);
  } catch { /* ignore */ }
  if (!Array.isArray(ids)) ids = [];
  return { idxKey, ids: ids.map(String).filter(Boolean) };
}

async function writeOwnedIndex(env, fp, ids, ttlSec) {
  const idxKey = `oidx:${fp}`;
  const next = [...new Set(ids.map(String).filter(Boolean))].slice(0, LIST_LIMIT);
  if (!next.length) {
    await env.SHARE.delete(idxKey);
    return;
  }
  await env.SHARE.put(idxKey, JSON.stringify(next), {
    expirationTtl: Math.max(ttlSec || DEFAULT_TTL_DAYS * 86400, 86400),
  });
}

async function putOwned(env, fp, id, meta, ttlSec) {
  await env.SHARE.put(`b:${id}`, JSON.stringify(meta), { expirationTtl: ttlSec });
  // 兼容旧 o: 标记；列表改走 oidx，不再调用 KV.list
  await env.SHARE.put(`o:${fp}:${id}`, "1", { expirationTtl: ttlSec });
  const { ids } = await readOwnedIndex(env, fp);
  const next = [id, ...ids.filter((x) => x !== id)];
  await writeOwnedIndex(env, fp, next, ttlSec);
}

async function deleteOwned(env, fp, id) {
  const raw = await env.SHARE.get(`b:${id}`);
  if (!raw) {
    await env.SHARE.delete(`o:${fp}:${id}`);
    const { ids } = await readOwnedIndex(env, fp);
    await writeOwnedIndex(env, fp, ids.filter((x) => x !== id), DEFAULT_TTL_DAYS * 86400);
    return { ok: false, missing: true };
  }
  let meta;
  try { meta = JSON.parse(raw); } catch { meta = null; }
  if (meta?.ownerFp && meta.ownerFp !== fp) {
    return { ok: false, forbidden: true };
  }
  // 旧数据无 ownerFp：持有 PUT_KEY 仍可删（单租户桥）
  await env.SHARE.delete(`b:${id}`);
  await env.SHARE.delete(`o:${fp}:${id}`);
  const { ids } = await readOwnedIndex(env, fp);
  await writeOwnedIndex(env, fp, ids.filter((x) => x !== id), (meta?.ttlDays || DEFAULT_TTL_DAYS) * 86400);
  return { ok: true, meta };
}

async function listOwned(env, fp, origin) {
  const { ids } = await readOwnedIndex(env, fp);
  const items = [];
  const alive = [];
  for (const id of ids) {
    if (id.startsWith("w:")) continue; // 旧 o: 索引里的 webhook 归属，不是短链
    const raw = await env.SHARE.get(`b:${id}`);
    if (!raw) continue;
    let meta;
    try { meta = JSON.parse(raw); } catch { continue; }
    alive.push(id);
    items.push({
      id,
      name: meta.name || "",
      role: meta.role || "",
      createdAt: meta.createdAt || 0,
      expiresInDays: meta.ttlDays || DEFAULT_TTL_DAYS,
      url: `${origin}/b/${id}`,
      open: `${origin}/b/${id}?open=1`,
    });
  }
  // 顺带收敛失效 id（仍只用 get/put）
  if (alive.length !== ids.filter((x) => !String(x).startsWith("w:")).length) {
    await writeOwnedIndex(env, fp, alive, DEFAULT_TTL_DAYS * 86400);
  }
  items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return { items, truncated: ids.length >= LIST_LIMIT };
}

/** 公网 JSON（可带 CORS） */
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors(), ...extra },
  });
}

/** 鉴权 API：不带 CORS，避免浏览器凭 PUT_KEY 跨域拉队列 */
function jsonApi(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra },
  });
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function landingHtml(meta, id, origin) {
  const name = esc(meta.name || "未命名 bot");
  const role = esc(meta.role || "");
  const openUrl = `${origin}/b/${id}?open=1`;
  const jsonUrl = `${origin}/b/${id}?format=json`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>导入 ${name} · Harness</title>
  <style>
    :root { color-scheme: light dark; --bg:#0d0d0d; --card:#161616; --text:#f2f2f2; --dim:#9a9a9a; --acc:#6ee7b7; --line:#2a2a2a; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: radial-gradient(1200px 600px at 20% -10%, #1a2e28, transparent), var(--bg); color: var(--text);
      display: grid; place-items: center; padding: 24px; }
    .card { width: min(440px, 100%); background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 28px 24px; }
    .ico { font-size: 28px; margin-bottom: 8px; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    .role { color: var(--dim); margin: 0 0 20px; }
    .actions { display: flex; flex-direction: column; gap: 10px; }
    a.btn, button.btn { appearance: none; border: 0; border-radius: 10px; padding: 12px 14px; font: inherit; cursor: pointer; text-align: center; text-decoration: none; }
    a.primary, button.primary { background: var(--acc); color: #062016; font-weight: 600; }
    a.ghost, button.ghost { background: transparent; color: var(--text); border: 1px solid var(--line); }
    .hint { margin-top: 16px; color: var(--dim); font-size: 12px; }
    code { font-size: 11px; word-break: break-all; }
  </style>
</head>
<body>
  <main class="card">
    <div class="ico">🤖</div>
    <h1>${name}</h1>
    <p class="role">${role || "别人分享的 Harness bot 模板"}</p>
    <div class="actions">
      <a class="btn primary" href="${esc(meta.link)}">在 Harness 中打开</a>
      <a class="btn ghost" href="${esc(openUrl)}">备用打开（302）</a>
      <button class="btn ghost" id="copy" type="button">复制协议链接</button>
    </div>
    <p class="hint">若没有跳转：先安装 / 打开 Harness，再点上面的按钮。也可在 App 里「导入 bot」粘贴本页地址：<br/><code>${esc(origin)}/b/${esc(id)}</code><br/>API：<code>${esc(jsonUrl)}</code></p>
  </main>
  <script>
    document.getElementById("copy").onclick = async () => {
      try { await navigator.clipboard.writeText(${JSON.stringify(meta.link)}); document.getElementById("copy").textContent = "已复制"; }
      catch { document.getElementById("copy").textContent = "复制失败"; }
    };
  </script>
</body>
</html>`;
}

function newId() {
  // 16 hex ≈ 64 bit，降低公开短链被扫到的概率
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(req, env) {
    try {
      return await handle(req, env);
    } catch (e) {
      const msg = String(e && e.message || e);
      const quota = /free usage limit|10048|list/i.test(msg);
      return new Response(JSON.stringify({
        error: quota ? "kv_quota" : "worker_exception",
        message: quota
          ? "Cloudflare KV 今日 list 配额已用尽；请同步无 list 的脚本，或次日重试 / 升级套餐"
          : msg,
      }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
  },
};

async function handle(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") {
      // 鉴权 API 不开放浏览器跨域；公网 /w /b 才给 CORS
      if (url.pathname.startsWith("/api/")) return new Response(null, { status: 204 });
      return new Response(null, { status: 204, headers: cors() });
    }


    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({ ok: true, service: "harness-share-bridge" });
    }

    if (req.method === "POST" && url.pathname === "/api/put") {
      const fp = requirePutKey(req, env);
      if (!fp) return jsonApi({ error: "unauthorized" }, 401);
      if (!(await rateOk(env, `m:${fp}`, PUT_PER_MIN, 60))) {
        return jsonApi({ error: "rate limited (per minute)" }, 429, { "Retry-After": "60" });
      }
      if (!(await rateOk(env, `d:${fp}`, PUT_PER_DAY, 86400))) {
        return jsonApi({ error: "rate limited (per day)" }, 429, { "Retry-After": "3600" });
      }
      let body;
      try { body = await req.json(); } catch { return jsonApi({ error: "invalid json" }, 400); }
      const link = String(body?.link ?? "").trim();
      if (!link.startsWith("harnessbot://")) return jsonApi({ error: "need harnessbot:// link" }, 400);
      if (link.length > MAX_LINK) return jsonApi({ error: "too large" }, 413);
      const ttlDays = clampTtlDays(body?.ttlDays ?? env.TTL_DAYS ?? DEFAULT_TTL_DAYS);
      const ttlSec = ttlSeconds(ttlDays);
      // 禁止客户端自选 id，避免持有 PUT_KEY 时抢占/覆盖他人短链
      const id = newId();
      const meta = {
        link,
        name: String(body?.name ?? "").slice(0, 80),
        role: String(body?.role ?? "").slice(0, 120),
        createdAt: Date.now(),
        ownerFp: fp,
        ttlDays,
      };
      await putOwned(env, fp, id, meta, ttlSec);
      const base = url.origin;
      return jsonApi({
        ok: true,
        id,
        url: `${base}/b/${id}`,
        open: `${base}/b/${id}?open=1`,
        expiresInDays: ttlDays,
      });
    }

    if (req.method === "GET" && url.pathname === "/api/list") {
      const fp = requirePutKey(req, env);
      if (!fp) return jsonApi({ error: "unauthorized" }, 401);
      const { items, truncated } = await listOwned(env, fp, url.origin);
      return jsonApi({
        ok: true,
        items,
        truncated,
        ttlDays: clampTtlDays(env.TTL_DAYS ?? DEFAULT_TTL_DAYS),
      });
    }

    const del = url.pathname.match(/^\/api\/b\/([A-Za-z0-9_-]+)$/);
    if (req.method === "DELETE" && del) {
      const fp = requirePutKey(req, env);
      if (!fp) return jsonApi({ error: "unauthorized" }, 401);
      const r = await deleteOwned(env, fp, del[1]);
      if (r.forbidden) return jsonApi({ error: "forbidden" }, 403);
      if (r.missing) return jsonApi({ error: "not found" }, 404);
      return jsonApi({ ok: true, id: del[1] });
    }

    if (req.method === "POST" && url.pathname === "/api/inbound/register") {
      const fp = requirePutKey(req, env);
      if (!fp) return jsonApi({ error: "unauthorized" }, 401);
      let body;
      try { body = await req.json(); } catch { return jsonApi({ error: "invalid json" }, 400); }
      const tokens = Array.isArray(body?.tokens) ? body.tokens : (body?.token ? [body.token] : []);
      const n = await registerTokens(env, fp, tokens);
      return jsonApi({ ok: true, registered: n });
    }

    if (req.method === "POST" && url.pathname === "/api/inbound/unregister") {
      const fp = requirePutKey(req, env);
      if (!fp) return jsonApi({ error: "unauthorized" }, 401);
      let body;
      try { body = await req.json(); } catch { return jsonApi({ error: "invalid json" }, 400); }
      const tokens = Array.isArray(body?.tokens) ? body.tokens : (body?.token ? [body.token] : []);
      const n = await unregisterTokens(env, fp, tokens);
      return jsonApi({ ok: true, unregistered: n });
    }

    // —— 公网入站：外部系统 POST，本机用 PUT_KEY 拉取 ——
    const win = url.pathname.match(/^\/w\/([A-Za-z0-9_-]+)$/);
    if (req.method === "POST" && win) {
      const token = win[1];
      if (token.length < 8 || token.length > 128) return json({ error: "invalid token" }, 400);
      // 未登记：404 且不写 KV（防扫令牌灌库）
      if (!(await tokenOwnerFp(env, token))) return json({ error: "not found" }, 404);
      if (!(await rateOk(env, `w:${token.slice(0, 16)}`, W_PER_MIN, 60))) {
        return json({ error: "rate limited" }, 429, { "Retry-After": "60" });
      }
      const text = await req.text();
      if (text.length > INBOUND_BODY_MAX) return json({ error: "too large" }, 413);
      const requireSig = String(env.REQUIRE_INBOUND_HMAC || "") === "1";
      const sig = req.headers.get("x-harness-signature");
      if (!(await inboundSignatureOk(token, text, sig, requireSig))) {
        return json({ error: "invalid signature" }, 401);
      }
      let body = {};
      if (text.trim()) {
        try { body = JSON.parse(text); } catch { return json({ error: "invalid json" }, 400); }
      }
      const priority = parsePriority(req, body);
      if (priority === "urgent") {
        if (!(await rateOk(env, `wu:${token.slice(0, 16)}`, W_URGENT_PER_MIN, 60))) {
          return json({ error: "urgent rate limited" }, 429, { "Retry-After": "60" });
        }
      }
      const ev = await enqueueInbound(env, token, body, priority);
      if (ev.overflow) return json({ error: "queue full" }, 429, { "Retry-After": "30" });
      return json({
        ok: true,
        accepted: true,
        id: ev.id,
        priority,
      }, 202);
    }

    if (req.method === "POST" && url.pathname === "/api/inbound/pull") {
      const fp = requirePutKey(req, env);
      if (!fp) return jsonApi({ error: "unauthorized" }, 401);
      let body;
      try { body = await req.json(); } catch { return jsonApi({ error: "invalid json" }, 400); }
      const tokens = Array.isArray(body?.tokens) ? body.tokens : [];
      if (!tokens.length) return jsonApi({ ok: true, items: [] });
      const items = await pullInbound(env, fp, tokens);
      return jsonApi({ ok: true, items });
    }

    if (req.method === "POST" && url.pathname === "/api/inbound/ack") {
      const fp = requirePutKey(req, env);
      if (!fp) return jsonApi({ error: "unauthorized" }, 401);
      let body;
      try { body = await req.json(); } catch { return jsonApi({ error: "invalid json" }, 400); }
      const keys = Array.isArray(body?.keys) ? body.keys : (Array.isArray(body?.ids) ? body.ids : []);
      const n = await ackInbound(env, fp, keys);
      return jsonApi({ ok: true, acked: n });
    }

    const m = url.pathname.match(/^\/b\/([A-Za-z0-9_-]+)$/);
    if (req.method === "GET" && m) {
      const raw = await env.SHARE.get(`b:${m[1]}`);
      if (!raw) return new Response("Not found", { status: 404, headers: cors() });
      let meta;
      try { meta = JSON.parse(raw); } catch { return json({ error: "corrupt" }, 500); }
      if (url.searchParams.get("format") === "json") return json(meta);
      // workers 的 Response.redirect 不能指向自定义协议，用 HTML 唤起
      if (url.searchParams.get("open") === "1") {
        const href = esc(meta.link);
        return new Response(
          `<!doctype html><meta charset="utf-8"/><meta http-equiv="refresh" content="0;url=${href}"/><p><a href="${href}">正在打开 Harness…</a></p><script>location.href=${JSON.stringify(meta.link)}</script>`,
          { headers: { "Content-Type": "text/html; charset=utf-8", ...cors() } },
        );
      }
      return new Response(landingHtml(meta, m[1], url.origin), {
        headers: { "Content-Type": "text/html; charset=utf-8", ...cors() },
      });
    }

    return new Response("Not found", { status: 404, headers: cors() });
}
