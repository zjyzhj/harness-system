/**
 * PetMind：宠物心智只读投影 + 活动日志。
 * 各引擎仍写各自文件；决策前读 mind，决策后 noteDecision。
 */
import { join } from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import type { Bot, MemoryEntry, PersonaCard } from "./types";
import type { PetPrefs } from "./pet-prefs";
import { DEFAULT_PET_SKIN_ID } from "./pet-skin";

export type PetMindRenderMode = "live2d" | "sprite" | "shape" | "emoji";

export interface PetMind {
  botId: string;
  identity: {
    name: string;
    role: string;
    persona: string;
    card?: PersonaCard;
    skinId: string;
    avatar?: Bot["avatar"];
    avatarPath?: string;
  };
  bond: {
    xp: number;
    level: number;
    stage: string;
    affinity: Record<string, number>;
  };
  memory: {
    recentFacts: string[];
    pendingEvolveTitle?: string;
  };
  autonomy: {
    prefs: PetPrefs;
    quotas: { chatLeft: number; workLeft: number; appearLeft: number };
  };
  recentUserLines: string[];
}

export interface PetActivityEntry {
  at: number;
  botId: string;
  kind: string;
  via: "model" | "rule" | "user" | "system";
  note: string;
  blocked?: boolean;
}

export interface PetMindSources {
  bot: Bot;
  xp: number;
  prefs: PetPrefs;
  memories: MemoryEntry[];
  recentUserLines?: string[];
  affinity?: Record<string, number>;
  pendingEvolveTitle?: string;
  companionQuotas?: { dayCount: number; workCount: number; appearCount: number };
}

export function levelFromXp(xp: number): number {
  return Math.floor(Math.sqrt(Math.max(0, xp) / 100)) + 1;
}

export function stageFromLevel(level: number): string {
  if (level >= 10) return "传说";
  if (level >= 7) return "资深";
  if (level >= 4) return "成长";
  return "幼年";
}

/** 聚合一只宠的心智投影（纯函数，可测） */
export function buildPetMind(src: PetMindSources): PetMind {
  const { bot, xp, prefs, memories } = src;
  const level = levelFromXp(xp);
  const facts = memories
    .filter((m) => m.kind === "fact" || m.kind === "rule" || m.kind === "note")
    .slice(0, 8)
    .map((m) => `[${m.kind}] ${m.content.slice(0, 80)}`);
  const dayLeft = Math.max(0, prefs.maxChatPerDay - (src.companionQuotas?.dayCount ?? 0));
  const workLeft = Math.max(0, prefs.maxWorkPerDay - (src.companionQuotas?.workCount ?? 0));
  const appearLeft = Math.max(0, prefs.maxAppearPerWeek - (src.companionQuotas?.appearCount ?? 0));
  return {
    botId: bot.id,
    identity: {
      name: bot.name,
      role: bot.role || "",
      persona: bot.persona || bot.personaCard?.traits?.join("、") || "",
      card: bot.personaCard,
      skinId: bot.skinId || DEFAULT_PET_SKIN_ID,
      avatar: bot.avatar,
      avatarPath: bot.avatarPath,
    },
    bond: {
      xp,
      level,
      stage: stageFromLevel(level),
      affinity: src.affinity || {},
    },
    memory: {
      recentFacts: facts,
      pendingEvolveTitle: src.pendingEvolveTitle,
    },
    autonomy: {
      prefs,
      quotas: { chatLeft: dayLeft, workLeft, appearLeft },
    },
    recentUserLines: (src.recentUserLines || []).slice(0, 8),
  };
}

/** 塞进模型 user/system 的紧凑心智摘要 */
export function formatMindForPrompt(mind: PetMind, opts?: { peers?: Array<{ id: string; name: string }> }): string {
  const lines: string[] = [
    `名字：${mind.identity.name}（${mind.identity.role || "伙伴"}）`,
    `人设：${mind.identity.persona || "友好"}`,
    `等级：Lv.${mind.bond.level} ${mind.bond.stage} · XP ${mind.bond.xp}`,
    `当前皮：${mind.identity.skinId}`,
  ];
  if (mind.identity.card?.catchphrase) lines.push(`口头禅：${mind.identity.card.catchphrase}`);
  if (mind.memory.pendingEvolveTitle) lines.push(`待确认进化：${mind.memory.pendingEvolveTitle}`);
  if (mind.memory.recentFacts.length) {
    lines.push("记忆：");
    for (const f of mind.memory.recentFacts.slice(0, 6)) lines.push(`- ${f}`);
  }
  if (mind.recentUserLines.length) {
    lines.push("最近用户话：");
    for (const t of mind.recentUserLines.slice(0, 5)) lines.push(`- ${t.slice(0, 60)}`);
  }
  const aff = Object.entries(mind.bond.affinity).sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (aff.length && opts?.peers?.length) {
    const nameOf = (id: string) => opts.peers!.find((p) => p.id === id)?.name || id;
    lines.push("关系：" + aff.map(([id, v]) => `${nameOf(id)}=${v}`).join("，"));
  }
  const p = mind.autonomy.prefs;
  lines.push(
    `开关：搭话${on(p.companionChat)} 做事${on(p.idleWork)} 换装${on(p.autoAppearance)} 互访${on(p.petVisit)} 进化${on(p.selfEvolve)}`,
  );
  lines.push(
    `配额：搭话剩${mind.autonomy.quotas.chatLeft} 做事剩${mind.autonomy.quotas.workLeft} 换装剩${mind.autonomy.quotas.appearLeft}`,
  );
  return lines.join("\n");
}

function on(v: boolean) {
  return v ? "开" : "关";
}

/** 追加一条活动（jsonl）；目录不存在则创建 */
export function notePetDecision(home: string, entry: Omit<PetActivityEntry, "at"> & { at?: number }): PetActivityEntry {
  const full: PetActivityEntry = { ...entry, at: entry.at ?? Date.now() };
  const dir = join(home, "logs");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, "pet-activity.jsonl");
  try {
    appendFileSync(file, JSON.stringify(full) + "\n", "utf8");
  } catch {
    /* 日志失败不影响主流程 */
  }
  return full;
}

/** 读最近活动（新→旧） */
export function listPetActivity(home: string, opts?: { botId?: string; limit?: number }): PetActivityEntry[] {
  const file = join(home, "logs", "pet-activity.jsonl");
  if (!existsSync(file)) return [];
  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const limit = opts?.limit ?? 40;
  const rows: PetActivityEntry[] = [];
  const lines = raw.trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0 && rows.length < limit * 3; i--) {
    try {
      const j = JSON.parse(lines[i]) as PetActivityEntry;
      if (opts?.botId && j.botId !== opts.botId) continue;
      rows.push(j);
      if (rows.length >= limit) break;
    } catch {
      /* skip bad line */
    }
  }
  return rows;
}

/**
 * 从自主发言里抽一句可沉淀的短事实；太闲聊则返回 null。
 */
export function extractCompanionFact(text: string): string | null {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (t.length < 12 || t.length > 120) return null;
  if (/^(嗨|你好|在吗|早|晚安|嘿嘿|哼)/.test(t) && t.length < 24) return null;
  if (/换上了「|串门|进化/.test(t)) return t.slice(0, 100);
  if (/记得|你说|上次|别忘|提醒|还没|未完成|要不要/.test(t)) return t.slice(0, 100);
  return null;
}
