/**
 * bot 模板：把一个 bot 的设定（人设、提示词、形象、私有技能）打包成可分享的链接或文件。
 * v2 可附带 needs（密钥/配置/命令等依赖名单，不含值）；导入方用自己的模型与本机 Vault。
 */
import { gunzipSync, gzipSync } from "node:zlib";
import type { Bot, BotNeeds, PersonaCard } from "./types";

export const TEMPLATE_SCHEME = "harnessbot";
export const TEMPLATE_EXT = "harnessbot";

export type { BotNeeds, NeedEnv, NeedSecret, NeedSharedSkill } from "./types";

export interface BotTemplate {
  v: 1 | 2;
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
  /** v2：本机依赖清单（无密钥/配置值） */
  needs?: BotNeeds;
}

const MAX_SKILLS = 30;
const MAX_TEXT = 60_000;
const MAX_NEEDS = 40;

export function templateOf(bot: Bot, skills: BotTemplate["skills"], avatar?: string, needs?: BotNeeds): BotTemplate {
  return {
    v: 2,
    name: bot.name,
    role: bot.role,
    persona: bot.persona,
    systemPrompt: bot.systemPrompt,
    personaCard: bot.personaCard,
    skinId: bot.skinId,
    avatar,
    shape: avatar ? undefined : bot.avatar,
    skills,
    needs: needs && (needs.secrets.length || needs.env.length || needs.commands?.length || needs.mcp?.length || needs.sharedSkills?.length)
      ? needs
      : undefined,
  };
}

export function encodeTemplate(t: BotTemplate): string {
  return gzipSync(Buffer.from(JSON.stringify(t), "utf8")).toString("base64url");
}

export function templateLink(t: BotTemplate): string {
  return `${TEMPLATE_SCHEME}://bot/${encodeTemplate(t)}`;
}

const str = (v: unknown, max = MAX_TEXT) => (typeof v === "string" ? v.slice(0, max) : "");

function normalizeNeeds(raw: unknown): BotNeeds | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const secrets = Array.isArray(o.secrets) ? o.secrets.slice(0, MAX_NEEDS) : [];
  const env = Array.isArray(o.env) ? o.env.slice(0, MAX_NEEDS) : [];
  const commands = Array.isArray(o.commands)
    ? o.commands.map((x) => str(x, 80).trim()).filter(Boolean).slice(0, MAX_NEEDS)
    : [];
  const mcp = Array.isArray(o.mcp)
    ? o.mcp.map((x) => str(x, 80).trim()).filter(Boolean).slice(0, MAX_NEEDS)
    : [];
  const sharedSkills = Array.isArray(o.sharedSkills) ? o.sharedSkills.slice(0, MAX_NEEDS) : [];
  const needs: BotNeeds = {
    secrets: secrets
      .map((x) => x as Record<string, unknown>)
      .map((x) => ({
        name: str(x.name, 80).trim(),
        label: str(x.label, 80).trim() || undefined,
        note: str(x.note, 500).trim() || undefined,
      }))
      .filter((x) => x.name && /^[A-Za-z_][\w]*$/.test(x.name)),
    env: env
      .map((x) => x as Record<string, unknown>)
      .map((x) => ({
        key: str(x.key, 80).trim(),
        label: str(x.label, 80).trim() || undefined,
        note: str(x.note, 500).trim() || undefined,
        hint: str(x.hint, 500).trim() || undefined,
      }))
      .filter((x) => x.key && /^[A-Za-z_][\w]*$/.test(x.key)),
    commands: commands.length ? commands : undefined,
    mcp: mcp.length ? mcp : undefined,
    sharedSkills: sharedSkills
      .map((x) => x as Record<string, unknown>)
      .map((x) => ({
        name: str(x.name, 80).trim(),
        description: str(x.description, 500).trim(),
      }))
      .filter((x) => x.name && x.description),
  };
  if (!needs.sharedSkills?.length) delete needs.sharedSkills;
  if (!needs.secrets.length && !needs.env.length && !needs.commands && !needs.mcp && !needs.sharedSkills) return undefined;
  return needs;
}

/** 校验并规范化：外来数据只保留认识的字段；v1 / v2 均可 */
export function normalizeTemplate(raw: unknown): BotTemplate {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o.v !== 1 && o.v !== 2) throw new Error("不是 Harness Bot 的 bot 模板，或版本不支持");
  const name = str(o.name, 40).trim();
  if (!name) throw new Error("模板里缺少 bot 名字");
  const avatar = str(o.avatar, 400_000);
  const skills = Array.isArray(o.skills) ? o.skills.slice(0, MAX_SKILLS) : [];
  const sh = (o.shape ?? {}) as Record<string, unknown>;
  const shape = /^[a-z]{2,20}$/.test(str(sh.shape)) && /^#[0-9a-f]{6}$/i.test(str(sh.color)) ? { shape: str(sh.shape), color: str(sh.color) } : undefined;
  const needs = o.v === 2 ? normalizeNeeds(o.needs) : undefined;
  return {
    v: o.v === 2 ? 2 : 1,
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
    needs,
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
