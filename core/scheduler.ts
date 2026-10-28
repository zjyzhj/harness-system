import { randomUUID } from "node:crypto";
import type { ScheduledTask } from "./types";
import { readJsonSafe, writeJsonAtomic } from "./atomic-fs";
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
  /** 任务列表有增删改时通知 UI 刷新（如一次性任务执行后自动删除） */
  onChange: (() => void) | null = null;

  constructor(private home: string) {
    this.file = join(home, "tasks.json");
    this.load();
  }

  private load() {
    const tasks = readJsonSafe<ScheduledTask[]>(this.file, []);
    this.tasks = Array.isArray(tasks) ? tasks : [];
  }
  private persist() {
    writeJsonAtomic(this.file, this.tasks);
  }

  list(): ScheduledTask[] {
    return this.tasks;
  }
  listForBot(botId: string): ScheduledTask[] {
    return this.tasks.filter((t) => t.botId === botId);
  }

  create(input: { botId: string; name: string; cron: string; prompt?: string; maxRetries?: number; kind?: "cron" | "once"; alarmAt?: number; notifyPet?: boolean; runPrompt?: boolean; deleteAfterRun?: boolean; sessionId?: string }): ScheduledTask {
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
      runPrompt: input.runPrompt,
      deleteAfterRun: input.deleteAfterRun,
      sessionId: input.sessionId,
    };
    this.tasks.push(t);
    this.persist();
    this.onChange?.();
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
    const n = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== id);
    this.persist();
    if (this.tasks.length !== n) this.onChange?.();
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
          if (t.runPrompt && this.onRun) {
            try { await this.onRun(t); } catch (e) { this.update(t.id, { lastResult: "error", lastError: e instanceof Error ? e.message : String(e) }); }
          }
          if (t.deleteAfterRun) this.delete(t.id);
          else this.onChange?.(); // 一次性已触发（enabled=false），面板同步
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
        this.onChange?.();
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

const CRON_RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

/** 一段 cron → 允许的取值集合；null = 任意（*）。支持 *、n、a-b、a-b/n、* /n、逗号列表；周里 7 也算周日 */
function parseCronField(field: string, [lo, hi]: [number, number]): Set<number> | null {
  if (field === "*") return null;
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const m = part.match(/^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/);
    if (!m) throw new Error(`cron 段无效: ${field}`);
    const step = m[3] ? Number(m[3]) : 1;
    const start = m[1] === "*" ? lo : Number(m[1]);
    const end = m[1] === "*" ? hi : m[2] !== undefined ? Number(m[2]) : m[3] ? hi : start;
    if (step < 1 || start < lo || end > hi || start > end) throw new Error(`cron 段超出范围: ${field}`);
    for (let v = start; v <= end; v += step) out.add(v);
  }
  return out;
}

function parseCron(cron: string) {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron 需 5 段: ${cron}`);
  const [min, hour, dom, mon, dow] = parts.map((p, i) => parseCronField(p, CRON_RANGES[i]));
  if (dow?.has(7)) dow.add(0);
  return { min, hour, dom, mon, dow };
}

/** 5 段 cron → 下一个触发时间戳（分钟级精度）；日和周都限定时按标准 cron 取「任一满足」 */
export function nextCronTime(cron: string, from = Date.now()): number {
  const { min, hour, dom, mon, dow } = parseCron(cron);
  const ok = (s: Set<number> | null, v: number) => !s || s.has(v);
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 60 * 24 * 370; i++) {
    const dayOk = dom && dow ? dom.has(d.getDate()) || dow.has(d.getDay()) : ok(dom, d.getDate()) && ok(dow, d.getDay());
    if (ok(mon, d.getMonth() + 1) && dayOk && ok(hour, d.getHours()) && ok(min, d.getMinutes())) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return from + 3600_000;
}

export function isValidCron(cron: string): boolean {
  try {
    parseCron(cron);
    return true;
  } catch {
    return false;
  }
}
