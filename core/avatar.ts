import type { Bot } from "./types";

/** 与 app/renderer/avatar-shapes.js 的形状、颜色保持一致（不含固定配色的 orange） */
export const AVATAR_SHAPES = ["circle", "cloud", "square", "sparkle", "clover", "heart", "flower", "egg", "bean", "triangle", "pentagon", "splat", "hexagon"] as const;
export const AVATAR_COLORS = ["#94603a", "#ef4444", "#f26b1d", "#f29a1d", "#3dba6a", "#2fae9b", "#3b82f6", "#8b5cf6", "#ec4899"] as const;

const SHAPES = AVATAR_SHAPES;
const COLORS = AVATAR_COLORS;

function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

/** 按 bot id 固定挑一个形状头像，同一个 bot 每次结果一样 */
export function defaultAvatar(id: string): NonNullable<Bot["avatar"]> {
  const h = hash(id);
  return { shape: SHAPES[h % SHAPES.length], color: COLORS[Math.floor(h / SHAPES.length) % COLORS.length] };
}

/**
 * 按自然语言描述用代码选形状+颜色（产品内置绘制，不是 AI 生图、也不是字母渐变假 PNG）。
 * 桌宠/聊天用同一套 blob SVG 引擎渲染。
 */
export function avatarFromDescription(description: string, seed = ""): NonNullable<Bot["avatar"]> {
  const d = description.trim();
  const h = hash(d + "|" + seed);

  let shape: string =
    /心|爱心|喜欢/.test(d) ? "heart"
    : /花|樱|玫瑰/.test(d) ? "flower"
    : /星|闪|魔法|炫/.test(d) ? "sparkle"
    : /云|软|棉花/.test(d) ? "cloud"
    : /豆|胖|圆滚/.test(d) ? "bean"
    : /球|圆形|圆球|圆圈|圆环|circle|(?:^|[^\u4e00-\u9fff])圆(?:$|[^\u4e00-\u9fff])/.test(d) || /^圆$/.test(d) || /画(?:一)?个圆/.test(d) ? "circle"
    : /蛋|孵/.test(d) ? "egg"
    : /方|盒|积木|像素/.test(d) ? "square"
    : /三角|尖/.test(d) ? "triangle"
    : /六边|蜂巢/.test(d) ? "hexagon"
    : /五边/.test(d) ? "pentagon"
    : /草|四叶|幸运/.test(d) ? "clover"
    : /溅|墨|怪/.test(d) ? "splat"
    : /猫|狗|狐|兔|熊|龙|鸟|鱼|萌|可爱|软萌/.test(d) ? "bean"
    : SHAPES[h % SHAPES.length];

  let color: string =
    /蓝|青|天蓝|海蓝/.test(d) ? "#3b82f6"
    : /绿|翠|森/.test(d) ? "#3dba6a"
    : /红|赤|绯/.test(d) ? "#ef4444"
    : /橙|橘|桔/.test(d) ? "#f26b1d"
    : /黄|金|蜜/.test(d) ? "#f29a1d"
    : /紫|堇|薰衣草/.test(d) ? "#8b5cf6"
    : /粉|玫|樱/.test(d) ? "#ec4899"
    : /青[色绿]|薄荷|翠绿/.test(d) ? "#2fae9b"
    : /棕|咖|褐|茶/.test(d) ? "#94603a"
    : /黑|暗|墨/.test(d) ? "#94603a"
    : COLORS[h % COLORS.length];

  // 形状词未命中时，动物类偏 bean/cloud，避免纯随机
  if (!/(心|花|星|云|豆|蛋|方|三角|六边|五边|草|溅|球|圆)/.test(d) && /猫|狗|狐|兔|熊|龙|鸟|鱼|萌/.test(d)) {
    shape = h % 2 ? "bean" : "cloud";
  }

  return { shape, color };
}

/** 既没有图片头像也没有形状头像的 bot，补一个形状头像 */
export function withDefaultAvatar(bot: Bot): Bot | null {
  if (bot.avatarPath || bot.avatar) return null;
  return { ...bot, avatar: defaultAvatar(bot.id) };
}
