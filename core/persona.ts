import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Bot, PersonaCard } from "./types";
import type { Store } from "./store";

export interface ImageGenResult {
  path?: string;      // 本地图片文件路径（成功时）
  dataUrl?: string;   // 降级时的 dataURL（或成功时的 dataURL）
  degraded: boolean;
}

export interface ImageGenProvider {
  generate(prompt: string, destPath: string): Promise<ImageGenResult>;
}

/**
 * 一句话生成形象：并产生头像图 + 角色卡。
 * ImageGenProvider 可注入（OpenAI 兼容图像 API 等）；未注入时降级为程序化占位头像。
 */
export class PersonaGenerator {
  constructor(
    private store: Store,
    private assetsDir: string,
    private imageGen?: ImageGenProvider,
  ) {}

  async generate(bot: Bot, description: string): Promise<{ avatarPath?: string; card: PersonaCard }> {
    const avatarPath = join(this.assetsDir, `${bot.id}.png`);
    const card = buildCard(bot, description);

    let avatarPathOut: string | undefined;
    if (this.imageGen) {
      try {
        const r = await this.imageGen.generate(description, avatarPath);
        avatarPathOut = r.path || r.dataUrl;
      } catch {
        avatarPathOut = fallbackAvatar(bot, description, avatarPath);
      }
    } else {
      avatarPathOut = fallbackAvatar(bot, description, avatarPath);
    }

    const next = { ...bot, avatarPath: avatarPathOut, personaCard: card };
    this.store.saveBot(next);
    return { avatarPath: avatarPathOut, card };
  }

  /** 角色卡文本（给 LLM 或 UI 展示） */
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

/**
 * 程序化占位头像：纯色背景 + 首字 + emoji。
 * 保证即使无网络/无图像 API，桌面宠物也有可见形象。
 */
export function fallbackAvatar(bot: Bot, desc: string, destPath: string): string {
  mkdirSync(join(destPath, ".."), { recursive: true });
  const color = pickColor(desc + bot.id);
  const char = (bot.name || "B").slice(0, 1).toUpperCase();
  const emoji = pickEmoji(desc);
  const size = 256;
  // SVG → PNG 需转换依赖；这里直接产出 SVG 文件（Electron 直接可显示），线程兼容。
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${color[0]}"/><stop offset="1" stop-color="${color[1]}"/>
  </linearGradient></defs>
  <rect width="${size}" height="${size}" rx="64" fill="url(#g)"/>
  <text x="50%" y="58%" font-size="96" text-anchor="middle" dominant-baseline="central">${emoji}</text>
  <text x="50%" y="86%" font-size="28" text-anchor="middle" fill="#ffffff" opacity="0.92" font-family="sans-serif">${char}</text>
</svg>`;
  writeFileSync(destPath, svg, "utf8");
  return destPath;
}

function pickColor(seed: string): [string, string] {
  const palettes: [string, string][] = [
    ["#4F46E5", "#9333EA"], ["#0EA5E9", "#22C55E"], ["#F59E0B", "#EF4444"],
    ["#14B8A6", "#3B82F6"], ["#EC4899", "#8B5CF6"], ["#F97316", "#EAB308"],
  ];
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palettes[h % palettes.length];
}

function pickEmoji(desc: string): string {
  const map: [RegExp, string][] = [
    [/狐/, "🦊"], [/猫/, "🐱"], [/狗/, "🐶"], [/兔/, "🐰"], [/熊/, "🐻"], [/狼/, "🐺"],
    [/龙/, "🐲"], [/鸟/, "🐦"], [/鱼/, "🐟"], [/熊猫/, "🐼"], [/老虎/, "🐯"], [/海豚/, "🐬"],
    [/可爱|萌/, "😊"], [/酷|炫/, "😎"], [/智慧/, "🧠"], [/神秘/, "🌙"],
  ];
  for (const [re, e] of map) if (re.test(desc)) return e;
  return "🤖";
}
