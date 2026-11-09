import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { ScheduledTask, TaskRunLog } from "./types";
import { readJsonSafe, writeJsonAtomic } from "./atomic-fs";
import { join } from "node:path";

const HISTORY_CAP = 20;
/** 对齐 Grok：一个 bot 最多 50 条例行 */
export const MAX_ROUTINES_PER_BOT = 50;
/** 周期例行两次触发至少隔 5 分钟 */
export const MIN_CRON_GAP_MS = 5 * 60_000;
/** 单条例行每小时最多开跑次数 */
export const ROUTINE_HOURLY_CAP = 200;
/** 全部例行合计每小时最多开跑次数 */
export const ACCOUNT_HOURLY_CAP = 300;
export const RATE_LIMIT_ERROR = "Automation run rate limit exceeded";
/** 离开超过 14 天，周期例行先暂停 */
export const AWAY_PAUSE_MS = 14 * 24 * 3600_000;
export const AWAY_PAUSE_NOTE = "离开较久，例行已暂停。回来后打开开关即可继续。";

/** IPC / 表单可改字段；不含 webhookToken / history / runCount / botId 等 */
export const TASK_PUBLIC_PATCH_KEYS = [
  "name", "prompt", "cron", "enabled", "alarmAt", "skillKey", "source",
  "maxRetries", "notifyPet", "runPrompt", "deleteAfterRun", "sessionId",
  "timezone", "schedule",
] as const satisfies readonly (keyof ScheduledTask)[];

/**
 * 定时 / 例行调度器 — 对标 CowAgent agent/tools/scheduler/
 * - cron 5 段表达式：分 时 日 月 周
 * - 后台定时器每 30s 检查到期任务，触发 bot 执行
 * - 任务持久化 tasks.json
 * - 支持试跑、运行历史、入站 webhook 令牌
 */
export class Scheduler {
  private tasks: ScheduledTask[] = [];
  private file: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** 正在执行的任务 id（tick 与 runNow / webhook 互斥） */
  private inFlight = new Set<string>();

  /** 到期触发回调：task → 交给 BotRuntime 执行 */
  onRun: ((task: ScheduledTask) => Promise<void>) | null = null;
  /** G3：一次性闹钟到期回调（notifyPet 时才由上层接宠物推送） */
  onAlarm: ((task: ScheduledTask) => void) | null = null;
  /** 任务列表有增删改时通知 UI 刷新（如一次性任务执行后自动删除） */
  onChange: (() => void) | null = null;
  /** 最近一次用户开口的时间；空则不判断「离开太久」 */
  lastUserAt: (() => number) | null = null;
  /** 因离开太久暂停了一批周期例行 */
  onAwayPause: ((tasks: ScheduledTask[]) => void) | null = null;

  constructor(private home: string) {
    this.file = join(home, "tasks.json");
    this.load();
  }

  private load() {
    const tasks = readJsonSafe<ScheduledTask[]>(this.file, []);
    this.tasks = Array.isArray(tasks) ? tasks : [];
    // 进程重启后不可能还在跑；清掉残留的「running」，避免列表一直显示「正在执行」
    let dirty = false;
    for (const t of this.tasks) {
      if (t.lastResult === "running") {
        t.lastResult = "error";
        t.lastError = t.lastError || "上次试跑被中断";
        dirty = true;
      }
    }
    if (dirty) this.persist();
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
  get(id: string): ScheduledTask | undefined {
    return this.tasks.find((t) => t.id === id);
  }
  findByWebhookToken(token: string): ScheduledTask | undefined {
    const t = String(token || "").trim();
    if (!t) return undefined;
    const needle = Buffer.from(t);
    for (const x of this.tasks) {
      if (!x.webhookToken) continue;
      const have = Buffer.from(x.webhookToken);
      if (have.length === needle.length && timingSafeEqual(have, needle)) return x;
    }
    return undefined;
  }

  create(input: {
    botId: string;
    name: string;
    cron: string;
    prompt?: string;
    maxRetries?: number;
    kind?: "cron" | "once";
    alarmAt?: number;
    notifyPet?: boolean;
    runPrompt?: boolean;
    deleteAfterRun?: boolean;
    sessionId?: string;
    skillKey?: string;
    source?: ScheduledTask["source"];
    /** true 时服务端生成令牌；忽略任何客户端传入的 token */
    webhook?: boolean;
    /** false = 仅 Webhook，不参与到点调度（默认 true） */
    schedule?: boolean;
    timezone?: string;
  }): ScheduledTask {
    const kind = input.kind ?? "cron";
    if (kind === "cron" && !isValidCron(input.cron)) throw new Error(`cron 表达式无效: ${input.cron}（应为 5 段：分 时 日 月 周）`);
    const timezone = normalizeTimezone(input.timezone);
    const schedule = input.schedule !== false;
    if (kind === "cron" && schedule) assertSchedulable(input.cron, timezone);
    const owned = this.tasks.filter((x) => x.botId === input.botId).length;
    if (owned >= MAX_ROUTINES_PER_BOT) throw new Error(`这个 bot 最多 ${MAX_ROUTINES_PER_BOT} 条例行`);
    const t: ScheduledTask = {
      id: randomUUID(),
      botId: input.botId,
      name: input.name,
      cron: input.cron,
      prompt: input.prompt ?? input.name,
      enabled: true,
      maxRetries: input.maxRetries ?? 2,
      nextRunAt: kind === "once" ? (input.alarmAt ?? Date.now() + 60_000) : nextCronTime(input.cron, Date.now(), timezone),
      runCount: 0,
      createdAt: Date.now(),
      kind,
      alarmAt: input.alarmAt,
      notifyPet: input.notifyPet,
      runPrompt: input.runPrompt,
      deleteAfterRun: input.deleteAfterRun,
      sessionId: input.sessionId,
      skillKey: input.skillKey,
      source: input.source,
      timezone: timezone || undefined,
      webhookToken: input.webhook ? newWebhookToken() : undefined,
      // 仅在显式关闭调度时落盘，避免旧数据语义噪音
      schedule: schedule ? undefined : false,
      history: [],
    };
    this.tasks.push(t);
    this.persist();
    this.onChange?.();
    return t;
  }

  /** 内部更新（可写运行态字段） */
  update(id: string, patch: Partial<ScheduledTask>): ScheduledTask | null {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return null;
    const { id: _id, createdAt: _c, ...safe } = patch as Partial<ScheduledTask> & { id?: string };
    if (safe.timezone !== undefined) safe.timezone = normalizeTimezone(safe.timezone) || undefined;
    Object.assign(t, safe);
    if ((patch.cron || patch.timezone !== undefined) && t.kind !== "once") {
      t.nextRunAt = nextCronTime(t.cron, Date.now(), t.timezone);
    }
    if (patch.alarmAt && t.kind === "once") t.nextRunAt = patch.alarmAt;
    this.persist();
    this.onChange?.();
    return t;
  }

  /** IPC / UI 白名单更新：禁止改 webhookToken、history、botId、runCount 等 */
  patchPublic(id: string, patch: Record<string, unknown>): ScheduledTask | null {
    const safe: Partial<ScheduledTask> = {};
    for (const key of TASK_PUBLIC_PATCH_KEYS) {
      if (patch[key] !== undefined) (safe as Record<string, unknown>)[key] = patch[key];
    }
    return this.update(id, safe);
  }

  delete(id: string) {
    const n = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== id);
    this.persist();
    if (this.tasks.length !== n) this.onChange?.();
  }

  setEnabled(id: string, enabled: boolean) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return null;
    t.enabled = enabled;
    if (enabled && t.pausedReason === "away") {
      delete t.pausedReason;
      if (t.lastError === AWAY_PAUSE_NOTE) delete t.lastError;
    }
    this.persist();
    this.onChange?.();
    return t;
  }

  /** 为已有例行开通入站 webhook 令牌 */
  ensureWebhookToken(id: string): ScheduledTask | null {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return null;
    if (!t.webhookToken) {
      t.webhookToken = newWebhookToken();
      this.persist();
      this.onChange?.();
    }
    return t;
  }

  /** 轮换令牌：旧 URL 立刻失效 */
  rotateWebhookToken(id: string): ScheduledTask | null {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return null;
    t.webhookToken = newWebhookToken();
    this.persist();
    this.onChange?.();
    return t;
  }

  clearWebhookToken(id: string): ScheduledTask | null {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return null;
    if (t.webhookToken) {
      t.webhookToken = undefined;
      this.persist();
      this.onChange?.();
    }
    return t;
  }

  private pushHistory(t: ScheduledTask, entry: TaskRunLog) {
    const hist = [...(t.history ?? []), entry].slice(-HISTORY_CAP);
    t.history = hist;
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
      this.pauseIfAway(now);
      // schedule===false：仅 Webhook 例行，到点不跑（对齐 Grok：定时与 Webhook 分家）
      const due = this.tasks.filter((t) => t.enabled && t.schedule !== false && t.nextRunAt && t.nextRunAt <= now && !this.inFlight.has(t.id));
      for (const t of due) {
        if (this.rateLimitReason(t, now)) {
          const next = t.kind === "once" ? t.nextRunAt : nextCronTime(t.cron, now, t.timezone);
          this.recordLimited(t, now, next);
          if (t.kind === "once") this.update(t.id, { enabled: false });
          continue;
        }
        this.stampRun(t, now);
        if (t.kind === "once") {
          // 一次性：先禁用，避免与 runNow / 下轮 tick 重入
          this.inFlight.add(t.id);
          this.update(t.id, {
            lastRunAt: now,
            runCount: t.runCount + 1,
            enabled: false,
            lastResult: t.runPrompt ? "running" : "ok",
            lastRunLog: `⏰ ${new Date(now).toISOString()} 闹钟触发`,
          });
          if (t.notifyPet && this.onAlarm) this.onAlarm(t);
          try {
            if (t.runPrompt && this.onRun) {
              try {
                await this.onRun(t);
                this.pushHistory(t, { taskId: t.id, ranAt: now, ok: true, prompt: t.prompt ?? t.name });
                this.update(t.id, { lastResult: "ok", lastError: undefined, lastRunLog: `⏰ ${new Date(now).toISOString()} 成功` });
              } catch (e) {
                const err = e instanceof Error ? e.message : String(e);
                this.pushHistory(t, { taskId: t.id, ranAt: now, ok: false, error: err, prompt: t.prompt ?? t.name });
                this.update(t.id, { lastResult: "error", lastError: err, lastRunLog: `⏰ ${new Date(now).toISOString()} 失败: ${err.slice(0, 120)}` });
              }
            } else {
              this.pushHistory(t, { taskId: t.id, ranAt: now, ok: true, prompt: t.prompt ?? t.name });
            }
            if (t.deleteAfterRun) this.delete(t.id);
            else this.onChange?.();
          } finally {
            this.inFlight.delete(t.id);
          }
          continue;
        }
        this.inFlight.add(t.id);
        const next = nextCronTime(t.cron, now, t.timezone);
        this.update(t.id, { lastRunAt: now, nextRunAt: next, runCount: t.runCount + 1, lastResult: "running" });
        try {
          if (this.onRun) {
            try {
              await this.onRun(t);
              this.pushHistory(t, { taskId: t.id, ranAt: now, ok: true, prompt: t.prompt ?? t.name });
              this.update(t.id, { lastResult: "ok", retryCount: 0, lastError: undefined, lastRunLog: `✅ ${new Date(now).toISOString()} 成功` });
            } catch (e) {
              const err = e instanceof Error ? e.message : String(e);
              const retries = (t.retryCount ?? 0) + 1;
              const max = t.maxRetries ?? 2;
              const noRetry = err.includes(RATE_LIMIT_ERROR);
              this.pushHistory(t, { taskId: t.id, ranAt: now, ok: false, error: err, prompt: t.prompt ?? t.name });
              this.update(t.id, {
                lastResult: "error",
                lastError: err,
                retryCount: noRetry ? 0 : retries,
                lastRunLog: `❌ ${new Date(now).toISOString()} 失败: ${err.slice(0, 120)}`,
                nextRunAt: noRetry || retries > max ? next : now + [5, 15, 30][Math.min(retries - 1, 2)] * 60_000,
              });
            }
          }
          this.onChange?.();
        } finally {
          this.inFlight.delete(t.id);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * 手动 / Webhook 试跑一次。
   * - cron：不改 nextRunAt
   * - once：立即消费（disable；deleteAfterRun 则删除），避免与 tick 双触发
   * - wait:false：立刻返回「执行中」，后台跑完（UI 点闪电图标不卡界面）
   */
  async runNow(id: string, opts?: { wait?: boolean }): Promise<ScheduledTask | null> {
    const wait = opts?.wait !== false;
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return null;
    if (!this.onRun) return t;
    if (this.inFlight.has(t.id)) {
      return this.update(t.id, { lastResult: "running", lastError: "已在执行中" });
    }
    const now = Date.now();
    if (this.rateLimitReason(t, now)) {
      this.recordLimited(t, now);
      return this.get(id);
    }
    this.stampRun(t, now);
    this.inFlight.add(t.id);
    // once 先禁用，杜绝 tick 再入
    if (t.kind === "once") this.update(t.id, { enabled: false, lastRunAt: now, runCount: t.runCount + 1, lastResult: "running" });
    else this.update(t.id, { lastRunAt: now, runCount: t.runCount + 1, lastResult: "running" });

    const finish = async () => {
      try {
        await this.onRun!(t);
        this.pushHistory(t, { taskId: t.id, ranAt: now, ok: true, prompt: t.prompt ?? t.name });
        this.update(t.id, {
          lastResult: "ok",
          lastError: undefined,
          lastRunLog: `⚡ ${new Date(now).toISOString()} 试跑成功`,
          retryCount: 0,
        });
        if (t.kind === "once" && t.deleteAfterRun) this.delete(t.id);
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        this.pushHistory(t, { taskId: t.id, ranAt: now, ok: false, error: err, prompt: t.prompt ?? t.name });
        this.update(t.id, {
          lastResult: "error",
          lastError: err,
          lastRunLog: `⚡ ${new Date(now).toISOString()} 试跑失败: ${err.slice(0, 120)}`,
        });
        if (t.kind === "once" && t.deleteAfterRun) this.delete(t.id);
      } finally {
        this.inFlight.delete(id);
      }
    };

    if (!wait) {
      void finish();
      return this.get(id);
    }
    await finish();
    return this.get(id);
  }

  /** 近一小时已开跑的次数。超限的这次不算开跑，也不自动重试。 */
  private rateLimitReason(t: ScheduledTask, now: number): string | null {
    const hour = now - 3_600_000;
    const count = (stamps?: number[]) => (stamps ?? []).filter((x) => x >= hour).length;
    if (count(t.runStamps) >= ROUTINE_HOURLY_CAP) return RATE_LIMIT_ERROR;
    let account = 0;
    for (const x of this.tasks) account += count(x.runStamps);
    if (account >= ACCOUNT_HOURLY_CAP) return RATE_LIMIT_ERROR;
    return null;
  }

  private stampRun(t: ScheduledTask, now: number) {
    const hour = now - 3_600_000;
    t.runStamps = [...(t.runStamps ?? []).filter((x) => x >= hour), now].slice(-ROUTINE_HOURLY_CAP);
  }

  private recordLimited(t: ScheduledTask, now: number, nextRunAt?: number) {
    this.pushHistory(t, { taskId: t.id, ranAt: now, ok: false, error: RATE_LIMIT_ERROR, prompt: t.prompt ?? t.name });
    this.update(t.id, {
      lastRunAt: now,
      ...(nextRunAt !== undefined ? { nextRunAt } : {}),
      lastResult: "error",
      lastError: RATE_LIMIT_ERROR,
      retryCount: 0,
      lastRunLog: `❌ ${new Date(now).toISOString()} ${RATE_LIMIT_ERROR}`,
    });
  }

  private pauseIfAway(now: number) {
    const seen = this.lastUserAt?.() ?? 0;
    if (!seen || now - seen < AWAY_PAUSE_MS) return;
    const hit = this.tasks.filter((t) => t.enabled && t.kind !== "once");
    if (!hit.length) return;
    for (const t of hit) {
      t.enabled = false;
      t.pausedReason = "away";
      t.lastError = AWAY_PAUSE_NOTE;
    }
    this.persist();
    this.onChange?.();
    this.onAwayPause?.(hit);
  }
}

function newWebhookToken(): string {
  return randomBytes(18).toString("base64url");
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

/** 空 / 非法 → ""（本机墙钟）；合法 IANA 原样返回 */
export function normalizeTimezone(tz?: string | null): string {
  const s = String(tz ?? "").trim();
  if (!s) return "";
  try {
    Intl.DateTimeFormat("en-US", { timeZone: s }).format(new Date());
    return s;
  } catch {
    return "";
  }
}

const WEEKDAY_TO_NUM: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** 某时刻在指定时区（或本机）的日历分量 */
export function zonedParts(ms: number, timeZone?: string): { y: number; mo: number; d: number; h: number; mi: number; dow: number } {
  if (!timeZone) {
    const d = new Date(ms);
    return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), dow: d.getDay() };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  let h = Number(get("hour"));
  if (h === 24) h = 0; // 部分环境午夜标 24
  return {
    y: Number(get("year")),
    mo: Number(get("month")),
    d: Number(get("day")),
    h,
    mi: Number(get("minute")),
    dow: WEEKDAY_TO_NUM[get("weekday")] ?? 0,
  };
}

/** 5 段 cron → 下一个触发时间戳（分钟级精度）；可按 IANA 时区解释墙钟 */
export function nextCronTime(cron: string, from = Date.now(), timeZone?: string): number {
  const { min, hour, dom, mon, dow } = parseCron(cron);
  const ok = (s: Set<number> | null, v: number) => !s || s.has(v);
  const tz = normalizeTimezone(timeZone) || undefined;
  let ms = from - (from % 60_000) + 60_000;
  for (let i = 0; i < 60 * 24 * 370; i++) {
    const p = zonedParts(ms, tz);
    const dayOk = dom && dow ? dom.has(p.d) || dow.has(p.dow) : ok(dom, p.d) && ok(dow, p.dow);
    if (ok(mon, p.mo) && dayOk && ok(hour, p.h) && ok(min, p.mi)) return ms;
    ms += 60_000;
  }
  return from + 3600_000;
}

/** 周期例行两次触发至少隔 5 分钟。看接下来两天里相邻两次的间隔。 */
export function assertSchedulable(cron: string, timeZone?: string): void {
  const first = nextCronTime(cron, Date.now(), timeZone);
  let prev = first;
  for (let i = 0; i < 32; i++) {
    const n = nextCronTime(cron, prev, timeZone);
    if (n <= prev) return;
    if (n - prev < MIN_CRON_GAP_MS) {
      const mins = Math.max(1, Math.round((n - prev) / 60_000));
      throw new Error(`例行两次触发至少隔 5 分钟（这份排期大约隔 ${mins} 分钟）`);
    }
    if (n - first >= 48 * 3600_000) return;
    prev = n;
  }
}

export function isValidCron(cron: string): boolean {
  try {
    parseCron(cron);
    return true;
  } catch {
    return false;
  }
}

/** UI：把 5 段 cron 说成人话 */
export function describeCron(cron: string): string {
  const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
  const [mi, h, d, mo, w] = String(cron).trim().split(/\s+/);
  if (!mi) return cron;
  const t = /^\d+$/.test(h) && /^\d+$/.test(mi) ? `${h.padStart(2, "0")}:${mi.padStart(2, "0")}` : null;
  if (mi === "*" && h === "*" && d === "*" && mo === "*" && w === "*") return "每分钟";
  if (/^\*\/\d+$/.test(mi) && h === "*" && d === "*" && w === "*") return `每 ${mi.slice(2)} 分钟`;
  if (/^\d+$/.test(mi) && h === "*" && d === "*" && w === "*") return `每小时第 ${mi} 分`;
  if (t && d === "*" && mo === "*" && w === "*") return `每天 ${t}`;
  if (t && d === "*" && mo === "*" && w === "1-5") return `工作日 ${t}`;
  if (t && d === "*" && mo === "*" && /^\d$/.test(w)) return `每周${WEEK[Number(w) % 7]} ${t}`;
  if (t && /^\d+$/.test(d) && mo === "*" && w === "*") return `每月 ${d} 日 ${t}`;
  return cron;
}
