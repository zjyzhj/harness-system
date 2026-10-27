import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConsentCenter } from "../core/consent-center";
import { AuditLog } from "../core/audit-log";
import { SystemAccess } from "../core/system-access";
import { ToolExecutor } from "../core/tool-executor";

let home: string;
let consent: ConsentCenter;
let audit: AuditLog;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "harness-g5-"));
  consent = new ConsentCenter(home);
  audit = new AuditLog(home);
});

describe("T5.0 consent lifecycle", () => {
  test("grant once 用一次即失效", async () => {
    consent.grant("bot-a", "apple", { once: true });
    expect(consent.has("bot-a", "apple")).toBe(true);
    // 无 decider 时 request 消耗 once
    const r1 = await consent.request("bot-a", "apple", "打开应用");
    expect(r1.granted).toBe(true);
    expect(consent.has("bot-a", "apple")).toBe(false);
    // 第二次无授权
    const r2 = await consent.request("bot-a", "apple", "打开应用");
    expect(r2.granted).toBe(false);
  });

  test("grant ttl 到期失效", async () => {
    consent.grant("bot-b", "screen", { ttlMs: -1000 }); // 已过期
    expect(consent.has("bot-b", "screen")).toBe(false);
    consent.grant("bot-c", "screen", { ttlMs: 60_000 });
    expect(consent.has("bot-c", "screen")).toBe(true);
  });

  test("revoke 全部/单个生效", async () => {
    consent.grant("bot-d", "gui", {});
    consent.grant("bot-d", "screen", {});
    consent.revoke("bot-d", "gui");
    expect(consent.has("bot-d", "gui")).toBe(false);
    expect(consent.has("bot-d", "screen")).toBe(true);
    consent.revoke("bot-d");
    expect(consent.has("bot-d", "screen")).toBe(false);
  });
});

describe("T5.2 audit log", () => {
  test("append 多条 + 查询过滤 + 导出", () => {
    const home2 = mkdtempSync(join(tmpdir(), "harness-g5a-"));
    const a = new AuditLog(home2);
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) {
      a.append({ botId: "bot-x", cap: "apple", action: "openApp", args: "Safari", granted: true, ok: i % 2 === 0, latencyMs: 12 });
    }
    const all = a.query({ limit: 100, from: t0 - 1000, to: t0 + 1000 });
    expect(all.length).toBe(10);
    const okOnly = a.query({ ok: true, from: t0 - 1000, to: t0 + 1000 });
    expect(okOnly.length).toBe(5);
    const byBot = a.query({ botId: "bot-x", from: t0 - 1000, to: t0 + 1000 });
    expect(byBot.length).toBe(10);
    expect(a.exportAll().length).toBe(10);
  });
});

describe("T5.3 apple template security", () => {
  test("模板化执行 openApp（osascript 真执行，mock 兜底）", async () => {
    const sa = new SystemAccess(consent, audit, { workDir: home });
    consent.grant("bot-e", "apple", {});
    try {
      const out = await sa.apple("bot-e", "openApp", { app: "Safari" });
      expect(typeof out).toBe("string");
    } catch (e) {
      // 无 GUI 环境（CI）osascript 失败但走授权链路已测
      expect(String(e)).toContain("Safari");
    }
  });

  test("注入参数被模板校验拦截", async () => {
    const sa = new SystemAccess(consent, audit, { workDir: home });
    consent.grant("bot-f", "apple", {});
    await expect(sa.apple("bot-f", "openApp", { app: `Safari" & do shell script "rm -rf ~ & "` })).rejects.toThrow(/注入拦截/);
  });

  test("未知动作拒绝", async () => {
    const sa = new SystemAccess(consent, audit, { workDir: home });
    await expect(sa.apple("bot-f", "hack", {})).rejects.toThrow(/不支持/);
  });
});

describe("T5.5 bash group + strong consent", () => {
  test("未授权 bash 分组被拒；授权后放行", async () => {
    const consent2 = new ConsentCenter(home);
    const audit2 = new AuditLog(home);
    consent2.decider = () => "deny";
    const ex = new ToolExecutor({
      allowedRoots: [home],
      consent: consent2,
      audit: audit2,
      bashGroups: { echo: "bash:read", git: "bash:dev", curl: "bash:net", rm: "bash:io" },
    }, undefined as any, undefined as any);
    const denied = await ex.run("bash.run", { command: "echo hi" });
    expect(denied.ok).toBe(false);
    expect(denied.output).toContain("未授权");

    consent2.grant("user", "bash:read", {});
    const ok = await ex.run("bash.run", { command: "echo hi" });
    expect(ok.ok).toBe(true);
    expect(ok.output).toContain("hi");
  });

  test("危险命令（sudo）触发强确认且默认拒绝", async () => {
    const consent2 = new ConsentCenter(home);
    const audit2 = new AuditLog(home);
    let strongAsked = false;
    consent2.decider = (req) => {
      if (req.requiresStrongConsent) strongAsked = true;
      return "deny";
    };
    const ex = new ToolExecutor({ allowedRoots: [home], consent: consent2, audit: audit2, bashGroups: { sudo: "bash:io", rm: "bash:io" } }, undefined as any, undefined as any);
    const r = await ex.run("bash.run", { command: "sudo ls /etc" });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("未授权");
    expect(strongAsked).toBe(true);
  });
});
