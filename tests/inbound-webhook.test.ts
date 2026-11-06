import { describe, expect, test } from "bun:test";
import {
  buildInboundExtraSystem,
  buildInboundUserText,
  extractInboundMessage,
  InboundDedupe,
  parseInboundPriority,
  parseInboundWebhookBody,
  sortInboundEventsByPriority,
} from "../core/inbound-webhook";
import { GatewayServer } from "../core/gateway-server";
import { MessageBus } from "../core/message-bus";
import { Store } from "../core/store";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("入站 Webhook 载荷", () => {
  test("解析 message + 普通/紧急", () => {
    expect(extractInboundMessage({ message: " 跑一下 " })).toBe("跑一下");
    expect(extractInboundMessage({ text: "hi" })).toBe("hi");
    expect(parseInboundPriority({ priority: "urgent" })).toBe("urgent");
    expect(parseInboundPriority({ urgent: true })).toBe("urgent");
    expect(parseInboundPriority({}, { priority: "urgent" })).toBe("urgent");
    expect(parseInboundPriority({ message: "x" })).toBe("normal");

    const p = parseInboundWebhookBody({ message: "审一下", priority: "urgent", ticket: "T-1" });
    expect(p.message).toBe("审一下");
    expect(p.priority).toBe("urgent");
    expect(p.rest).toEqual({ ticket: "T-1" });

    const built = buildInboundUserText(p, "固定指令");
    expect(built.usedMessage).toBe(true);
    expect(built.userText).toBe("审一下");
    const sys = buildInboundExtraSystem(p, "例行说明", true);
    expect(sys).toMatch(/紧急/);
    expect(sys).toContain("T-1");
  });

  test("无 message 回退例行 prompt", () => {
    const p = parseInboundWebhookBody({});
    const built = buildInboundUserText(p, "每日早报");
    expect(built.usedMessage).toBe(false);
    expect(built.userText).toBe("每日早报");
  });

  test("同批紧急优先", () => {
    const sorted = sortInboundEventsByPriority([
      { id: "n1", priority: "normal", createdAt: 1 },
      { id: "u1", priority: "urgent", createdAt: 3 },
      { id: "n2", priority: "normal", createdAt: 2 },
      { id: "u0", priority: "urgent", createdAt: 0 },
    ]);
    expect(sorted.map((x) => x.id)).toEqual(["u0", "u1", "n1", "n2"]);
  });

  test("入站去重窗", () => {
    const d = new InboundDedupe(60_000, 10);
    expect(d.has("a")).toBe(false);
    d.add("a");
    expect(d.has("a")).toBe(true);
  });
});

describe("网关例行 202 受理", () => {
  test("accepted → 202，不阻塞后台", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-inb-"));
    const g = new GatewayServer(0, "x".repeat(16), new MessageBus(new Store(home)));
    let ran = 0;
    g.onRoutine = async () => {
      ran++;
      return { ok: true, accepted: true, taskId: "t1", name: "钩", priority: "urgent" };
    };
    const port = await g.start();
    const res = await fetch(`http://127.0.0.1:${port}/routines/tok_abc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Harness-Priority": "urgent" },
      body: JSON.stringify({ message: "立刻" }),
    });
    expect(res.status).toBe(202);
    const j = await res.json() as { ok: boolean; accepted: boolean; priority?: string };
    expect(j.ok).toBe(true);
    expect(j.accepted).toBe(true);
    expect(j.priority).toBe("urgent");
    expect(ran).toBe(1);
    await g.stop();
  });
});
