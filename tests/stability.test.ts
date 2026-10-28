import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler, isValidCron, nextCronTime } from "../core/scheduler";
import { abortable, mapPool } from "../core/bot-runtime";

const at = (s: string) => new Date(s).getTime();
const fmt = (t: number) => {
  const d = new Date(t);
  return `${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
};

describe("cron 解析", () => {
  test("*/n 是每隔 n，不是等于 n", () => {
    expect(fmt(nextCronTime("*/15 * * * *", at("2026-10-26T08:01:30")))).toBe("10-26 8:15");
    expect(fmt(nextCronTime("*/15 * * * *", at("2026-10-26T08:15:00")))).toBe("10-26 8:30");
  });

  test("范围、列表、范围带步长", () => {
    expect(fmt(nextCronTime("0 9 * * 1-5", at("2026-10-24T10:00:00")))).toBe("10-26 9:00"); // 周六 → 周一
    expect(fmt(nextCronTime("0 9,18 * * *", at("2026-10-26T10:00:00")))).toBe("10-26 18:00");
    expect(fmt(nextCronTime("0 8-20/4 * * *", at("2026-10-26T13:00:00")))).toBe("10-26 16:00");
    expect(fmt(nextCronTime("30 7 * * 7", at("2026-10-26T10:00:00")))).toBe("11-1 7:30"); // 7 = 周日
  });

  test("非法表达式", () => {
    for (const c of ["0 25 * * *", "61 * * * *", "0 9 * *", "a b c d e", "*/0 * * * *", "5-1 * * * *"]) expect(isValidCron(c)).toBe(false);
    for (const c of ["0 9 * * 1-5", "*/5 * * * *", "0 9,12,18 * * *", "0 0 1 */3 *"]) expect(isValidCron(c)).toBe(true);
  });
});

describe("定时任务失败重试", () => {
  test("onRun 抛错 → 记录错误并安排几分钟后重试", async () => {
    const s = new Scheduler(mkdtempSync(join(tmpdir(), "harness-sched-")));
    const t = s.create({ botId: "b", name: "日报", cron: "0 9 * * *" });
    s.onRun = async () => { throw new Error("API 503"); };
    const now = t.nextRunAt! + 1000;
    await s.tick(now);
    const after = s.list()[0];
    expect(after.lastResult).toBe("error");
    expect(after.lastError).toContain("503");
    expect(after.nextRunAt).toBe(now + 5 * 60_000);
  });
});

describe("并发与停止", () => {
  test("mapPool 同时最多跑 limit 个，结果按原顺序", async () => {
    let live = 0, peak = 0;
    const r = await mapPool([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
      live++; peak = Math.max(peak, live);
      await new Promise((res) => setTimeout(res, 5 + (7 - x)));
      live--;
      return x * 10;
    });
    expect(peak).toBe(3);
    expect(r).toEqual([10, 20, 30, 40, 50, 60, 70]);
  });

  test("abortable：点停止立即结束等待", async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20);
    const t0 = Date.now();
    await expect(abortable(new Promise(() => {}), ctrl.signal)).rejects.toThrow("用户已停止");
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
