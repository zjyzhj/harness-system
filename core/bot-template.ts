/**
 * bot 模板：把一个 bot 的设定（人设、提示词、形象、私有技能）打包成可分享的链接或文件。
 * 不含模型配置、记忆和会话；导入方用自己的模型。
 */
import { gunzipSync, gzipSync } from "node:zlib";
import type { Bot, PersonaCard } from "./types";

export const TEMPLATE_SCHEME = "harnessbot";
export const TEMPLATE_EXT = "harnessbot";

export interface BotTemplate {
  v: 1;
  name: string;
  role: string;
  persona: string;
  systemPrompt?: string;
  personaCard?: PersonaCard;
  skinId?: string;
  /** 头像（data URL，已缩小） */
  avatar?: string;
  /** 形状头像（没有图片头像时用） */
  shape?: Bot["avatar"];
  skills: { name: string; description: string; body: string }[];
}

const MAX_SKILLS = 30;
const MAX_TEXT = 60_000;

export function templateOf(bot: Bot, skills: BotTemplate["skills"], avatar?: string): BotTemplate {
  return {
    v: 1,
    name: bot.name,
    role: bot.role,
    persona: bot.persona,
    systemPrompt: bot.systemPrompt,
    personaCard: bot.personaCard,
    skinId: bot.skinId,
    avatar,
    shape: avatar ? undefined : bot.avatar,
    skills,
  };
}

export function encodeTemplate(t: BotTemplate): string {
  return gzipSync(Buffer.from(JSON.stringify(t), "utf8")).toString("base64url");
}

export function templateLink(t: BotTemplate): string {
  return `${TEMPLATE_SCHEME}://bot/${encodeTemplate(t)}`;
}

const str = (v: unknown, max = MAX_TEXT) => (typeof v === "string" ? v.slice(0, max) : "");

/** 校验并规范化：外来数据只保留认识的字段 */
export function normalizeTemplate(raw: unknown): BotTemplate {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o.v !== 1) throw new Error("不是 Harness Bot 的 bot 模板，或版本不支持");
  const name = str(o.name, 40).trim();
  if (!name) throw new Error("模板里缺少 bot 名字");
  const avatar = str(o.avatar, 400_000);
  const skills = Array.isArray(o.skills) ? o.skills.slice(0, MAX_SKILLS) : [];
  const sh = (o.shape ?? {}) as Record<string, unknown>;
  const shape = /^[a-z]{2,20}$/.test(str(sh.shape)) && /^#[0-9a-f]{6}$/i.test(str(sh.color)) ? { shape: str(sh.shape), color: str(sh.color) } : undefined;
  return {
    v: 1,
    name,
    role: str(o.role, 200) || "通用助手",
    persona: str(o.persona, 4000),
    systemPrompt: str(o.systemPrompt) || undefined,
    personaCard: o.personaCard && typeof o.personaCard === "object" ? (o.personaCard as PersonaCard) : undefined,
    skinId: str(o.skinId, 40) || undefined,
    avatar: /^data:image\/(png|jpe?g|webp);base64,/.test(avatar) ? avatar : undefined,
    shape,
    skills: skills
      .map((k) => k as Record<string, unknown>)
      .map((k) => ({ name: str(k.name, 80).trim(), description: str(k.description, 500).trim(), body: str(k.body) }))
      .filter((k) => k.name && k.description),
  };
}

/** 认得：harnessbot://bot/<code>、裸 code、模板 JSON 文本 */
export function parseTemplate(input: string): BotTemplate {
  const text = input.trim();
  if (text.startsWith("{")) return normalizeTemplate(JSON.parse(text));
  const code = text.replace(new RegExp(`^${TEMPLATE_SCHEME}://bot/`, "i"), "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9_-]+$/.test(code)) throw new Error("链接格式不对：应该是 harnessbot://bot/… 开头");
  let json: string;
  try {
    json = gunzipSync(Buffer.from(code, "base64url")).toString("utf8");
  } catch {
    throw new Error("链接不完整或已损坏，请让对方重新复制");
  }
  return normalizeTemplate(JSON.parse(json));
}

/** 起一个不和现有 bot 重名的名字 */
export function uniqueBotName(name: string, taken: string[]): string {
  if (!taken.includes(name)) return name;
  const base = name.replace(/ \d+$/, "");
  for (let i = 2; ; i++) {
    const n = `${base} ${i}`;
    if (!taken.includes(n)) return n;
  }
}
