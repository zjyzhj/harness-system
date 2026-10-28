/**
 * 桌面宠物智能偏好（用户掌舵）。
 *
 * 默认只保留基础能力（上台、气泡对话、回复/任务事件、换装、XP）。
 * 搭话 / 跟进 / 互访 / 自进化提议 / 召唤伙伴 等进阶能力默认关，需设置开关打开。
 * 用户主动一句话（换装、提醒、改人设）不受这些开关限制。
 *
 * 存储：config.json → prefs.pet（全局默认）+ prefs.petBots[botId]（单宠覆盖）
 */
export interface PetPrefs {
  /** 空闲搭话（有模型则现场发挥；无模型用模板） */
  companionChat: boolean;
  /** 主动跟进悬而未决的事（proactive） */
  proactiveFollowup: boolean;
  /** 空闲时主动做一件只读有用的事 */
  idleWork: boolean;
  /** 空闲时自动换形象（低频） */
  autoAppearance: boolean;
  /**
   * 允许 bot 用工具召唤/创建其他桌宠（pet.show / pet.create / createBot+pet）。
   * 用户自己说话改形象不受此限制。
   */
  agentMaySpawn: boolean;
  /**
   * 是否允许提出自进化（观察→提议）。默认关。
   * 开了才会冒泡问你；真正落地仍要你说「好」，除非再开 autoEvolve。
   */
  selfEvolve: boolean;
  /**
   * 自进化提议是否自动生效。默认关：宠物只提议，你说「好」才变。
   */
  autoEvolve: boolean;
  /** 多宠空闲时互相串门（娱乐） */
  petVisit: boolean;
  /** 用户空闲多久才主动开口（分钟） */
  idleMinutes: number;
  /** 每天最多搭话次数 */
  maxChatPerDay: number;
  /** 每天最多空闲做事次数 */
  maxWorkPerDay: number;
  /** 每周最多自动换装次数 */
  maxAppearPerWeek: number;
}

/** 进阶开关默认全部关闭；节奏数字保留合理默认 */
export const DEFAULT_PET_PREFS: PetPrefs = {
  companionChat: false,
  proactiveFollowup: false,
  idleWork: false,
  autoAppearance: false,
  agentMaySpawn: false,
  selfEvolve: false,
  autoEvolve: false,
  petVisit: false,
  idleMinutes: 45,
  maxChatPerDay: 4,
  maxWorkPerDay: 2,
  maxAppearPerWeek: 1,
};

const BOOL_KEYS = [
  "companionChat", "proactiveFollowup", "idleWork", "autoAppearance",
  "agentMaySpawn", "selfEvolve", "autoEvolve", "petVisit",
] as const;

type BoolKey = (typeof BOOL_KEYS)[number];

/** 从 prefs 原始对象抽出 pet，缺省补齐；非法数字夹回合理范围。进阶开关一律显式 true 才开。 */
export function normalizePetPrefs(raw: unknown): PetPrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<PetPrefs>;
  const num = (v: unknown, fallback: number, min: number, max: number) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  return {
    companionChat: r.companionChat === true,
    proactiveFollowup: r.proactiveFollowup === true,
    idleWork: r.idleWork === true,
    autoAppearance: r.autoAppearance === true,
    agentMaySpawn: r.agentMaySpawn === true,
    selfEvolve: r.selfEvolve === true,
    autoEvolve: r.autoEvolve === true,
    petVisit: r.petVisit === true,
    idleMinutes: num(r.idleMinutes, DEFAULT_PET_PREFS.idleMinutes, 5, 24 * 60),
    maxChatPerDay: num(r.maxChatPerDay, DEFAULT_PET_PREFS.maxChatPerDay, 0, 48),
    maxWorkPerDay: num(r.maxWorkPerDay, DEFAULT_PET_PREFS.maxWorkPerDay, 0, 24),
    maxAppearPerWeek: num(r.maxAppearPerWeek, DEFAULT_PET_PREFS.maxAppearPerWeek, 0, 7),
  };
}

/** 合并 prefs：保留 suggestions 等其它键，深度合并 pet；可选合并 petBots */
export function mergePrefs(prev: Record<string, unknown> | undefined, patch: Record<string, unknown>): Record<string, unknown> {
  const base = { ...(prev || {}) };
  const next = { ...base, ...patch };
  if (patch.pet !== undefined || base.pet !== undefined) {
    const prevPet = (base.pet && typeof base.pet === "object" ? base.pet : {}) as Record<string, unknown>;
    const patchPet = (patch.pet && typeof patch.pet === "object" ? patch.pet : patch.pet === undefined ? undefined : {}) as Record<string, unknown> | undefined;
    next.pet = normalizePetPrefs(patchPet ? { ...prevPet, ...patchPet } : prevPet);
  }
  if (patch.petBots !== undefined) {
    const prevBots = (base.petBots && typeof base.petBots === "object" ? base.petBots : {}) as Record<string, unknown>;
    const patchBots = (patch.petBots && typeof patch.petBots === "object" ? patch.petBots : {}) as Record<string, unknown>;
    next.petBots = { ...prevBots, ...patchBots };
  }
  return next;
}

export function petPrefsFromConfig(config: Record<string, unknown> | { prefs?: unknown }): PetPrefs {
  const prefs = (config as { prefs?: { pet?: unknown } }).prefs;
  return normalizePetPrefs(prefs?.pet);
}

/** 读某 bot 的有效偏好 = 全局默认 ⊕ petBots[botId] */
export function resolvePetPrefs(
  config: Record<string, unknown> | { prefs?: unknown },
  botId?: string,
): PetPrefs {
  const global = petPrefsFromConfig(config);
  if (!botId) return global;
  const prefs = (config as { prefs?: { petBots?: Record<string, unknown> } }).prefs;
  const over = prefs?.petBots?.[botId];
  if (!over || typeof over !== "object") return global;
  return normalizePetPrefs({ ...global, ...over });
}

/** 写入某 bot 的覆盖项（只存与全局不同的布尔/数字也可，这里直接浅合并 patch） */
export function patchPetBotPrefs(
  prev: Record<string, unknown> | undefined,
  botId: string,
  patch: Partial<PetPrefs>,
): Record<string, unknown> {
  const base = { ...(prev || {}) };
  const bots = { ...((base.petBots && typeof base.petBots === "object" ? base.petBots : {}) as Record<string, Record<string, unknown>>) };
  const cur = { ...(bots[botId] || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    cur[k] = v;
  }
  bots[botId] = cur;
  return { ...base, petBots: bots };
}

/** 删除 bot 时清掉其覆盖 */
export function clearPetBotPrefs(prev: Record<string, unknown> | undefined, botId: string): Record<string, unknown> {
  const base = { ...(prev || {}) };
  const bots = { ...((base.petBots && typeof base.petBots === "object" ? base.petBots : {}) as Record<string, unknown>) };
  if (!(botId in bots)) return base;
  delete bots[botId];
  return { ...base, petBots: bots };
}

export function isAdvancedPetFlag(key: string): key is BoolKey {
  return (BOOL_KEYS as readonly string[]).includes(key);
}
