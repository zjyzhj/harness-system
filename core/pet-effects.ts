/**
 * 桌宠叠加特效（不改皮肤文件，随时可还原）。
 * 现场优先：有相近已存 → 复用并告知；否则模型现场发明配方；规则模板仅兜底。
 * custom 带 TTL + LRU 回收，控内存。
 */
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readJsonSafe, writeJsonAtomic } from "./atomic-fs";
import type { PetAction } from "./pet-skin";

export type FxOverlay =
  | "beam"      // 龟派气功类光束
  | "aura"      // 周身光环
  | "burst"     // 爆发粒子
  | "rings"     // 冲击波环
  | "zzz"       // 睡觉 Z
  | "shake"     // 震屏感（CSS）
  | "spark"     // 星星闪
  | "hearts"    // 爱心
  | "sweat";    // 无语/慌

export interface FxRecipe {
  /** 同步播的骨架动作（不改皮肤，只播已有动作） */
  motion?: PetAction;
  holdSec?: number;
  overlay: FxOverlay;
  color?: string;
  durationMs?: number;
  /** 叠加层上飘的短字（如「龟派气功」） */
  label?: string;
  /** 光束朝向：left/right */
  dir?: "left" | "right";
}

export interface PetEffect {
  id: string;
  name: string;
  kind: "builtin" | "custom";
  aliases: string[];
  recipe: FxRecipe;
  createdAt: number;
  lastUsedAt: number;
  useCount: number;
  /** 绝对过期；builtin 无 */
  expiresAt?: number;
  /** 钉住：不参与自动回收 */
  sticky?: boolean;
  /** 触发原话，便于追溯 */
  sourcePhrase?: string;
}

interface EffectState {
  customs: PetEffect[];
}

export interface EffectGcOpts {
  /** 自定义特效上限 */
  maxCustom?: number;
  /** 未使用超过多久回收（默认 14 天） */
  unusedMs?: number;
  /** 新建自定义默认存活（默认 30 天，使用会刷新） */
  defaultTtlMs?: number;
}

const DAY = 86_400_000;

export const BUILTIN_EFFECTS: PetEffect[] = [
  mkBuiltin("fx-kamehameha", "龟派气功", ["气功波", "龟波", "kamehameha", "放波"], {
    overlay: "beam", color: "#60a5fa", durationMs: 2200, motion: "celebrate", holdSec: 2, label: "龟派气功！", dir: "right",
  }),
  mkBuiltin("fx-aura", "气场", ["冒光", "发光", "开光环", "aura"], {
    overlay: "aura", color: "#a78bfa", durationMs: 2500, motion: "think", holdSec: 2, label: "嗡…",
  }),
  mkBuiltin("fx-burst", "爆发", ["炸一下", "boom", "爆炸"], {
    overlay: "burst", color: "#f97316", durationMs: 1600, motion: "jump", holdSec: 2, label: "砰！",
  }),
  mkBuiltin("fx-rings", "冲击波", ["震波", "波纹"], {
    overlay: "rings", color: "#38bdf8", durationMs: 1800, motion: "celebrate", holdSec: 2,
  }),
  mkBuiltin("fx-zzz", "睡觉气", ["zzz", "打呼"], {
    overlay: "zzz", color: "#94a3b8", durationMs: 4000, motion: "sleep", holdSec: 6, label: "Zzz",
  }),
  mkBuiltin("fx-spark", "星星闪", ["闪一下", "sparkle", "亮晶晶"], {
    overlay: "spark", color: "#fbbf24", durationMs: 1800, motion: "celebrate", holdSec: 2,
  }),
  mkBuiltin("fx-hearts", "比心", ["爱心", "心动", "比个心"], {
    overlay: "hearts", color: "#fb7185", durationMs: 2000, motion: "celebrate", holdSec: 2,
  }),
  mkBuiltin("fx-sweat", "慌一下", ["无语", "尴尬", "冒汗"], {
    overlay: "sweat", color: "#67e8f9", durationMs: 1600, motion: "think", holdSec: 2,
  }),
  mkBuiltin("fx-shake", "震动", ["抖一下", "晃晃"], {
    overlay: "shake", color: "#e2e8f0", durationMs: 900, motion: "jump", holdSec: 1,
  }),
];

function mkBuiltin(id: string, name: string, aliases: string[], recipe: FxRecipe): PetEffect {
  const now = 0;
  return { id, name, kind: "builtin", aliases, recipe, createdAt: now, lastUsedAt: now, useCount: 0, sticky: true };
}

export const FX_OVERLAYS: FxOverlay[] = ["beam", "aura", "burst", "rings", "zzz", "shake", "spark", "hearts", "sweat"];
export const FX_MOTIONS: PetAction[] = ["idle", "walk", "jump", "sleep", "celebrate", "work", "think"];

/** 给模型的现场发明说明（只要 JSON） */
export function fxInventSystemPrompt(): string {
  return [
    "你为桌宠设计「叠加特效」配方。只输出一个 JSON 对象，不要 markdown、不要解释。",
    "特效画在形象上层，绝不改皮肤文件。",
    `字段：name(短中文名≤12字), aliases(string[]), overlay(${FX_OVERLAYS.join("|")}), color(#RRGGBB), motion(${FX_MOTIONS.join("|")}), holdSec(1-6), durationMs(600-4000), label(可选短喊招≤10字), dir(left|right 可选)。`,
    "按用户描述选最贴切的 overlay/颜色/动作；名字要好记、能复用。",
  ].join("\n");
}

export function fxInventUserPrompt(phrase: string): string {
  return `用户要的特效：${phrase.trim().slice(0, 80)}\n只输出 JSON。`;
}

/** 解析模型发明结果；不合格返回 null */
export function parseInventedEffect(raw: string): { name: string; aliases: string[]; recipe: FxRecipe } | null {
  const text = (raw || "").trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as Record<string, unknown>;
    const overlay = String(j.overlay || "").toLowerCase() as FxOverlay;
    if (!FX_OVERLAYS.includes(overlay)) return null;
    const motionRaw = String(j.motion || "celebrate").toLowerCase() as PetAction;
    const motion = FX_MOTIONS.includes(motionRaw) ? motionRaw : "celebrate";
    const color = /^#[0-9a-fA-F]{6}$/.test(String(j.color || "")) ? String(j.color) : "#93c5fd";
    const name = smartEffectName(String(j.name || "").trim() || "神秘特效");
    const aliases = Array.isArray(j.aliases)
      ? j.aliases.map((a) => String(a).trim()).filter(Boolean).slice(0, 6)
      : [];
    const durationMs = Math.min(4000, Math.max(600, Number(j.durationMs) || 1800));
    const holdSec = Math.min(6, Math.max(1, Number(j.holdSec) || 2));
    const label = j.label != null ? String(j.label).trim().slice(0, 12) || undefined : undefined;
    const dir = j.dir === "left" || j.dir === "right" ? j.dir : overlay === "beam" ? "right" : undefined;
    return {
      name,
      aliases: [...new Set([name, ...aliases])].slice(0, 8),
      recipe: { overlay, color, motion, holdSec, durationMs, label, dir },
    };
  } catch {
    return null;
  }
}

/** 规则兜底：从一句话推断（模型不可用时才用） */
export function inferEffectFromPhrase(phrase: string): { name: string; aliases: string[]; recipe: FxRecipe } {
  const raw = phrase.trim().replace(/^(?:放出|施展|来个|来一发|放个|整一个|表演一下|给我|帮我)\s*/i, "");
  const text = raw.replace(/[！!。.~～]+$/g, "").trim() || "神秘特效";
  const name = smartEffectName(text);

  let overlay: FxOverlay = "burst";
  let color = "#93c5fd";
  let motion: PetAction = "celebrate";
  let label = name.length <= 8 ? `${name}！` : undefined;

  if (/气功|光束|激光|波|射线|kame|能量波|龙息|吐息|吐纳/.test(text)) {
    overlay = "beam"; color = /红|火/.test(text) ? "#f87171" : /绿/.test(text) ? "#4ade80" : /紫/.test(text) ? "#c084fc" : "#60a5fa";
    motion = "celebrate"; label = label || "嘿！";
  } else if (/光环|气场|冒光|发光|护盾/.test(text)) {
    overlay = "aura"; color = /金|黄/.test(text) ? "#fbbf24" : /绿/.test(text) ? "#34d399" : "#a78bfa";
    motion = "think";
  } else if (/炸|爆|轰|砰/.test(text)) {
    overlay = "burst"; color = "#fb923c"; motion = "jump";
  } else if (/震|波纹|冲击/.test(text)) {
    overlay = "rings"; color = "#38bdf8";
  } else if (/睡|困|呼/.test(text)) {
    overlay = "zzz"; color = "#94a3b8"; motion = "sleep";
  } else if (/星|闪|亮/.test(text)) {
    overlay = "spark"; color = "#fde047";
  } else if (/心|爱|喜欢/.test(text)) {
    overlay = "hearts"; color = "#fb7185";
  } else if (/汗|慌|无语|尴尬/.test(text)) {
    overlay = "sweat"; color = "#67e8f9"; motion = "think";
  } else if (/抖|震|晃/.test(text)) {
    overlay = "shake"; motion = "jump";
  }

  if (/红|赤/.test(text)) color = "#f87171";
  else if (/蓝|青/.test(text)) color = "#60a5fa";
  else if (/绿/.test(text)) color = "#4ade80";
  else if (/紫/.test(text)) color = "#c084fc";
  else if (/金|黄/.test(text)) color = "#fbbf24";
  else if (/粉/.test(text)) color = "#f9a8d4";

  return {
    name,
    aliases: aliasesFrom(text, name),
    recipe: { overlay, color, durationMs: overlay === "beam" ? 2200 : 1800, motion, holdSec: 2, label, dir: "right" },
  };
}

/** 短、好认、可点名的名字 */
export function smartEffectName(text: string): string {
  let s = text.trim()
    .replace(/^(?:一个|一道|一发|一下|放出的|施展的)/, "")
    .replace(/[的地得]$/, "");
  // 去掉口语尾巴
  s = s.replace(/(?:看看|试试|吧|呀|啊|哦|嘛)$/g, "");
  if (s.length > 12) s = s.slice(0, 12);
  if (!s) s = `特效-${Date.now().toString(36).slice(-4)}`;
  return s;
}

function aliasesFrom(text: string, name: string): string[] {
  const set = new Set<string>([name, text].map((x) => x.trim()).filter(Boolean));
  if (name.length >= 2) set.add(name.slice(0, 2));
  return [...set].slice(0, 6);
}

export class PetEffectRegistry {
  private file: string;
  private state: EffectState;
  private o: Required<EffectGcOpts>;

  constructor(home: string, opts: EffectGcOpts = {}) {
    this.file = join(home, "pet-effects.json");
    this.state = readJsonSafe(this.file, { customs: [] as PetEffect[] });
    this.o = {
      maxCustom: opts.maxCustom ?? 40,
      unusedMs: opts.unusedMs ?? 14 * DAY,
      defaultTtlMs: opts.defaultTtlMs ?? 30 * DAY,
    };
    this.gc(true);
  }

  list(includeExpired = false): PetEffect[] {
    const now = Date.now();
    const customs = includeExpired
      ? this.state.customs
      : this.state.customs.filter((e) => !e.expiresAt || e.expiresAt > now);
    return [...BUILTIN_EFFECTS, ...customs];
  }

  get(idOrName: string): PetEffect | null {
    const q = idOrName.trim().toLowerCase();
    if (!q) return null;
    const all = this.list();
    return all.find((e) =>
      e.id.toLowerCase() === q
      || e.name.toLowerCase() === q
      || e.aliases.some((a) => a.toLowerCase() === q || q.includes(a.toLowerCase()) || a.toLowerCase().includes(q)),
    ) || null;
  }

  /** 播放：记一次使用并刷新 TTL（sticky/builtin 除外） */
  touch(id: string): PetEffect | null {
    const builtin = BUILTIN_EFFECTS.find((e) => e.id === id);
    if (builtin) {
      builtin.lastUsedAt = Date.now();
      builtin.useCount++;
      return builtin;
    }
    const e = this.state.customs.find((x) => x.id === id);
    if (!e) return null;
    const now = Date.now();
    e.lastUsedAt = now;
    e.useCount++;
    if (!e.sticky) e.expiresAt = now + this.o.defaultTtlMs;
    this.persist();
    return e;
  }

  /**
   * 找可复用的已有特效（含最近自定义）。score≥70 才建议复用。
   */
  findReusable(phrase: string): { effect: PetEffect; score: number } | null {
    const p = phrase.trim().toLowerCase().replace(/^(?:放出|施展|来个|来一发|放个|整一个|表演一下|给我|帮我)\s*/i, "");
    if (!p) return null;
    let best: { effect: PetEffect; score: number } | null = null;
    const now = Date.now();
    for (const e of this.list()) {
      let score = 0;
      const name = e.name.toLowerCase();
      if (p === name || p === e.id.toLowerCase()) score = 100;
      else if (e.aliases.some((a) => a.toLowerCase() === p)) score = 95;
      else if (p.includes(name) && name.length >= 2) score = 88;
      else if (e.aliases.some((a) => a.length >= 2 && (p.includes(a.toLowerCase()) || a.toLowerCase().includes(p)))) score = 82;
      else if (e.sourcePhrase && (e.sourcePhrase.toLowerCase().includes(p) || p.includes(e.sourcePhrase.toLowerCase().slice(0, 12)))) score = 78;
      else {
        const tokens = p.split(/[\s,，、]+/).filter((t) => t.length >= 2);
        let hit = 0;
        for (const t of tokens) {
          if (name.includes(t) || e.aliases.some((a) => a.toLowerCase().includes(t))) hit++;
        }
        if (hit) score = 50 + hit * 15;
      }
      // 最近用过的自定义略加分
      if (e.kind === "custom" && now - e.lastUsedAt < 7 * DAY) score += 5;
      if (score >= 70 && (!best || score > best.score)) best = { effect: e, score };
    }
    return best;
  }

  /**
   * 智能解析：复用 → 模型发明 → 规则兜底。
   * invent 由宿主注入（调 LLM）；不传或失败则走规则。
   */
  async resolveSmart(
    phrase: string,
    invent?: (phrase: string) => Promise<{ name: string; aliases: string[]; recipe: FxRecipe } | null>,
  ): Promise<{ effect: PetEffect; mode: "reuse" | "invent" | "fallback" }> {
    const reuse = this.findReusable(phrase);
    if (reuse) {
      return { effect: this.touch(reuse.effect.id) || reuse.effect, mode: "reuse" };
    }
    if (invent) {
      try {
        const drafted = await invent(phrase);
        if (drafted?.recipe?.overlay) {
          const effect = this.register({
            name: drafted.name,
            aliases: drafted.aliases,
            recipe: drafted.recipe,
            sourcePhrase: phrase,
          });
          this.touch(effect.id);
          return { effect, mode: "invent" };
        }
      } catch {
        /* 走兜底 */
      }
    }
    return { effect: this.createFromFallback(phrase), mode: "fallback" };
  }

  /** @deprecated 同步路径仅测试/兜底；产品用 resolveSmart */
  resolveOrCreate(phrase: string): { effect: PetEffect; created: boolean } {
    const reuse = this.findReusable(phrase);
    if (reuse) return { effect: this.touch(reuse.effect.id) || reuse.effect, created: false };
    return { effect: this.createFromFallback(phrase), created: true };
  }

  createFromFallback(phrase: string): PetEffect {
    const inferred = inferEffectFromPhrase(phrase);
    const same = this.state.customs.find((e) => e.name === inferred.name);
    if (same) {
      same.recipe = inferred.recipe;
      same.aliases = [...new Set([...same.aliases, ...inferred.aliases])].slice(0, 8);
      same.sourcePhrase = phrase;
      return this.touch(same.id) || same;
    }
    return this.register({
      name: inferred.name,
      aliases: inferred.aliases,
      recipe: inferred.recipe,
      sourcePhrase: phrase,
    });
  }

  /** 显式登记一条自定义配方（Bot/工具用）；可 sticky */
  register(input: {
    name: string;
    recipe: FxRecipe;
    aliases?: string[];
    sticky?: boolean;
    sourcePhrase?: string;
    ttlMs?: number;
  }): PetEffect {
    const name = smartEffectName(input.name);
    const existing = this.state.customs.find((e) => e.name === name);
    const now = Date.now();
    if (existing) {
      existing.recipe = input.recipe;
      existing.aliases = [...new Set([...(input.aliases || []), ...existing.aliases, name])].slice(0, 8);
      if (input.sticky != null) existing.sticky = input.sticky;
      if (input.sourcePhrase) existing.sourcePhrase = input.sourcePhrase;
      if (!existing.sticky) existing.expiresAt = now + (input.ttlMs ?? this.o.defaultTtlMs);
      existing.lastUsedAt = now;
      this.persist();
      return existing;
    }
    const effect: PetEffect = {
      id: `fxc-${randomUUID().slice(0, 8)}`,
      name,
      kind: "custom",
      aliases: [...new Set([...(input.aliases || []), name])].slice(0, 8),
      recipe: input.recipe,
      createdAt: now,
      lastUsedAt: now,
      useCount: 0,
      sticky: input.sticky === true,
      expiresAt: input.sticky ? undefined : now + (input.ttlMs ?? this.o.defaultTtlMs),
      sourcePhrase: input.sourcePhrase?.slice(0, 80),
    };
    this.state.customs.unshift(effect);
    this.gc(false);
    this.persist();
    return effect;
  }

  pin(idOrName: string, sticky = true): PetEffect | null {
    const e = this.state.customs.find((x) => x.id === idOrName || x.name === idOrName);
    if (!e) return null;
    e.sticky = sticky;
    e.expiresAt = sticky ? undefined : (Date.now() + this.o.defaultTtlMs);
    this.persist();
    return e;
  }

  remove(idOrName: string): boolean {
    const before = this.state.customs.length;
    this.state.customs = this.state.customs.filter((e) => e.id !== idOrName && e.name !== idOrName);
    if (this.state.customs.length === before) return false;
    this.persist();
    return true;
  }

  /** 回收：过期删除 + 超限按「久未用且使用少」淘汰（不碰 sticky/builtin） */
  gc(silent: boolean): { removed: string[] } {
    const now = Date.now();
    const removed: string[] = [];
    this.state.customs = this.state.customs.filter((e) => {
      if (e.sticky) return true;
      if (e.expiresAt && e.expiresAt <= now) {
        removed.push(e.name);
        return false;
      }
      if (now - e.lastUsedAt > this.o.unusedMs && e.useCount < 3) {
        removed.push(e.name);
        return false;
      }
      return true;
    });
    while (this.state.customs.filter((e) => !e.sticky).length > this.o.maxCustom) {
      const victims = this.state.customs
        .filter((e) => !e.sticky)
        .sort((a, b) => score(a) - score(b));
      const drop = victims[0];
      if (!drop) break;
      this.state.customs = this.state.customs.filter((e) => e.id !== drop.id);
      removed.push(drop.name);
    }
    if (!silent && removed.length) this.persist();
    else if (silent) this.persist();
    return { removed };
  }

  private matchPhrase(phrase: string): PetEffect | null {
    const p = phrase.trim().toLowerCase();
    for (const e of this.list()) {
      if (p.includes(e.name.toLowerCase())) return e;
      if (e.aliases.some((a) => a.length >= 2 && p.includes(a.toLowerCase()))) return e;
    }
    return null;
  }

  private persist() {
    // 只持久化自定义；builtin 在代码里
    // 控制体积：最多留 maxCustom*2 历史瞬间，但 gc 后通常 ≤ maxCustom
    writeJsonAtomic(this.file, { customs: this.state.customs.slice(0, this.o.maxCustom + 10) });
  }
}

function score(e: PetEffect): number {
  // 越低越先被回收：少用 + 久远
  return e.useCount * 10_000 + e.lastUsedAt / 1e10;
}
