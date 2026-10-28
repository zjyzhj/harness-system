/**
 * 多宠互访：一只桌宠去另一只身边串门（娱乐向）。
 * - 记录拜访历史
 * - 提供文案给双方气泡
 * - 宿主负责把访客窗口挪到主人旁边再挪回
 */
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readJsonSafe, writeJsonAtomic } from "./atomic-fs";
import type { Bot } from "./types";

export interface PetVisitRecord {
  id: string;
  fromId: string;
  toId: string;
  fromName: string;
  toName: string;
  lineFrom: string;
  lineTo: string;
  at: number;
}

interface VisitState {
  lastPair: Record<string, number>;
  history: PetVisitRecord[];
  /** botId → peerId → 亲密度（串门升温） */
  affinity?: Record<string, Record<string, number>>;
}

export interface VisitDeps {
  bots: () => Bot[];
  now?: () => number;
  /** 是否允许自发串门（prefs） */
  enabled?: () => boolean;
  /** 当前是否在桌面可见；自发串门只挑可见的 */
  isShown?: (botId: string) => boolean;
  /**
   * 有模型时现场写双方台词；返回 null 则用规则模板。
   * 宿主注入，引擎不直接依赖 provider。
   */
  inventLines?: (from: Bot, to: Bot) => Promise<{ from: string; to: string } | null>;
}

const HOUR = 3600_000;
const LINES = [
  { from: "我去找 {to} 玩一会儿～", to: "{from} 来串门了！" },
  { from: "跟 {to} 打个招呼就回。", to: "嗨，{from} 来了。" },
  { from: "去看看 {to} 在干嘛。", to: "{from} 路过打了个招呼。" },
  { from: "拉上 {to} 一起摸会儿鱼。", to: "{from} 拉我摸鱼，哼。" },
];

/** 按双方人设挑更贴角色的串门台词（仍是模板，不是整段 LLM） */
function linesFor(from: Bot, to: Bot): { from: string; to: string } {
  const fromTraits = (from.personaCard?.traits || []).join("");
  const toTraits = (to.personaCard?.traits || []).join("");
  const fromCatch = from.personaCard?.catchphrase?.slice(0, 16);
  const toCatch = to.personaCard?.catchphrase?.slice(0, 16);
  const persona = `${from.persona || ""} ${to.persona || ""} ${fromTraits} ${toTraits}`;
  const pool = [...LINES];
  if (/酷|炫|稳/.test(persona)) {
    pool.unshift(
      { from: "路过看看 {to}，别太无聊。", to: "{from} 来了，挺利索。" },
    );
  }
  if (/可爱|萌|软/.test(persona)) {
    pool.unshift(
      { from: "嘿嘿，去找 {to} 蹭蹭～", to: "呀，{from} 来啦！" },
    );
  }
  if (/智慧|聪明|想/.test(persona)) {
    pool.unshift(
      { from: "去跟 {to} 交换一点灵感。", to: "{from} 来聊两句，正好。" },
    );
  }
  if (fromCatch) {
    pool.unshift({ from: `${fromCatch} ——去找 {to} 一下。`, to: LINES[0].to });
  }
  if (toCatch) {
    pool.unshift({ from: LINES[1].from, to: `${toCatch} {from} 来了。` });
  }
  const now = Date.now();
  return pool[Math.floor(Math.abs(now / 1000 + from.id.length + to.id.length) % pool.length)];
}

function pairKey(a: string, b: string) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export class PetVisitEngine {
  private file: string;
  private state: VisitState;

  constructor(home: string, private deps: VisitDeps) {
    this.file = join(home, "pet-visits.json");
    this.state = readJsonSafe(this.file, { lastPair: {}, history: [] });
  }

  list(botId?: string, limit = 40): PetVisitRecord[] {
    const all = [...this.state.history].sort((a, b) => b.at - a.at);
    const filtered = botId ? all.filter((v) => v.fromId === botId || v.toId === botId) : all;
    return filtered.slice(0, limit);
  }

  forgetBot(botId: string) {
    const before = this.state.history.length;
    this.state.history = this.state.history.filter((v) => v.fromId !== botId && v.toId !== botId);
    let pairChanged = false;
    for (const key of Object.keys(this.state.lastPair)) {
      if (key.split("|").includes(botId)) {
        delete this.state.lastPair[key];
        pairChanged = true;
      }
    }
    if (this.state.history.length === before && !pairChanged) return;
    writeJsonAtomic(this.file, this.state);
  }

  /**
   * 发起一次互访。from 去找 to。
   * 同一对 2 小时内不重复自发；用户手动触发可 force。
   * lines 可传入模型台词；否则规则模板。
   */
  visit(from: Bot, to: Bot, opts?: { force?: boolean; lines?: { from: string; to: string } }): PetVisitRecord | null {
    if (from.id === to.id) return null;
    if (!from.petEnabled || !to.petEnabled) return null;
    const now = this.deps.now?.() ?? Date.now();
    const key = pairKey(from.id, to.id);
    const last = this.state.lastPair[key];
    if (!opts?.force && last != null && now - last < 2 * HOUR) return null;

    const tpl = opts?.lines || linesFor(from, to);
    const rec: PetVisitRecord = {
      id: randomUUID(),
      fromId: from.id,
      toId: to.id,
      fromName: from.name,
      toName: to.name,
      lineFrom: tpl.from.replace(/\{to\}/g, to.name).replace(/\{from\}/g, from.name).slice(0, 80),
      lineTo: tpl.to.replace(/\{to\}/g, to.name).replace(/\{from\}/g, from.name).slice(0, 80),
      at: now,
    };
    this.state.lastPair[key] = now;
    this.state.history.unshift(rec);
    this.state.history = this.state.history.slice(0, 200);
    this.bumpAffinity(from.id, to.id, 2);
    this.bumpAffinity(to.id, from.id, 1);
    writeJsonAtomic(this.file, this.state);
    return rec;
  }

  affinityOf(botId: string): Record<string, number> {
    return { ...(this.state.affinity?.[botId] || {}) };
  }

  private bumpAffinity(botId: string, peerId: string, delta: number) {
    if (!this.state.affinity) this.state.affinity = {};
    const row = this.state.affinity[botId] || (this.state.affinity[botId] = {});
    row[peerId] = Math.min(100, (row[peerId] || 0) + delta);
  }

  /** 异步互访：优先 inventLines，失败用模板 */
  async visitSmart(from: Bot, to: Bot, opts?: { force?: boolean }): Promise<PetVisitRecord | null> {
    if (from.id === to.id) return null;
    if (!from.petEnabled || !to.petEnabled) return null;
    const now = this.deps.now?.() ?? Date.now();
    const key = pairKey(from.id, to.id);
    const last = this.state.lastPair[key];
    if (!opts?.force && last != null && now - last < 2 * HOUR) return null;

    let lines: { from: string; to: string } | undefined;
    if (this.deps.inventLines) {
      try {
        const invented = await this.deps.inventLines(from, to);
        if (invented?.from?.trim() && invented?.to?.trim()) {
          lines = { from: invented.from.trim().slice(0, 80), to: invented.to.trim().slice(0, 80) };
        }
      } catch { /* 模板兜底 */ }
    }
    return this.visit(from, to, { force: true, lines }); // 冷却已在上面查过
  }

  /** 空闲时按亲密度加权挑一对串门（同分再随机） */
  async tick(): Promise<PetVisitRecord | null> {
    if (this.deps.enabled && !this.deps.enabled()) return null;
    const pets = this.deps.bots().filter((b) => {
      if (!b.petEnabled) return false;
      if (this.deps.isShown && !this.deps.isShown(b.id)) return false;
      return true;
    });
    if (pets.length < 2) return null;
    const pairs: Array<{ from: Bot; to: Bot; score: number }> = [];
    for (const from of pets) {
      const aff = this.affinityOf(from.id);
      for (const to of pets) {
        if (from.id === to.id) continue;
        const warm = aff[to.id] || 0;
        const noise = Math.random() * 3;
        pairs.push({ from, to, score: warm + noise });
      }
    }
    pairs.sort((a, b) => b.score - a.score);
    for (const p of pairs) {
      const rec = await this.visitSmart(p.from, p.to);
      if (rec) return rec;
    }
    return null;
  }
}

/** 解析模型互访 JSON：{"from":"...","to":"..."} */
export function parseVisitLines(raw: string): { from: string; to: string } | null {
  const m = (raw || "").trim().match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as { from?: string; to?: string };
    const from = String(j.from || "").trim();
    const to = String(j.to || "").trim();
    if (!from || !to) return null;
    return { from: from.slice(0, 80), to: to.slice(0, 80) };
  } catch {
    return null;
  }
}
