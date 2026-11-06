import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConsentCenter } from "../core/consent-center";
import {
  buildBotAccessOverview,
  gatewayBindAllowed,
  isLoopbackHost,
} from "../core/bot-access";

describe("gateway bind policy", () => {
  test("回环默认允许", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(gatewayBindAllowed({ host: "127.0.0.1" }).ok).toBe(true);
    expect(gatewayBindAllowed({}).ok).toBe(true);
  });

  test("非回环默认拒绝，allowRemote 才放行", () => {
    const blocked = gatewayBindAllowed({ host: "0.0.0.0" });
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toMatch(/allowRemote/);
    expect(gatewayBindAllowed({ host: "0.0.0.0", allowRemote: true }).ok).toBe(true);
    expect(gatewayBindAllowed({ host: "192.168.1.8", allowRemote: true }).loopback).toBe(false);
  });
});

describe("bot access overview", () => {
  test("汇总模式、能力、命令、目录、例行与警告", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-access-"));
    const consent = new ConsentCenter(dir);
    consent.setPermissionMode("b1", "auto");
    consent.grant("b1", "clipboard");
    consent.grant("b1", "fs", { once: true });
    consent.setCommandRule("b1", "git", "allow");
    consent.setCommandRule("*", "rm", "deny");
    consent.grantCliAgentPath("b1", dir);
    consent.grantTermOpenPath("b1", dir);

    const ov = buildBotAccessOverview({
      botId: "b1",
      consent,
      routines: [
        { id: "t1", name: "晨间提醒", enabled: true, webhookToken: "tok_abc" },
        { id: "t2", name: "无钩子", enabled: true },
      ],
      gateway: {
        enabled: true,
        host: "0.0.0.0",
        port: 8787,
        loopback: false,
        allowRemote: true,
        routinesBase: "http://0.0.0.0:8787/routines",
      },
      audit: [
        { at: 1, botId: "b1", cap: "clipboard", action: "tool", ok: true },
        { at: 2, botId: "other", cap: "fs", action: "tool", ok: false },
      ],
    });

    expect(ov.mode).toBe("auto");
    expect(ov.grants.map((g) => g.cap).sort()).toEqual(["clipboard", "fs"]);
    expect(ov.allowCommands).toContain("git");
    expect(ov.denyCommands).toContain("rm");
    expect(ov.cliPaths.length).toBe(1);
    expect(ov.termPaths.length).toBe(1);
    expect(ov.routines.filter((r) => r.hasWebhook)).toHaveLength(1);
    expect(ov.routines.find((r) => r.id === "t1")?.capabilityUrl).toContain("/routines/tok_abc");
    expect(ov.recentAudit).toHaveLength(1);
    expect(ov.canDo.some((l) => /Auto|自动/.test(l))).toBe(true);
    expect(ov.warnings.some((w) => /非回环|Bearer/.test(w))).toBe(true);
  });

  test("网关被拦时标 remoteBlocked 警告", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-access-"));
    const consent = new ConsentCenter(dir);
    const ov = buildBotAccessOverview({
      botId: "b",
      consent,
      gateway: { enabled: false, remoteBlocked: true, host: "0.0.0.0", port: 9 },
    });
    expect(ov.warnings.some((w) => /allowRemote|未对外/.test(w))).toBe(true);
  });
});
