import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AWAY_PAUSE_MS, AWAY_PAUSE_NOTE, MAX_ROUTINES_PER_BOT, RATE_LIMIT_ERROR, Scheduler, describeCron, nextCronTime } from "../core/scheduler";
import { GatewayServer } from "../core/gateway-server";
import { MessageBus } from "../core/message-bus";
import { Store } from "../core/store";
import { CONNECT_INSTALL_CARDS } from "../core/connectors";
import { DemoSkillEngine } from "../core/demo-skill";

describe("例行产品化", () => {
  test("describeCron 人话", () => {
    expect(describeCron("0 9 * * *")).toBe("每天 09:00");
    expect(describeCron("0 9 * * 1-5")).toBe("工作日 09:00");
  });

  test("schedule:false 仅 Webhook，tick 不到点跑", async () => {
    const s = new Scheduler(mkdtempSync(join(tmpdir(), "harness-rt-")));
    let ran = 0;
    s.onRun = async () => { ran++; };
    const t = s.create({
      botId: "b", name: "钩", cron: "* * * * *", webhook: true, schedule: false, prompt: "x",
    });
    expect(t.webhookToken).toBeTruthy();
    expect(t.schedule).toBe(false);
    // 伪造已到期
    s.update(t.id, { nextRunAt: Date.now() - 1000 });
    await s.tick(Date.now());
    expect(ran).toBe(0);
    await s.runNow(t.id);
    expect(ran).toBe(1);
  });

  test("webhook 令牌 + runNow 写历史；create 忽略客户端 token", async () => {
    const s = new Scheduler(mkdtempSync(join(tmpdir(), "harness-rt-")));
    const t = s.create({
      botId: "b", name: "早报", cron: "0 9 * * *", prompt: "写早报",
      webhook: true, source: "demo", skillKey: "daily",
      webhookToken: "weak",
    } as any);
    expect(t.webhookToken).toBeTruthy();
    expect(t.webhookToken).not.toBe("weak");
    expect(s.findByWebhookToken(t.webhookToken!)!.id).toBe(t.id);
    let ran = 0;
    s.onRun = async () => { ran++; };
    await s.runNow(t.id);
    const after = s.get(t.id)!;
    expect(ran).toBe(1);
    expect(after.lastResult).toBe("ok");
    expect(after.runCount).toBe(1);
    expect(after.history?.length).toBe(1);
    expect(after.history![0].ok).toBe(true);
  });

  test("runNow 失败记入 history", async () => {
    const s = new Scheduler(mkdtempSync(join(tmpdir(), "harness-rt-")));
    const t = s.create({ botId: "b", name: "x", cron: "0 9 * * *" });
    s.onRun = async () => { throw new Error("boom"); };
    await s.runNow(t.id);
    const after = s.get(t.id)!;
    expect(after.lastResult).toBe("error");
    expect(after.lastError).toContain("boom");
    expect(after.history?.[0].ok).toBe(false);
  });

  test("runNow 消费 once，tick 不会再跑", async () => {
    const s = new Scheduler(mkdtempSync(join(tmpdir(), "harness-rt-")));
    const t = s.create({
      botId: "b", name: "提醒", cron: "* * * * *", kind: "once",
      alarmAt: Date.now() + 60_000, runPrompt: true, deleteAfterRun: true, prompt: "喝水",
    });
    let ran = 0;
    s.onRun = async () => { ran++; };
    await s.runNow(t.id);
    expect(ran).toBe(1);
    expect(s.get(t.id)).toBeUndefined(); // deleteAfterRun
    await s.tick(Date.now() + 120_000);
    expect(ran).toBe(1);
  });

  test("once+runPrompt 只写一条 history", async () => {
    const s = new Scheduler(mkdtempSync(join(tmpdir(), "harness-rt-")));
    const t = s.create({
      botId: "b", name: "once", cron: "* * * * *", kind: "once",
      alarmAt: Date.now() - 1000, runPrompt: true, notifyPet: false, prompt: "跑",
    });
    s.onRun = async () => {};
    await s.tick(Date.now());
    const after = s.get(t.id)!;
    expect(after.enabled).toBe(false);
    expect(after.history?.length).toBe(1);
    expect(after.history![0].ok).toBe(true);
  });

  test("patchPublic 不能改 webhookToken / botId", () => {
    const s = new Scheduler(mkdtempSync(join(tmpdir(), "harness-rt-")));
    const t = s.create({ botId: "b", name: "x", cron: "0 9 * * *", webhook: true });
    const tok = t.webhookToken!;
    s.patchPublic(t.id, { name: "改名", webhookToken: "hack", botId: "evil", history: [] });
    const after = s.get(t.id)!;
    expect(after.name).toBe("改名");
    expect(after.webhookToken).toBe(tok);
    expect(after.botId).toBe("b");
  });

  test("ensureWebhookToken / clear", () => {
    const s = new Scheduler(mkdtempSync(join(tmpdir(), "harness-rt-")));
    const t = s.create({ botId: "b", name: "x", cron: "0 9 * * *" });
    expect(t.webhookToken).toBeUndefined();
    const withTok = s.ensureWebhookToken(t.id)!;
    expect(withTok.webhookToken).toBeTruthy();
    s.clearWebhookToken(t.id);
    expect(s.get(t.id)!.webhookToken).toBeUndefined();
  });

  test("rotateWebhookToken 旧令牌立刻失效", () => {
    const s = new Scheduler(mkdtempSync(join(tmpdir(), "harness-rt-")));
    const t = s.create({ botId: "b", name: "x", cron: "0 9 * * *", webhook: true });
    const old = t.webhookToken!;
    const rotated = s.rotateWebhookToken(t.id)!;
    expect(rotated.webhookToken).toBeTruthy();
    expect(rotated.webhookToken).not.toBe(old);
    expect(s.findByWebhookToken(old)).toBeUndefined();
    expect(s.findByWebhookToken(rotated.webhookToken!)!.id).toBe(t.id);
  });

  test("网关例行限流 + 错误签名 → 429/401", async () => {
    const s = new Scheduler(mkdtempSync(join(tmpdir(), "harness-rt-")));
    const t = s.create({ botId: "b", name: "钩子例行", cron: "0 9 * * *", webhook: true });
    s.onRun = async () => {};
    const home = mkdtempSync(join(tmpdir(), "harness-gw-"));
    const g = new GatewayServer(0, "x".repeat(16), new MessageBus(new Store(home)), {
      routinePerTokenPerMin: 2,
      routinePerIpPerMin: 100,
    });
    g.onRoutine = async (token) => {
      const task = s.findByWebhookToken(token);
      if (!task) return { ok: false, error: "not found" };
      await s.runNow(task.id);
      return { ok: true, taskId: task.id, name: task.name };
    };
    const port = await g.start();
    const url = `http://127.0.0.1:${port}/routines/${t.webhookToken}`;
    // 未设 accepted 时仍 200；限流在受理前
    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(200);
    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(200);
    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(429);
    const badSig = await fetch(url, {
      method: "POST",
      headers: { "X-Harness-Signature": "deadbeef" },
      body: "{}",
    });
    // 已限流优先 429；换新 token 测签名
    await g.stop();

    const t2 = s.create({ botId: "b", name: "签", cron: "0 9 * * *", webhook: true });
    const g2 = new GatewayServer(0, "x".repeat(16), new MessageBus(new Store(home)));
    g2.onRoutine = async () => ({ ok: true, taskId: t2.id, name: t2.name });
    const port2 = await g2.start();
    const bad = await fetch(`http://127.0.0.1:${port2}/routines/${t2.webhookToken}`, {
      method: "POST",
      headers: { "X-Harness-Signature": "00".repeat(32) },
      body: "{}",
    });
    expect(bad.status).toBe(401);
    const { createHmac } = await import("node:crypto");
    const body = '{"ping":1}';
    const sig = createHmac("sha256", t2.webhookToken!).update(body).digest("hex");
    const ok = await fetch(`http://127.0.0.1:${port2}/routines/${t2.webhookToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Harness-Signature": sig },
      body,
    });
    expect(ok.status).toBe(200);
    await g2.stop();
  });

  test("网关 POST /routines/:token；paused → 400", async () => {
    const s = new Scheduler(mkdtempSync(join(tmpdir(), "harness-rt-")));
    const t = s.create({ botId: "b", name: "钩子例行", cron: "0 9 * * *", webhook: true });
    let ran = 0;
    s.onRun = async () => { ran++; };
    const home = mkdtempSync(join(tmpdir(), "harness-gw-"));
    const g = new GatewayServer(0, "x".repeat(16), new MessageBus(new Store(home)));
    g.onRoutine = async (token) => {
      const task = s.findByWebhookToken(token);
      if (!task) return { ok: false, error: "not found" };
      if (!task.enabled) return { ok: false, error: "routine paused" };
      await s.runNow(task.id);
      return { ok: true, taskId: task.id, name: task.name };
    };
    const port = await g.start();
    const res = await fetch(`http://127.0.0.1:${port}/routines/${t.webhookToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(ran).toBe(1);

    s.setEnabled(t.id, false);
    const paused = await fetch(`http://127.0.0.1:${port}/routines/${t.webhookToken}`, { method: "POST", body: "{}" });
    expect(paused.status).toBe(400);
    expect(((await paused.json()) as { error: string }).error).toBe("routine paused");

    const miss = await fetch(`http://127.0.0.1:${port}/routines/nope`, { method: "POST", body: "{}" });
    expect(miss.status).toBe(404);
    await g.stop();
  });

  test("周期至少隔 5 分钟；一次性和仅 Webhook 不受这条限制", () => {
    const s = new Scheduler(mkdtempSync(join(tmpdir(), "harness-rt-")));
    expect(() => s.create({ botId: "b", name: "太密", cron: "*/1 * * * *" })).toThrow(/5 分钟/);
    expect(s.create({ botId: "b", name: "五分钟", cron: "*/5 * * * *" }).id).toBeTruthy();
    expect(s.create({ botId: "b", name: "一次", cron: "* * * * *", kind: "once", alarmAt: Date.now() + 60_000 }).kind).toBe("once");
    expect(s.create({ botId: "b", name: "钩", cron: "* * * * *", webhook: true, schedule: false }).schedule).toBe(false);
  });

  test("一个 bot 最多 50 条例行", () => {
    const s = new Scheduler(mkdtempSync(join(tmpdir(), "harness-rt-")));
    for (let i = 0; i < MAX_ROUTINES_PER_BOT; i++) s.create({ botId: "b", name: `r${i}`, cron: "0 9 * * *" });
    expect(() => s.create({ botId: "b", name: "超出", cron: "0 9 * * *" })).toThrow(/50/);
    expect(s.create({ botId: "other", name: "别人的", cron: "0 9 * * *" }).botId).toBe("other");
  });

  test("每小时超限不跑，过期记录不占名额", async () => {
    const s = new Scheduler(mkdtempSync(join(tmpdir(), "harness-rt-")));
    const t = s.create({ botId: "b", name: "x", cron: "0 9 * * *" });
    const now = Date.now();
    s.update(t.id, { runStamps: Array.from({ length: 200 }, () => now) });
    let ran = 0;
    s.onRun = async () => { ran++; };
    await s.runNow(t.id);
    expect(ran).toBe(0);
    expect(s.get(t.id)!.lastError).toBe(RATE_LIMIT_ERROR);
    expect(s.get(t.id)!.retryCount ?? 0).toBe(0);

    s.update(t.id, { runStamps: Array.from({ length: 200 }, () => now - 2 * 3_600_000), lastError: undefined });
    await s.runNow(t.id);
    expect(ran).toBe(1);
  });

  test("全部例行合计每小时 300 次", async () => {
    const s = new Scheduler(mkdtempSync(join(tmpdir(), "harness-rt-")));
    const a = s.create({ botId: "b", name: "a", cron: "0 9 * * *" });
    const b = s.create({ botId: "b", name: "b", cron: "0 10 * * *" });
    s.update(a.id, { runStamps: Array.from({ length: 300 }, () => Date.now()) });
    let ran = 0;
    s.onRun = async () => { ran++; };
    await s.runNow(b.id);
    expect(ran).toBe(0);
    expect(s.get(b.id)!.lastError).toBe(RATE_LIMIT_ERROR);
  });

  test("超限失败不提前重试，下次仍按原排期", async () => {
    const s = new Scheduler(mkdtempSync(join(tmpdir(), "harness-rt-")));
    const cron = "*/5 * * * *";
    const t = s.create({ botId: "b", name: "x", cron });
    const now = Date.now();
    s.update(t.id, { nextRunAt: now - 1000 });
    s.onRun = async () => { throw new Error(RATE_LIMIT_ERROR); };
    await s.tick(now);
    expect(s.get(t.id)!.retryCount).toBe(0);
    expect(s.get(t.id)!.nextRunAt).toBe(nextCronTime(cron, now));
  });

  test("离开超过 14 天暂停周期例行，打开开关后恢复", async () => {
    const s = new Scheduler(mkdtempSync(join(tmpdir(), "harness-rt-")));
    const cron = s.create({ botId: "b", name: "早报", cron: "0 9 * * *" });
    const once = s.create({ botId: "b", name: "喝水", cron: "* * * * *", kind: "once", alarmAt: Date.now() + 60_000 });
    const paused: string[] = [];
    s.onAwayPause = (tasks) => paused.push(...tasks.map((t) => t.name));
    s.lastUserAt = () => Date.now() - AWAY_PAUSE_MS - 1000;
    await s.tick(Date.now());
    expect(s.get(cron.id)!.enabled).toBe(false);
    expect(s.get(cron.id)!.pausedReason).toBe("away");
    expect(s.get(cron.id)!.lastError).toBe(AWAY_PAUSE_NOTE);
    expect(s.get(once.id)!.enabled).toBe(true);
    expect(paused).toEqual(["早报"]);
    s.setEnabled(cron.id, true);
    expect(s.get(cron.id)!.enabled).toBe(true);
    expect(s.get(cron.id)!.pausedReason).toBeUndefined();
    expect(s.get(cron.id)!.lastError).toBeUndefined();
  });

  test("Connect 安装卡片目录非空", () => {
    expect(CONNECT_INSTALL_CARDS.length).toBeGreaterThanOrEqual(4);
    expect(CONNECT_INSTALL_CARDS.some((c) => c.kind === "mcp")).toBe(true);
    expect(CONNECT_INSTALL_CARDS.some((c) => c.kind === "computer")).toBe(true);
    expect(CONNECT_INSTALL_CARDS.some((c) => c.kind === "share")).toBe(true);
  });

  test("demo reopen 在落盘失败后可恢复", () => {
    const eng = new DemoSkillEngine();
    eng.start("b1", { title: "流程" });
    eng.record("b1", { tool: "fs.read", args: { path: "/tmp/a" }, output: "ok" });
    const finished = eng.finish("b1", { name: "流程" });
    expect(finished.ok).toBe(true);
    if (!finished.ok) return;
    expect(eng.status("b1")).toBeNull();
    eng.reopen("b1", finished.session);
    expect(eng.status("b1")?.steps.length).toBe(1);
  });
});
