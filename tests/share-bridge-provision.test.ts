import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearCloudflareCreds,
  cloudflareCredsStatus,
  normalizeWorkersSubdomain,
  provisionShareBridge,
  saveCloudflareCreds,
} from "../core/share-bridge-provision";
import { shareBridgeCreds, shareBridgeStatus } from "../core/share-bridge";

const CF_ENV = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"] as const;
const SB_ENV = ["SHARE_BRIDGE_BASE", "SHARE_BRIDGE_PUT_KEY", "PUT_KEY", "SHARE_BRIDGE_TTL_DAYS"] as const;
const saved: Record<string, string | undefined> = {};
let originalFetch: typeof globalThis.fetch;

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeAppRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-prov-app-"));
  mkdirSync(join(root, "cloud", "share-bridge"), { recursive: true });
  writeFileSync(join(root, "cloud", "share-bridge", "worker.js"), "export default { fetch(){ return new Response('ok'); } };\n");
  return root;
}

describe("Cloudflare 凭证本机存储", () => {
  beforeEach(() => {
    for (const k of [...CF_ENV, ...SB_ENV]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of [...CF_ENV, ...SB_ENV]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("保存 / 脱敏 / 清除", () => {
    const home = mkdtempSync(join(tmpdir(), "harness-cf-"));
    expect(cloudflareCredsStatus(home).hasToken).toBe(false);

    const st = saveCloudflareCreds({ apiToken: "tok_abcdef123456", accountId: "acc999" }, home);
    expect(st.hasToken).toBe(true);
    expect(st.accountId).toBe("acc999");
    expect(st.tokenHint).toMatch(/…/);
    expect(st.tokenHint).not.toContain("abcdef123456");

    // 空 token 保留原值
    const again = saveCloudflareCreds({ accountId: "acc2" }, home);
    expect(again.hasToken).toBe(true);
    expect(again.accountId).toBe("acc2");

    clearCloudflareCreds(home);
    expect(cloudflareCredsStatus(home).hasToken).toBe(false);
  });

  test("空 token 拒绝", () => {
    const home = mkdtempSync(join(tmpdir(), "harness-cf-empty-"));
    expect(() => saveCloudflareCreds({ apiToken: "  " }, home)).toThrow(/Token/);
  });
});

describe("一键开通 provisionShareBridge", () => {
  beforeEach(() => {
    for (const k of [...CF_ENV, ...SB_ENV]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const k of [...CF_ENV, ...SB_ENV]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("R2-only / 403 给出权限文案（含勿用 R2）", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-prov-r2-"));
    const appRoot = makeAppRoot();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/user/tokens/verify")) {
        return jsonRes(403, {
          success: false,
          errors: [{ code: 10000, message: "Authentication error" }],
        });
      }
      if (url.includes("/accounts?") || url.endsWith("/accounts")) {
        return jsonRes(403, {
          success: false,
          errors: [{ code: 10000, message: "Authentication error" }],
        });
      }
      return jsonRes(500, { success: false, errors: [{ message: "unexpected" }] });
    }) as typeof fetch;

    const r = await provisionShareBridge({
      appRoot,
      home,
      apiToken: "r2-only-looking-token",
    });
    expect(r.ok).toBe(false);
    expect(r.hint || "").toMatch(/R2|S3|Workers Scripts/i);
    expect(r.steps.some((s) => !s.ok)).toBe(true);
    expect(shareBridgeStatus(home).configured).toBe(false);
  });

  test("账户级 Token：user verify 401 但仍可开通", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-prov-acct-tok-"));
    const appRoot = makeAppRoot();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      if (url.includes("/user/tokens/verify")) {
        return jsonRes(401, { success: false, errors: [{ message: "Invalid API Token" }] });
      }
      if (url.includes("/accounts/") && url.includes("/tokens/verify")) {
        return jsonRes(200, { success: true, result: { status: "active" } });
      }
      if (url.match(/\/accounts\?/) || url.endsWith("/accounts")) {
        return jsonRes(200, { success: true, result: [{ id: "acct_1", name: "Demo" }] });
      }
      if (url.includes("/workers/subdomain") && method === "GET") {
        return jsonRes(200, { success: true, result: { subdomain: "demo-sub" } });
      }
      if (url.includes("/storage/kv/namespaces") && method === "GET") {
        return jsonRes(200, { success: true, result: [{ id: "kv1", title: "harness-share-bridge" }] });
      }
      if (url.includes("/workers/scripts/")) return jsonRes(200, { success: true, result: {} });
      if (url.includes("/health")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return jsonRes(404, { success: false, errors: [{ message: url }] });
    }) as typeof fetch;

    const r = await provisionShareBridge({
      appRoot,
      home,
      apiToken: "cfat_account_scoped",
      accountId: "acct_1",
    });
    expect(r.ok).toBe(true);
    expect(r.base).toContain("demo-sub.workers.dev");
  });

  test("完整开通路径：部署 + 写 env + /health", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-prov-ok-"));
    const appRoot = makeAppRoot();
    const calls: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      calls.push(`${method} ${url}`);

      if (url.includes("/user/tokens/verify")) {
        return jsonRes(200, { success: true, result: { status: "active" } });
      }
      if (url.match(/\/accounts\?/) || url.endsWith("/accounts")) {
        return jsonRes(200, { success: true, result: [{ id: "acct_1", name: "Demo" }] });
      }
      if (url.includes("/workers/subdomain") && method === "GET") {
        return jsonRes(200, { success: true, result: { subdomain: "demo-sub" } });
      }
      if (url.includes("/storage/kv/namespaces") && method === "GET") {
        return jsonRes(200, { success: true, result: [] });
      }
      if (url.includes("/storage/kv/namespaces") && method === "POST") {
        return jsonRes(200, { success: true, result: { id: "kv_ns_1" } });
      }
      if (url.includes("/workers/scripts/harness-share-bridge") && method === "PUT" && !url.includes("/secrets")) {
        return jsonRes(200, { success: true, result: {} });
      }
      if (url.includes("/secrets") && method === "PUT") {
        return jsonRes(200, { success: true, result: {} });
      }
      if (url.includes("/subdomain") && method === "POST") {
        return jsonRes(200, { success: true, result: {} });
      }
      if (url.includes("/health")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return jsonRes(404, { success: false, errors: [{ message: `unmocked ${method} ${url}` }] });
    }) as typeof fetch;

    const r = await provisionShareBridge({
      appRoot,
      home,
      apiToken: "cf_test_token_abcdefgh",
      ttlDays: 30,
    });

    expect(r.ok).toBe(true);
    expect(r.base).toBe("https://harness-share-bridge.demo-sub.workers.dev");
    expect(r.steps.find((s) => s.step.includes("/health"))?.ok).toBe(true);
    expect(shareBridgeStatus(home).configured).toBe(true);
    expect(shareBridgeStatus(home).base).toBe(r.base);
    expect(shareBridgeCreds(home)?.putKey).toBeTruthy();
    expect(cloudflareCredsStatus(home).hasToken).toBe(true);
    expect(cloudflareCredsStatus(home).accountId).toBe("acct_1");
    expect(calls.some((c) => c.includes("/health"))).toBe(true);
  });

  test("/health 非 2xx 时标记失败但仍写出本机配置", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-prov-health-"));
    const appRoot = makeAppRoot();

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      if (url.includes("/user/tokens/verify")) return jsonRes(200, { success: true, result: { status: "active" } });
      if (url.includes("/workers/subdomain") && method === "GET") {
        return jsonRes(200, { success: true, result: { subdomain: "x" } });
      }
      if (url.includes("/kv/namespaces") && method === "GET") {
        return jsonRes(200, { success: true, result: [{ id: "kv1", title: "harness-share-bridge" }] });
      }
      if (url.includes("/workers/scripts/")) return jsonRes(200, { success: true, result: {} });
      if (url.includes(".workers.dev") && url.includes("/health")) return new Response("err", { status: 500 });
      return jsonRes(404, { success: false, errors: [{ message: url }] });
    }) as typeof fetch;

    const r = await provisionShareBridge({
      appRoot,
      home,
      apiToken: "tok",
      accountId: "a1",
    });
    expect(r.ok).toBe(false);
    expect(r.error || "").toMatch(/health|HTTP 500/i);
    expect(shareBridgeStatus(home).configured).toBe(true);
  });

  test("指定子域：与现有不同时 PUT，地址用新子域", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-prov-sub-"));
    const appRoot = makeAppRoot();
    let putBody = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      if (url.includes("/user/tokens/verify")) return jsonRes(200, { success: true, result: { status: "active" } });
      if (url.includes("/workers/subdomain") && !url.includes("/scripts/") && method === "GET") {
        return jsonRes(200, { success: true, result: { subdomain: "old-sub" } });
      }
      if (url.includes("/workers/subdomain") && !url.includes("/scripts/") && method === "PUT") {
        putBody = String(init?.body || "");
        return jsonRes(200, { success: true, result: { subdomain: "my-bot" } });
      }
      if (url.includes("/kv/namespaces") && method === "GET") {
        return jsonRes(200, { success: true, result: [{ id: "kv1", title: "harness-share-bridge" }] });
      }
      if (url.includes("/workers/scripts/")) return jsonRes(200, { success: true, result: {} });
      if (url.includes("/health")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return jsonRes(404, { success: false, errors: [{ message: `${method} ${url}` }] });
    }) as typeof fetch;

    const r = await provisionShareBridge({
      appRoot,
      home,
      apiToken: "tok",
      accountId: "a1",
      subdomain: "My-Bot",
    });
    expect(r.ok).toBe(true);
    expect(putBody).toContain("my-bot");
    expect(r.base).toBe("https://harness-share-bridge.my-bot.workers.dev");
    expect(r.subdomain).toBe("my-bot");
  });

  test("子域与现有相同则不 PUT", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-prov-sub-same-"));
    const appRoot = makeAppRoot();
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      calls.push(`${method} ${url}`);
      if (url.includes("/user/tokens/verify")) return jsonRes(200, { success: true, result: { status: "active" } });
      if (url.includes("/workers/subdomain") && !url.includes("/scripts/") && method === "GET") {
        return jsonRes(200, { success: true, result: { subdomain: "demo-sub" } });
      }
      if (url.includes("/workers/subdomain") && !url.includes("/scripts/") && method === "PUT") {
        return jsonRes(500, { success: false, errors: [{ message: "should not put" }] });
      }
      if (url.includes("/kv/namespaces") && method === "GET") {
        return jsonRes(200, { success: true, result: [{ id: "kv1", title: "harness-share-bridge" }] });
      }
      if (url.includes("/workers/scripts/")) return jsonRes(200, { success: true, result: {} });
      if (url.includes("/health")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return jsonRes(404, { success: false, errors: [{ message: url }] });
    }) as typeof fetch;

    const r = await provisionShareBridge({
      appRoot,
      home,
      apiToken: "tok",
      accountId: "a1",
      subdomain: "demo-sub",
    });
    expect(r.ok).toBe(true);
    expect(r.base).toBe("https://harness-share-bridge.demo-sub.workers.dev");
    expect(calls.some((c) => c.startsWith("PUT ") && c.includes("/workers/subdomain") && !c.includes("/scripts/"))).toBe(false);
  });

  test("非法子域直接拒绝", () => {
    expect(() => normalizeWorkersSubdomain("-bad")).toThrow(/子域/);
    expect(() => normalizeWorkersSubdomain("has_underscore")).toThrow(/子域/);
    expect(normalizeWorkersSubdomain("  OK-Name ")).toBe("ok-name");
  });
});
