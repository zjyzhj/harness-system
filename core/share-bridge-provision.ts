/**
 * 用 Cloudflare API 为本机一键开通 harness-share-bridge（Worker + KV + PUT_KEY）。
 * 不依赖 wrangler CLI，适合 Electron 内调用。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { saveShareBridgeCreds, shareBridgeStatus, type ShareBridgeStatus } from "./share-bridge";

const SCRIPT_NAME = "harness-share-bridge";
const KV_TITLE = "harness-share-bridge";
const CF_API = "https://api.cloudflare.com/client/v4";

export type CloudflareCreds = {
  apiToken: string;
  accountId?: string;
};

export type ProvisionStep = { step: string; ok: boolean; detail?: string };

export type ProvisionResult = {
  ok: boolean;
  base?: string;
  putKeyHint?: string;
  accountId?: string;
  subdomain?: string;
  status?: ShareBridgeStatus;
  steps: ProvisionStep[];
  error?: string;
  /** 权限类失败时给 UI 的提示 */
  hint?: string;
};

function cloudflareEnvPath(home = join(homedir(), ".config/harness-bot")): string {
  return join(home, "cloudflare.env");
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

export function cloudflareCredsStatus(home = join(homedir(), ".config/harness-bot")): {
  hasToken: boolean;
  tokenHint: string;
  accountId: string;
  path: string;
} {
  const path = cloudflareEnvPath(home);
  const env = loadEnvFile(path);
  const token = process.env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_API_TOKEN || "";
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID || "";
  return {
    hasToken: !!token,
    tokenHint: token ? `${token.slice(0, 4)}…${token.slice(-4)}` : "",
    accountId,
    path,
  };
}

/** 保存 CF API Token（0600）；空 token 表示保留原值 */
export function saveCloudflareCreds(
  input: { apiToken?: string; accountId?: string },
  home = join(homedir(), ".config/harness-bot"),
): ReturnType<typeof cloudflareCredsStatus> {
  const path = cloudflareEnvPath(home);
  const prev = loadEnvFile(path);
  const apiToken = (input.apiToken != null && String(input.apiToken).trim())
    ? String(input.apiToken).trim()
    : (prev.CLOUDFLARE_API_TOKEN || "");
  if (!apiToken) throw new Error("请粘贴 Cloudflare API Token");
  const accountId = input.accountId != null
    ? String(input.accountId).trim()
    : (prev.CLOUDFLARE_ACCOUNT_ID || "");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    path,
    `CLOUDFLARE_API_TOKEN=${apiToken}\nCLOUDFLARE_ACCOUNT_ID=${accountId}\n`,
    { mode: 0o600 },
  );
  return cloudflareCredsStatus(home);
}

export function clearCloudflareCreds(home = join(homedir(), ".config/harness-bot")): ReturnType<typeof cloudflareCredsStatus> {
  const path = cloudflareEnvPath(home);
  if (existsSync(path)) writeFileSync(path, "", { mode: 0o600 });
  return cloudflareCredsStatus(home);
}

function resolveCreds(input?: CloudflareCreds, home = join(homedir(), ".config/harness-bot")): { apiToken: string; accountId: string } {
  const saved = loadEnvFile(cloudflareEnvPath(home));
  const apiToken = (input?.apiToken || process.env.CLOUDFLARE_API_TOKEN || saved.CLOUDFLARE_API_TOKEN || "").trim();
  const accountId = (input?.accountId || process.env.CLOUDFLARE_ACCOUNT_ID || saved.CLOUDFLARE_ACCOUNT_ID || "").trim();
  if (!apiToken) throw new Error("请先填写 Cloudflare API Token");
  return { apiToken, accountId };
}

type CfResult<T> = { success: boolean; result?: T; errors?: { code?: number; message?: string }[] };

async function cf<T>(
  apiToken: string,
  method: string,
  path: string,
  body?: BodyInit | null,
  headers?: Record<string, string>,
): Promise<{ status: number; json: CfResult<T>; raw: string }> {
  const r = await fetch(`${CF_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ?? undefined,
  });
  const raw = await r.text();
  let json: CfResult<T> = { success: false };
  try { json = JSON.parse(raw) as CfResult<T>; } catch { /* ignore */ }
  return { status: r.status, json, raw };
}

function cfErrorMessage(status: number, json: CfResult<unknown>, raw: string): string {
  const msg = json.errors?.map((e) => e.message).filter(Boolean).join("; ")
    || (raw.length < 200 ? raw : `HTTP ${status}`);
  return msg || `HTTP ${status}`;
}

function permissionHint(status: number, msg: string): string | undefined {
  const m = `${status} ${msg}`.toLowerCase();
  if (status === 401 || status === 403 || /authenticat|authoriz|permission|forbidden|not allowed/.test(m)) {
    return "当前 Token 权限不足。请到 Cloudflare → API Tokens 创建令牌，勾选：Account · Workers Scripts（Edit）、Account · Workers KV Storage（Edit）、Account · Account Settings（Read）。注意：R2 / S3 专用令牌不能用来开通短链桥。";
  }
  return undefined;
}

/**
 * 校验 Token。用户级 Token 走 /user/tokens/verify；
 * 账户级 Token（R2 控制台等下发的 cfat_）常对 user 校验 401，需改走 /accounts/:id/tokens/verify 或列账户探测。
 */
async function verifyToken(apiToken: string, preferredAccountId?: string): Promise<void> {
  const user = await cf<{ status?: string }>(apiToken, "GET", "/user/tokens/verify");
  if (user.json.success) return;

  if (preferredAccountId) {
    const acct = await cf<{ status?: string }>(
      apiToken, "GET", `/accounts/${preferredAccountId}/tokens/verify`,
    );
    if (acct.json.success) return;
  }

  // 能列账户即说明 Token 可用（账户级令牌常见路径）
  const list = await cf<{ id: string }[]>(apiToken, "GET", "/accounts?per_page=1");
  if (list.json.success && list.json.result?.length) return;

  const err = cfErrorMessage(user.status, user.json, user.raw);
  throw Object.assign(new Error(err), { hint: permissionHint(user.status, err) });
}

async function pickAccountId(apiToken: string, preferred?: string): Promise<string> {
  if (preferred) return preferred;
  const { status, json, raw } = await cf<{ id: string; name: string }[]>(apiToken, "GET", "/accounts?per_page=50");
  if (!json.success || !json.result?.length) {
    const err = cfErrorMessage(status, json, raw) || "无法列出账户，请手动填写 Account ID";
    throw Object.assign(new Error(err), { hint: permissionHint(status, err) });
  }
  return json.result[0]!.id;
}

/** workers.dev 账号子域：小写字母、数字、连字符，1–63 位，不能以连字符开头或结尾。空串表示不指定。 */
export function normalizeWorkersSubdomain(raw: unknown): string {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s)) {
    throw new Error("子域只能用小写字母、数字和连字符，不能以连字符开头或结尾，最长 63 位");
  }
  return s;
}

async function readWorkersSubdomain(apiToken: string, accountId: string): Promise<string> {
  const { json } = await cf<{ subdomain: string }>(
    apiToken, "GET", `/accounts/${accountId}/workers/subdomain`,
  );
  return json.success && json.result?.subdomain ? json.result.subdomain : "";
}

async function putWorkersSubdomain(apiToken: string, accountId: string, subdomain: string): Promise<string> {
  const put = await cf<{ subdomain: string }>(
    apiToken, "PUT", `/accounts/${accountId}/workers/subdomain`,
    JSON.stringify({ subdomain }),
  );
  if (put.json.success) return put.json.result?.subdomain || subdomain;
  const err = cfErrorMessage(put.status, put.json, put.raw) || "无法设置 workers.dev 子域";
  throw Object.assign(new Error(err), { hint: permissionHint(put.status, err) });
}

async function workersSubdomain(apiToken: string, accountId: string, requested?: string): Promise<string> {
  const want = normalizeWorkersSubdomain(requested);
  const current = await readWorkersSubdomain(apiToken, accountId);
  if (want) {
    if (want === current) return current;
    return putWorkersSubdomain(apiToken, accountId, want);
  }
  if (current) return current;
  const created = await putWorkersSubdomain(
    apiToken,
    accountId,
    `harness${randomBytes(3).toString("hex")}`,
  );
  if (created) return created;
  throw new Error("无法获取 workers.dev 子域");
}

async function ensureKvNamespace(apiToken: string, accountId: string): Promise<string> {
  const list = await cf<{ id: string; title: string }[]>(
    apiToken, "GET", `/accounts/${accountId}/storage/kv/namespaces?per_page=100`,
  );
  if (!list.json.success) {
    const err = cfErrorMessage(list.status, list.json, list.raw);
    throw Object.assign(new Error(err), { hint: permissionHint(list.status, err) });
  }
  const hit = list.json.result?.find((n) => n.title === KV_TITLE);
  if (hit?.id) return hit.id;
  const created = await cf<{ id: string }>(
    apiToken, "POST", `/accounts/${accountId}/storage/kv/namespaces`,
    JSON.stringify({ title: KV_TITLE }),
  );
  if (!created.json.success || !created.json.result?.id) {
    const err = cfErrorMessage(created.status, created.json, created.raw);
    throw Object.assign(new Error(err), { hint: permissionHint(created.status, err) });
  }
  return created.json.result.id;
}

function readWorkerSource(appRoot: string): string {
  const candidates = [
    join(appRoot, "cloud", "share-bridge", "worker.js"),
    join(appRoot, "..", "cloud", "share-bridge", "worker.js"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  throw new Error(`找不到 Worker 脚本（cloud/share-bridge/worker.js），appRoot=${appRoot}`);
}

async function uploadWorker(
  apiToken: string,
  accountId: string,
  script: string,
  kvId: string,
): Promise<void> {
  const metadata = {
    main_module: "worker.js",
    compatibility_date: "2026-10-01",
    bindings: [
      { type: "kv_namespace", name: "SHARE", namespace_id: kvId },
    ],
  };
  const form = new FormData();
  form.append(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" }),
    "metadata.json",
  );
  form.append(
    "worker.js",
    new Blob([script], { type: "application/javascript+module" }),
    "worker.js",
  );
  const { status, json, raw } = await cf<unknown>(
    apiToken,
    "PUT",
    `/accounts/${accountId}/workers/scripts/${SCRIPT_NAME}`,
    form,
  );
  if (!json.success) {
    const err = cfErrorMessage(status, json, raw);
    throw Object.assign(new Error(err), { hint: permissionHint(status, err) });
  }
}

async function putWorkerSecret(apiToken: string, accountId: string, name: string, text: string): Promise<void> {
  const { status, json, raw } = await cf<unknown>(
    apiToken,
    "PUT",
    `/accounts/${accountId}/workers/scripts/${SCRIPT_NAME}/secrets`,
    JSON.stringify({ name, text, type: "secret_text" }),
  );
  if (!json.success) {
    const err = cfErrorMessage(status, json, raw);
    throw Object.assign(new Error(err), { hint: permissionHint(status, err) });
  }
}

async function enableWorkersDev(apiToken: string, accountId: string): Promise<void> {
  const { status, json, raw } = await cf<unknown>(
    apiToken,
    "POST",
    `/accounts/${accountId}/workers/scripts/${SCRIPT_NAME}/subdomain`,
    JSON.stringify({ enabled: true }),
  );
  // 已启用时部分账户返回成功；失败不致命（仍可用 URL）
  if (!json.success && status >= 400 && status !== 409) {
    const err = cfErrorMessage(status, json, raw);
    // 仅记录，不抛：有的账号默认已开
    if (!/already|enabled/i.test(err)) {
      throw Object.assign(new Error(err), { hint: permissionHint(status, err) });
    }
  }
}

function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 6) return "••••";
  return `${key.slice(0, 2)}…${key.slice(-2)}`;
}

/**
 * 一键开通：校验 Token → 账户/子域 → KV → 上传 Worker → PUT_KEY secret → 写本机 env → 探测 health
 */
export async function provisionShareBridge(opts: {
  appRoot: string;
  apiToken?: string;
  accountId?: string;
  /** workers.dev 账号子域。空则沿用账号已有子域；账号还没有时自动注册。 */
  subdomain?: string;
  /** 是否沿用本机已有 PUT_KEY；默认沿用或新生成 */
  putKey?: string;
  home?: string;
  ttlDays?: number;
}): Promise<ProvisionResult> {
  const home = opts.home ?? join(homedir(), ".config/harness-bot");
  const steps: ProvisionStep[] = [];
  const push = (step: string, ok: boolean, detail?: string) => {
    steps.push({ step, ok, detail });
  };

  try {
    const { apiToken, accountId: preferred } = resolveCreds(
      { apiToken: opts.apiToken, accountId: opts.accountId },
      home,
    );

    await verifyToken(apiToken, preferred || undefined);
    push("校验 API Token", true);

    const accountId = await pickAccountId(apiToken, preferred || undefined);
    push("选择账户", true, accountId);
    // 记住 accountId
    saveCloudflareCreds({ apiToken, accountId }, home);

    const subdomain = await workersSubdomain(apiToken, accountId, opts.subdomain);
    push("workers.dev 子域", true, subdomain);

    const kvId = await ensureKvNamespace(apiToken, accountId);
    push("KV 命名空间", true, kvId);

    const script = readWorkerSource(opts.appRoot);
    await uploadWorker(apiToken, accountId, script, kvId);
    push("部署 Worker 脚本", true, SCRIPT_NAME);

    const prev = loadEnvFile(join(home, "share-bridge.env"));
    const putKey = (opts.putKey || prev.PUT_KEY || "").trim()
      || randomBytes(24).toString("base64url");
    await putWorkerSecret(apiToken, accountId, "PUT_KEY", putKey);
    push("写入 PUT_KEY secret", true, maskKey(putKey));

    try {
      await enableWorkersDev(apiToken, accountId);
      push("启用 workers.dev 路由", true);
    } catch (e) {
      push("启用 workers.dev 路由", false, e instanceof Error ? e.message : String(e));
    }

    const base = `https://${SCRIPT_NAME}.${subdomain}.workers.dev`;
    const status = saveShareBridgeCreds({
      base,
      putKey,
      ttlDays: opts.ttlDays ?? 90,
    }, home);
    push("写入本机配置", true, status.path);

    // health
    try {
      const r = await fetch(`${base}/health`);
      const ok = r.ok;
      push("探测 /health", ok, ok ? `HTTP ${r.status}` : `HTTP ${r.status}`);
      if (!ok) {
        return {
          ok: false,
          base,
          putKeyHint: maskKey(putKey),
          accountId,
          subdomain,
          status,
          steps,
          error: `Worker 已部署但 /health 返回 HTTP ${r.status}，请稍后重试或点「重新开通」`,
        };
      }
    } catch (e) {
      push("探测 /health", false, e instanceof Error ? e.message : String(e));
      return {
        ok: true, // 部署已成功，DNS 可能未就绪
        base,
        putKeyHint: maskKey(putKey),
        accountId,
        subdomain,
        status,
        steps,
        error: undefined,
        hint: "已开通，但立刻探测未通（DNS 可能未生效），等约一分钟后再「检测连通」。",
      };
    }

    return {
      ok: true,
      base,
      putKeyHint: maskKey(putKey),
      accountId,
      subdomain,
      status,
      steps,
    };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    const hint = (e as { hint?: string })?.hint || permissionHint(0, err);
    push("失败", false, err);
    return { ok: false, steps, error: err, hint };
  }
}
