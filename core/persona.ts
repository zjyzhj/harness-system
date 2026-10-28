import { join } from "node:path";
import type { Bot, PersonaCard } from "./types";
import type { Store } from "./store";
import { avatarFromDescription } from "./avatar";
import { LIVE2D_SKINS, SHAPE_SKIN, SHAPE_SKIN_ID } from "./pet-skin";
import { RECOMMENDED_PETDEX } from "./petdex";

export interface ImageGenResult {
  path?: string;
  dataUrl?: string;
  degraded: boolean;
}

export interface ImageGenProvider {
  generate(prompt: string, destPath: string): Promise<ImageGenResult>;
}

export interface AppearanceSuggestion {
  /** live2d/local = 已可换上；petdex = 需下载 */
  kind: "live2d" | "local" | "petdex";
  /** 皮肤 id，或 petdex slug */
  id: string;
  name: string;
  why: string;
  score: number;
}

export interface AppearanceGenerateResult {
  card: PersonaCard;
  /** 仅在 AI 生图成功时有值；绝不写字母渐变假 PNG */
  avatarPath?: string;
  /** 代码绘制的形状头像（产品 blob 引擎） */
  avatar?: { shape: string; color: string };
  /** 建议自动换上的已装皮肤（Live2D / 本地 sprite / 形状色块） */
  appliedSkin?: { id: string; name: string };
  suggestions: AppearanceSuggestion[];
  /** 是否用 AI 画出了新头像文件 */
  imaged: boolean;
  /** 是否用代码画出了形状头像 */
  codeDrawn: boolean;
  /** 给用户的诚实说明 */
  message: string;
}

export type AppearancePick =
  | { action: "keep" }
  | { action: "shape" }
  | { action: "skin"; id: string; name: string };

export interface GenerateAppearanceOpts {
  /** 本地已注册皮肤（含 Live2D） */
  localSkins?: Array<{ id: string; name: string; desc?: string }>;
  /** 有强匹配本地皮时是否建议自动换上，默认 true */
  preferSkin?: boolean;
  /**
   * 智能选型（模型优先）：在候选里决定 keep / shape / 某张本地皮。
   * 返回 null → 走规则兜底。
   */
  pickSmart?: (ctx: {
    description: string;
    suggestions: AppearanceSuggestion[];
    currentSkinId?: string;
  }) => Promise<AppearancePick | null>;
}

/**
 * 一句话生成形象（智能优先）：
 * 1) 有 AI 生图 → 真图画头像
 * 2) 否则代码画形状头像；桌宠换皮由模型/规则选型（几何→形状皮，强匹配→Live2D，否则保持原皮）
 * 绝不写「字母+渐变」假 PNG，也绝不无脑硬切形状色块。
 */
export class PersonaGenerator {
  constructor(
    private store: Store,
    private assetsDir: string,
    private imageGen?: ImageGenProvider,
  ) {}

  hasImageGen(): boolean {
    return !!this.imageGen;
  }

  async generate(
    bot: Bot,
    description: string,
    style?: "default" | "pixel" | "cute",
    opts: GenerateAppearanceOpts = {},
  ): Promise<AppearanceGenerateResult> {
    void style;
    const card = buildCard(bot, description);
    const local = opts.localSkins?.length
      ? opts.localSkins
      : [
          ...LIVE2D_SKINS.map((s) => ({ id: s.id, name: s.name, desc: s.desc })),
          { id: SHAPE_SKIN.id, name: SHAPE_SKIN.name, desc: SHAPE_SKIN.desc },
        ];
    const suggestions = suggestAppearances(description, local);
    const preferSkin = opts.preferSkin !== false;
    const bestLocal = suggestions.find((s) => s.kind === "live2d" || s.kind === "local");

    if (this.imageGen) {
      const pngPath = join(this.assetsDir, `${bot.id}.png`);
      try {
        const r = await this.imageGen.generate(description, pngPath);
        const avatarPath = r.path || r.dataUrl;
        if (avatarPath) {
          this.store.saveBot({ ...bot, avatarPath, personaCard: card, avatar: undefined });
          return {
            card,
            avatarPath,
            suggestions,
            imaged: true,
            codeDrawn: false,
            message: `已用 AI 生图画出头像并更新角色卡。桌宠外形仍用当前皮肤；要换皮可用 pet.skin / pet.search。`,
            ...(preferSkin && bestLocal && bestLocal.score >= 80
              ? { appliedSkin: { id: bestLocal.id, name: bestLocal.name } }
              : {}),
          };
        }
      } catch {
        // 生图失败：走代码绘制，不写假 PNG
      }
    }

    // 无 AI 生图：代码画形状头像 + 智能决定桌宠是否换皮
    const avatar = avatarFromDescription(description, bot.id);
    let pick: AppearancePick | null = null;
    if (preferSkin && opts.pickSmart) {
      try {
        pick = await opts.pickSmart({ description, suggestions, currentSkinId: bot.skinId });
      } catch {
        pick = null;
      }
    }
    if (!pick) pick = preferSkin ? pickAppearanceRule(description, suggestions) : { action: "keep" };

    let appliedSkin: AppearanceGenerateResult["appliedSkin"];
    if (pick.action === "shape") {
      appliedSkin = { id: SHAPE_SKIN_ID, name: SHAPE_SKIN.name };
    } else if (pick.action === "skin") {
      appliedSkin = { id: pick.id, name: pick.name };
    }

    this.store.saveBot({
      ...bot,
      personaCard: card,
      avatar,
      avatarPath: undefined,
      ...(appliedSkin?.id === SHAPE_SKIN_ID ? { skinId: SHAPE_SKIN_ID } : {}),
    });

    const tips = suggestions.slice(0, 5).map((s) =>
      s.kind === "petdex"
        ? `「${s.name}」（需 pet.install slug=${s.id}）`
        : `「${s.name}」（pet.skin skin=${s.id}）`,
    );

    const shapeNote = `已用代码画出形状头像（${avatar.shape} / ${avatar.color}）。`;
    let message: string;
    if (appliedSkin?.id === SHAPE_SKIN_ID) {
      message = `${shapeNote}桌宠已换上代码绘制的形状皮，直接显示这颗头像。这不是 AI 写实生图。想要 Live2D/社区皮：${tips.filter((t) => !t.includes("形状")).slice(0, 3).join("；") || "用 pet.search"}；或配置 [图片生成设置](app:settings/image)。`;
    } else if (appliedSkin) {
      message = this.imageGen
        ? `AI 生图失败。${shapeNote}桌宠换上已有形象「${appliedSkin.name}」。`
        : `未配置 AI 生图。${shapeNote}桌宠换上「${appliedSkin.name}」。也可去 [图片生成设置](app:settings/image) 配真生图。`;
    } else {
      message = `${shapeNote}桌宠外形保持当前皮肤；聊天头像已更新。可落地的其它外形：${tips.join("；") || "暂无"}。配置生图可画写实图：[图片生成设置](app:settings/image)。`;
    }

    return { card, avatar, suggestions, imaged: false, codeDrawn: true, message, appliedSkin };
  }

  cardToText(card: PersonaCard): string {
    return [
      `名称：${card.name}`,
      `性格：${card.traits.join("、")}`,
      card.catchphrase ? `口头禅：${card.catchphrase}` : "",
      card.background ? `背景：${card.background}` : "",
      card.interactionStyle ? `互动偏好：${card.interactionStyle}` : "",
    ].filter(Boolean).join("\n");
  }
}

/** 几何/简单色块意图：球、心、星等适合代码形状皮上台 */
export function wantsCodeShape(description: string): boolean {
  return /形状|色块|简单头像|代码画|blob|画个球|圆球|球体|爱心|星星|五角星|色块头像/.test(description)
    || /^(?:画|做|生成)(?:一[个只]|个)?(?:球|圆|心|星|方块|三角)/.test(description.trim());
}

/**
 * 规则兜底选型（无模型或模型失败时）：
 * - 几何/色块意图 → 形状皮上台
 * - 本地强匹配（≥50）→ 换那张皮
 * - 否则保持原皮（只更新聊天头像）——不无脑硬切形状色块
 */
export function pickAppearanceRule(
  description: string,
  suggestions: AppearanceSuggestion[],
): AppearancePick {
  if (wantsCodeShape(description)) return { action: "shape" };
  const best = suggestions.find((s) => (s.kind === "live2d" || s.kind === "local") && s.id !== SHAPE_SKIN_ID && s.score >= 50);
  if (best) return { action: "skin", id: best.id, name: best.name };
  const shapeHit = suggestions.find((s) => s.id === SHAPE_SKIN_ID && s.score >= 50);
  if (shapeHit) return { action: "shape" };
  return { action: "keep" };
}

/** 解析模型选型 JSON：{"action":"keep|shape|skin","id"?,"name"?} */
export function parseAppearancePick(raw: string, suggestions: AppearanceSuggestion[]): AppearancePick | null {
  const m = (raw || "").trim().match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as { action?: string; id?: string; name?: string; slug?: string };
    const action = String(j.action || "").toLowerCase();
    if (action === "keep") return { action: "keep" };
    if (action === "shape") return { action: "shape" };
    if (action === "skin") {
      const id = String(j.id || j.slug || "").trim();
      const hit = suggestions.find((s) => (s.kind === "live2d" || s.kind === "local") && (s.id === id || s.name === j.name));
      if (hit) return { action: "skin", id: hit.id, name: hit.name };
    }
  } catch {
    return null;
  }
  return null;
}

/** 按描述从本地皮 / 推荐 petdex 里找可落地的替代（不造图） */
export function suggestAppearances(
  description: string,
  localSkins: Array<{ id: string; name: string; desc?: string }> = [],
): AppearanceSuggestion[] {
  const q = description.trim().toLowerCase();
  const scored: AppearanceSuggestion[] = [];

  for (const s of localSkins) {
    const blob = `${s.id} ${s.name} ${s.desc || ""}`.toLowerCase();
    let score = scoreMatch(q, blob, s.name);
    const isShape = s.id === SHAPE_SKIN_ID || /形状|色块|blob/.test(blob);
    const kind: AppearanceSuggestion["kind"] = s.id.startsWith("live2d-") || LIVE2D_SKINS.some((l) => l.id === s.id)
      ? "live2d"
      : "local";
    // 日文名/少女类描述偏向 Live2D
    if (kind === "live2d" && /少女|美少女|动漫|live2d|日系|二次元/.test(description)) score += 25;
    if (kind === "live2d" && /魔法/.test(description) && /mao|真央/.test(blob)) score += 30;
    // 形状皮：几何/色块意图抬分；否则低保底便于列表可见
    if (isShape) score = Math.max(score, wantsCodeShape(description) ? 75 : 5);
    if (score > 0) {
      scored.push({
        kind,
        id: s.id,
        name: s.name,
        why: isShape ? "代码绘制形状头像，可直接上台" : "本地已有，可直接换上",
        score,
      });
    }
  }

  for (const r of RECOMMENDED_PETDEX) {
    const blob = `${r.slug} ${r.name} ${r.group}`.toLowerCase();
    let score = scoreMatch(q, blob, r.name);
    if (/猫|橘猫|喵/.test(description) && /猫|doro|喵|cat/i.test(blob)) score += 20;
    if (/龙|奶龙/.test(description) && /奶龙|nailong/.test(blob)) score += 40;
    if (/咕嘎|鸭子|鸭/.test(description) && /咕嘎|guga/.test(blob)) score += 40;
    if (/深[度求]|肥鱼|whale/.test(description) && /deepseek|肥鱼|whale/.test(blob)) score += 35;
    if (score > 0) {
      scored.push({
        kind: "petdex",
        id: r.slug,
        name: r.name,
        why: "社区库可下载（非 PNG 序列帧垃圾，是完整 spritesheet）",
        score,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  // 去重：同名保留高分
  const seen = new Set<string>();
  return scored.filter((s) => {
    const k = `${s.kind}:${s.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 8);
}

function scoreMatch(query: string, blob: string, name: string): number {
  if (!query) return 0;
  const n = name.toLowerCase();
  if (query === n || query === blob) return 100;
  if (blob.includes(query) || query.includes(n)) return 70;
  const tokens = query.split(/[\s,，、]+/).filter((t) => t.length >= 2);
  let hit = 0;
  for (const t of tokens) if (blob.includes(t.toLowerCase())) hit++;
  if (hit) return 30 + hit * 15;
  return 0;
}

export function buildCard(bot: Bot, description: string): PersonaCard {
  const cleanDesc = description.trim().replace(/^(?:形象是|生成|形象|外观|长成|像一个|是)\s*/i, "");
  return {
    name: bot.name,
    traits: extractTraits(cleanDesc),
    catchphrase: pickCatchphrase(cleanDesc),
    background: cleanDesc ? `按「${cleanDesc}」设定生成的形象。` : undefined,
    interactionStyle: bot.persona ? `互动时保持人设：${bot.persona}` : undefined,
  };
}

function extractTraits(desc: string): string[] {
  const colorMatch = desc.match(/((?:浅|深|淡|亮)?[青红黄绿蓝紫黑白橙灰金银]{1,2}(?:色)?|蓝色|红色|绿色|紫色|金色|银色)/);
  const animalMatch = desc.match(/(狐狸|猫|狗|兔|熊|狼|龙|鸟|鱼|海豚|熊猫|老虎|狮子|马|鸡|鸭|鹅|蛙|鼠)/);
  const traits: string[] = [];
  if (colorMatch) traits.push(`${colorMatch[1]}色系`);
  if (animalMatch) traits.push(`${animalMatch[1]}形态`);
  if (/可爱|萌|软萌/.test(desc)) traits.push("可爱");
  if (/酷|帅气|炫/.test(desc)) traits.push("酷炫");
  if (/智慧|聪明|睿智/.test(desc)) traits.push("智慧");
  if (/神秘|暗黑|暗色/.test(desc)) traits.push("神秘");
  if (traits.length === 0) traits.push("独特", "亲和");
  return traits;
}

function pickCatchphrase(desc: string): string {
  if (/可爱|萌/.test(desc)) return "嘿嘿，需要我帮忙吗？";
  if (/酷|炫/.test(desc)) return "交给我，稳的。";
  if (/智慧/.test(desc)) return "让我想想……好了。";
  return "我在呢，随时可以帮你。";
}

export function inferSkin(desc: string): "default" | "pixel" | "cute" {
  if (/像素|马赛克|复古|游戏/.test(desc)) return "pixel";
  if (/圆润|可爱|软萌|萌|卡通|圆/.test(desc)) return "cute";
  return "default";
}
