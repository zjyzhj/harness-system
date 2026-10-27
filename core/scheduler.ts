import { randomUUID } from "node:crypto";
import type { ScheduledTask } from "./types";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 定时任务调度器 — 对标 CowAgent agent/tools/scheduler/
 * - cron 5 段表达式：分 时 日 月 周
 * - 后台定时器每 30s 检查到期任务，触发 bot 执行
 * - 任务持久化 tasks.json
 */
export class Scheduler {
  private tasks: ScheduledTask[] = [];
  private file: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  /** 到期触发回调：task → 交给 BotRuntime 执行 */
  onRun: ((task: ScheduledTask) => Promise<void>) | null = null;
  /** G3：一次性闹钟到期回调（notifyPet 时才由上层接宠物推送） */
  onAlarm: ((task: ScheduledTask) => void) | null = null;

  constructor(private home: string) {
    this.file = join(home, "tasks.json");
    this.load();
  }

  private load() {
    if (existsSync(this.file)) {
      try { this.tasks = JSON.parse(readFileSync(this.file, "utf8")); } catch { this.tasks = []; }
    }
  }
  private persist() {
    writeFileSync(this.file, JSON.stringify(this.tasks, null, 2), "utf8");
  }

  list(): ScheduledTask[] {
    return this.tasks;
  }
  listForBot(botId: string): ScheduledTask[] {
    return this.tasks.filter((t) => t.botId === botId);
  }

  create(input: { botId: string; name: string; cron: string; prompt?: string; maxRetries?: number; kind?: "cron" | "once"; alarmAt?: number; notifyPet?: boolean }): ScheduledTask {
    const kind = input.kind ?? "cron";
    if (kind === "cron" && !isValidCron(input.cron)) throw new Error(`cron 表达式无效: ${input.cron}（应为 5 段：分 时 日 月 周）`);
    const t: ScheduledTask = {
      id: randomUUID(),
      botId: input.botId,
      name: input.name,
      cron: input.cron,
      prompt: input.prompt ?? input.name,
      enabled: true,
      maxRetries: input.maxRetries ?? 2,
      nextRunAt: kind === "once" ? (input.alarmAt ?? Date.now() + 60_000) : nextCronTime(input.cron, Date.now()),
      runCount: 0,
      createdAt: Date.now(),
      kind,
      alarmAt: input.alarmAt,
      notifyPet: input.notifyPet,
    };
    this.tasks.push(t);
    this.persist();
    return t;
  }

  update(id: string, patch: Partial<ScheduledTask>): ScheduledTask | null {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return null;
    Object.assign(t, patch);
    if (patch.cron) t.nextRunAt = nextCronTime(t.cron, Date.now());
    this.persist();
    return t;
  }

  delete(id: string) {
    this.tasks = this.tasks.filter((t) => t.id !== id);
    this.persist();
  }

  setEnabled(id: string, enabled: boolean) {
    return this.update(id, { enabled });
  }

  /** 启动后台循环 */
  start(intervalMs = 30_000) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = Date.now()) {
    if (this.running) return;
    this.running = true;
    try {
      const due = this.tasks.filter((t) => t.enabled && t.nextRunAt && t.nextRunAt <= now);
      for (const t of due) {
        if (t.kind === "once") {
          // 一次性闹钟：触发一次即禁用；通知宠物
          this.update(t.id, { lastRunAt: now, runCount: t.runCount + 1, enabled: false, lastResult: "ok", lastRunLog: `⏰ ${new Date(now).toISOString()} 闹钟触发` });
          if (t.notifyPet && this.onAlarm) this.onAlarm(t);
          continue;
        }
        const next = nextCronTime(t.cron, now);
        this.update(t.id, { lastRunAt: now, nextRunAt: next, runCount: t.runCount + 1, lastResult: "running" });
        if (this.onRun) {
          try {
            await this.onRun(t);
            this.update(t.id, { lastResult: "ok", retryCount: 0, lastError: undefined, lastRunLog: `✅ ${new Date(now).toISOString()} 成功` });
          } catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            const retries = (t.retryCount ?? 0) + 1;
            const max = t.maxRetries ?? 2;
            this.update(t.id, {
              lastResult: "error",
              lastError: err,
              retryCount: retries,
              lastRunLog: `❌ ${new Date(now).toISOString()} 失败: ${err.slice(0, 120)}`,
              nextRunAt: retries <= max ? now + [5, 15, 30][Math.min(retries - 1, 2)] * 60_000 : next,
            });
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** 手动触发一次（测试/调试用） */
  async runNow(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t || !this.onRun) return;
    await this.onRun(t);
  }
}

/** 5 段 cron → 下一个触发时间戳（分钟级精度） */
export function nextCronTime(cron: string, from = Date.now()): number {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron 需 5 段: ${cron}`);
  const [min, hour, dom, mon, dow] = parts.map((p) => p === "*" ? null : (p.startsWith("*/") ? parseInt(p.slice(2), 10) : parseInt(p, 10)));
  const d = new Date(from + 60_000); // 从下一分钟开始
  for (let i = 0; i < 60 * 24 * 370; i++) {
    const m = d.getMinutes(), h = d.getHours(), day = d.getDate(), month = d.getMonth() + 1, wd = d.getDay();
    if ((min === null || m === min) && (hour === null || h === hour) && (dom === null || day === dom) && (mon === null || month === mon) && (dow === null || wd === dow)) {
      return d.getTime();
    }
    d.setMinutes(d.getMinutes() + 1);
  }
  return from + 3600_000; // 兜底：1 小时后
}

export function isValidCron(cron: string): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((p) => p === "*" || /^(\d{1,2}|\*\/\d{1,2}|\d{1,2}-\d{1,2}|\d{1,2},\d{1,2})$/.test(p));
}
