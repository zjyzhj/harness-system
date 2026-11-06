import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clampShareTtlDays,
  clearShareBridgeCreds,
  probeShareBridge,
  saveShareBridgeCreds,
  shareBridgeCreds,
  shareBridgeStatus,
} from "../core/share-bridge";

const ENV_KEYS = ["SHARE_BRIDGE_BASE", "SHARE_BRIDGE_PUT_KEY", "PUT_KEY", "SHARE_BRIDGE_TTL_DAYS"] as const;
const savedEnv: Record<string, string | undefined> = {};

describe("短链桥设置读写", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  test("保存 / 状态脱敏 / 清除", () => {
    const home = mkdtempSync(join(tmpdir(), "harness-sb-"));
    expect(shareBridgeStatus(home).configured).toBe(false);

    const st = saveShareBridgeCreds({
      base: "https://harness-share-bridge.example.workers.dev/",
      putKey: "super-secret-put-key-xyz",
    }, home);
    expect(st.configured).toBe(true);
    expect(st.base).toBe("https://harness-share-bridge.example.workers.dev");
    expect(st.hasKey).toBe(true);
    expect(st.keyHint).toMatch(/…/);
    expect(st.keyHint).not.toContain("super-secret");

    const creds = shareBridgeCreds(home)!;
    expect(creds.putKey).toBe("super-secret-put-key-xyz");

    // 留空 putKey 保留原值
    const again = saveShareBridgeCreds({ base: "https://other.workers.dev" }, home);
    expect(again.base).toBe("https://other.workers.dev");
    expect(shareBridgeCreds(home)!.putKey).toBe("super-secret-put-key-xyz");

    clearShareBridgeCreds(home);
    expect(shareBridgeStatus(home).configured).toBe(false);
  });

  test("非法地址拒绝", () => {
    const home = mkdtempSync(join(tmpdir(), "harness-sb-"));
    expect(() => saveShareBridgeCreds({ base: "not-a-url", putKey: "x" }, home)).toThrow(/URL/);
    expect(() => saveShareBridgeCreds({ base: "https://ok.example", putKey: "" }, home)).toThrow(/PUT_KEY/);
  });

  test("未配置时 probe 友好失败", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-sb-"));
    const r = await probeShareBridge(shareBridgeCreds(home));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/尚未配置/);
  });

  test("未配置时 list/delete 友好失败", async () => {
    const { listShareBridgeLinks, deleteShareBridgeLink } = await import("../core/share-bridge");
    await expect(listShareBridgeLinks(null)).rejects.toThrow(/尚未配置/);
    await expect(deleteShareBridgeLink("abc", null)).rejects.toThrow(/尚未配置/);
  });

  test("TTL 夹在 1–365，可写入凭证", () => {
    expect(clampShareTtlDays(0)).toBe(1);
    expect(clampShareTtlDays(400)).toBe(365);
    expect(clampShareTtlDays("7")).toBe(7);
    expect(clampShareTtlDays("nope", 90)).toBe(90);
    const home = mkdtempSync(join(tmpdir(), "harness-sb-ttl-"));
    const st = saveShareBridgeCreds({
      base: "https://harness-share-bridge.example.workers.dev",
      putKey: "k",
      ttlDays: 14,
    }, home);
    expect(st.ttlDays).toBe(14);
    expect(shareBridgeCreds(home)!.ttlDays).toBe(14);
  });
});
