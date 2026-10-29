/**
 * 轻量陪伴：空闲时宠物主动说一句（记忆关怀 / 时段问候），不抢主动跟进（proactive）的配额。
 * 可选 idleWork / autoAppearance 钩子（由宿主按 prefs.pet 注入）。
 */
import { join } from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./atomic-fs";
import type { Bot, MemoryEntry } from "./types";
import { OfflinePersona } from "./offline-persona";

export interface CompanionState {
  /** botId → 最近一次搭话时间 */
  last: Record<string, number>;
  /** 当天已搭话次数（所有 bot 合计） */
  dayKey?: string;
  dayCount?: number;
  /** 当天空闲做事次数 */
  workCount?: number;
  /** 本周自动换装：weekKey + count */
  appearWeekKey?: string;
  appearCount?: number;
}

export interface CompanionDeps {
  bots: () => Bot[];
  memory: (botId: string) => MemoryEntry[];
  /** 用户最后活动 */
  lastUserActivity: () => number;
  /** bot 是否正忙 */
  isBusy: (botId: string) => boolean;
  deliver: (botId: string, line: { text: string; title?: string; kind?: "chat" | "work" | "appear" }) => void;
  now?: () => number;
  /**
   * 动态闸门与配额。可按 botId 解析（全局默认 ⊕ 单宠覆盖）。
   * 不传 botId 时返回全局默认，用于总开关短路。
   */
  prefs?: (botId?: string) => {
    companionChat: boolean;
    idleWork: boolean;
    autoAppearance: boolean;
    idleMs: number;
    maxChatPerDay: number;
    maxWorkPerDay: number;
    maxAppearPerWeek: number;
  };
  /** 当前是否在桌面可见（藏起来的不主动打扰） */
  isShown?: (botId: string) => boolean;
  /** 空闲做事：只读短 turn */
  work?: (bot: Bot) => Promise<{ text: string; title?: string } | null>;
  /** 自动换装 */
  appear?: (bot: Bot) => Promise<{ text: string; title?: string } | null>;
  /** 有模型时的空闲搭话（失败则回落到 OfflinePersona） */
  chat?: (bot: Bot) => Promise<{ text: string; title?: string } | null>;
}

export interface CompanionOptions {
  /** 用户空闲多久才搭话 */
  idleMs?: number;
  /** 同一 bot 最短间隔（默认 45 分钟；过长会让开了开关仍「像坏了」） */
  gapMs?: number;
  /** 每天最多几句（全 bot 合计） */
  maxPerDay?: number;
  hours?: [number, number];
}

export interface CompanionTickOpts {
  /** 忽略用户空闲 / 同宠间隔 / 时段，用于设置页「立即试跑」 */
  force?: boolean;
}

export class CompanionEngine {
  private file: string;
  private state: CompanionState;
  private o: Required<CompanionOptions>;
  private persona = new OfflinePersona();

  constructor(home: string, private deps: CompanionDeps, opts: CompanionOptions = {}) {
    this.file = join(home, "companion.json");
    this.state = readJsonSafe(this.file, { last: {} as Record<string, number> });
    this.o = {
      idleMs: opts.idleMs ?? 45 * 60_000,
      gapMs: opts.gapMs ?? 45 * 60_000,
      maxPerDay: opts.maxPerDay ?? 4,
      hours: opts.hours ?? [9, 22],
    };
  }

  /** 供设置页 / 调试读取配额 */
  snapshotQuotas() {
    return {
      dayCount: this.state.dayCount ?? 0,
      workCount: this.state.workCount ?? 0,
      appearCount: this.state.appearCount ?? 0,
      dayKey: this.state.dayKey,
      appearWeekKey: this.state.appearWeekKey,
      last: { ...this.state.last },
    };
  }

  private livePrefs(botId?: string) {
    const p = this.deps.prefs?.(botId);
    return {
      // 无 prefs 注入时保持可测默认（搭话开）；宿主应注入 resolvePetPrefs（默认关）
      companionChat: p ? p.companionChat === true : true,
      idleWork: p?.idleWork === true,
      autoAppearance: p?.autoAppearance === true,
      idleMs: p?.idleMs ?? this.o.idleMs,
      maxChatPerDay: p?.maxChatPerDay ?? this.o.maxPerDay,
      maxWorkPerDay: p?.maxWorkPerDay ?? 2,
      maxAppearPerWeek: p?.maxAppearPerWeek ?? 1,
    };
  }

  forgetBot(botId: string) {
    if (!(botId in (this.state.last || {}))) return;
    delete this.state.last[botId];
    writeJsonAtomic(this.file, this.state);
  }

  /** 挑一只空闲且可见的宠物行动；行动了返回 botId */
  async tick(opts?: CompanionTickOpts): Promise<string | null> {
    const now = this.deps.now?.() ?? Date.now();
    const hour = new Date(now).getHours();
    if (!opts?.force && (hour < this.o.hours[0] || hour >= this.o.hours[1])) return null;

    const dayKey = new Date(now).toISOString().slice(0, 10);
    if (this.state.dayKey !== dayKey) {
      this.state.dayKey = dayKey;
      this.state.dayCount = 0;
      this.state.workCount = 0;
    }
    const weekKey = weekKeyOf(now);
    if (this.state.appearWeekKey !== weekKey) {
      this.state.appearWeekKey = weekKey;
      this.state.appearCount = 0;
    }

    const pets = this.deps.bots().filter((b) => {
      if (!b.petEnabled || this.deps.isBusy(b.id)) return false;
      if (this.deps.isShown && !this.deps.isShown(b.id)) return false;
      return true;
    });
    if (!pets.length) return null;

    const ranked = [...pets].sort((a, b) => (this.state.last[a.id] ?? 0) - (this.state.last[b.id] ?? 0));
    for (const bot of ranked) {
      const prefs = this.livePrefs(bot.id);
      // 同宠最短间隔（默认 45 分钟；测试可设 gapMs:1）。不再用 3 小时默默饿死进阶开关。
      if (!opts?.force && now - (this.state.last[bot.id] ?? 0) < this.o.gapMs) continue;
      if (!prefs.companionChat && !prefs.idleWork && !prefs.autoAppearance) continue;
      if (!opts?.force && now - this.deps.lastUserActivity() < prefs.idleMs) continue;

      // 优先：空闲做事 → 自动换装 → 搭话
      if (prefs.idleWork && this.deps.work && (this.state.workCount ?? 0) < prefs.maxWorkPerDay) {
        const line = await this.deps.work(bot);
        if (line?.text?.trim()) {
          this.state.last[bot.id] = now;
          this.state.workCount = (this.state.workCount ?? 0) + 1;
          writeJsonAtomic(this.file, this.state);
          this.deps.deliver(bot.id, { ...line, kind: "work" });
          return bot.id;
        }
      }

      if (prefs.autoAppearance && this.deps.appear && (this.state.appearCount ?? 0) < prefs.maxAppearPerWeek) {
        const line = await this.deps.appear(bot);
        if (line?.text?.trim()) {
          this.state.last[bot.id] = now;
          this.state.appearCount = (this.state.appearCount ?? 0) + 1;
          writeJsonAtomic(this.file, this.state);
          this.deps.deliver(bot.id, { ...line, kind: "appear" });
          return bot.id;
        }
      }

      if (!prefs.companionChat) continue;
      if ((this.state.dayCount ?? 0) >= prefs.maxChatPerDay) continue;

      let line: { text: string; title?: string } | null = null;
      if (this.deps.chat) {
        try { line = await this.deps.chat(bot); } catch { /* 回落离线模板 */ }
      }
      if (!line?.text?.trim()) line = this.persona.proactive(bot, this.deps.memory(bot.id));
      if (!line?.text?.trim()) continue;

      this.state.last[bot.id] = now;
      this.state.dayCount = (this.state.dayCount ?? 0) + 1;
      writeJsonAtomic(this.file, this.state);
      this.deps.deliver(bot.id, { ...line, kind: "chat" });
      return bot.id;
    }
    return null;
  }
}

function weekKeyOf(now: number): string {
  const d = new Date(now);
  const day = d.getUTCDay() || 7;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 1));
  return monday.toISOString().slice(0, 10);
}
