import { describe, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayServer, routineSignatureOk } from "../core/gateway-server";
import { MessageBus } from "../core/message-bus";
import { Store } from "../core/store";
import { nextCronTime, normalizeTimezone, zonedParts } from "../core/scheduler";
import { SkillRegistry } from "../core/skill-registry";
import { runTaskTool } from "../core/runtime/tool-helpers";
import { Scheduler } from "../core/scheduler";

describe("Grok-gap 抛光", () => {
  test("HMAC：默认可选；require 时无头拒绝", () => {
    const tok = "tok";
    const body = "{}";
    expect(routineSignatureOk(tok, body, undefined)).toBe(true);
    expect(routineSignatureOk(tok, body, undefined, { require: true })).toBe(false);
    const sig = createHmac("sha256", tok).update(body).digest("hex");
    expect(routineSignatureOk(tok, body, sig, { require: true })).toBe(true);
    expect(routineSignatureOk(tok, body, "deadbeef", { require: true })).toBe(false);
  });

  test("网关 requireHmac 无签名 → 401", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-hmac-"));
    const token = randomBytes(12).toString("hex");
    const server = new GatewayServer(0, "gate", new MessageBus(new Store(home)), {
      host: "127.0.0.1",
      requireHmac: true,
    });
    server.onRoutine = async () => ({ ok: true, accepted: true, taskId: "t", name: "n" });
    const port = await server.start();
    const r = await fetch(`http://127.0.0.1:${port}/routines/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"message":"hi"}',
    });
    expect(r.status).toBe(401);
    const j = await r.json() as { error?: string };
    expect(j.error).toMatch(/signature/);
    const body = '{"message":"hi"}';
    const sig = createHmac("sha256", token).update(body).digest("hex");
    // 无对应例行 → 仍会过签名校验后由 onRoutine 返回；这里只验证签名关打开时带头可通过签名关卡
    // 令牌随便：onRoutine 仍会被调用
    let hit = 0;
    server.onRoutine = async () => { hit++; return { ok: true, accepted: true, taskId: "t", name: "n" }; };
    const ok = await fetch(`http://127.0.0.1:${port}/routines/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Harness-Signature": sig },
      body,
    });
    expect(ok.status).toBe(202);
    expect(hit).toBe(1);
    await server.stop();
  });

  test("时区：Asia/Shanghai 墙钟解释 cron", () => {
    expect(normalizeTimezone("Asia/Shanghai")).toBe("Asia/Shanghai");
    expect(normalizeTimezone("Not/AZone")).toBe("");
    // 固定一个 UTC 时刻，用上海时区找「每天 09:00」的下一跳应在上海墙上 9 点
    const from = Date.parse("2026-06-01T01:00:00Z"); // 上海 09:00
    const next = nextCronTime("0 9 * * *", from, "Asia/Shanghai");
    const p = zonedParts(next, "Asia/Shanghai");
    expect(p.h).toBe(9);
    expect(p.mi).toBe(0);
  });

  test("task.create 返回 routine 内联卡", () => {
    const sched = new Scheduler(mkdtempSync(join(tmpdir(), "harness-rtcard-")));
    const r = runTaskTool(sched, { id: "b", name: "助手" } as any, "task.create", {
      name: "早报", prompt: "写早报", cron: "0 9 * * *", timezone: "Asia/Shanghai",
    });
    expect(r.output).toContain("已创建");
    expect(r.blocks?.[0]).toMatchObject({ type: "routine", name: "早报" });
    expect(sched.list()[0].timezone).toBe("Asia/Shanghai");
  });

  test("技能 per-bot disabledSkills", () => {
    const home = mkdtempSync(join(tmpdir(), "harness-sk-"));
    const skills = new SkillRegistry(join(home, "skills"));
    const sk = skills.save({ name: "周报", description: "写周报", body: "总结本周", enabled: true });
    const bot = { id: "b1", disabledSkills: [sk.key] };
    expect(skills.enabledFor(bot, sk)).toBe(false);
    expect(skills.toolDescriptions("b1", bot)).not.toContain(sk.key);
    expect(skills.enabledFor({ id: "b1" }, sk)).toBe(true);
  });
});
