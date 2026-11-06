import { describe, expect, test } from "bun:test";
import { claimInboundEvent, InboundDedupe } from "../core/inbound-webhook";
import { cloudInboundWebhookUrl } from "../core/share-bridge";

describe("云端入站 URL", () => {
  test("拼出 /w/:token", () => {
    const url = cloudInboundWebhookUrl("tok_abcdefghij", {
      base: "https://harness-share-bridge.example.workers.dev",
      putKey: "k",
      ttlDays: 90,
    });
    expect(url).toBe("https://harness-share-bridge.example.workers.dev/w/tok_abcdefghij");
    expect(cloudInboundWebhookUrl("short", { base: "https://x.workers.dev", putKey: "k", ttlDays: 90 })).toBeUndefined();
  });
});

describe("同一条入站不会在回复期间被再次开轮", () => {
  test("第一次 new，随后 queued，记入 done 后不再开", () => {
    const done = new InboundDedupe();
    const queued = new Set<string>();
    const state = { done, queued };
    expect(claimInboundEvent("evt-1", state)).toBe("new");
    expect(claimInboundEvent("evt-1", state)).toBe("queued");
    expect(claimInboundEvent("evt-1", state)).toBe("queued");
    done.add("evt-1");
    expect(claimInboundEvent("evt-1", state)).toBe("done");
    expect(claimInboundEvent(undefined, state)).toBe("anonymous");
    expect(claimInboundEvent("evt-2", state)).toBe("new");
  });
});

describe("云端入站客户端约定", () => {
  test("pull 走 POST body（源码约定）", async () => {
    const src = await Bun.file(new URL("../core/share-bridge.ts", import.meta.url)).text();
    expect(src).toContain('"/api/inbound/pull"');
    expect(src).toContain("registerCloudInboundTokens");
    expect(src).toMatch(/method:\s*"POST"[\s\S]*tokens:\s*clean/);
    expect(src).not.toContain("/api/inbound/pull?tokens=");
  });
});
