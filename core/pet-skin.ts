/**
 * G3 宠物皮肤系统。
 * - PetSkinRegistry：皮肤注册/查找/默认皮肤
 * - 每 skin 含多动作帧（idle/walk/jump/sleep/celebrate/work/think），帧为 dataUrl 或 emoji 短码
 * - 无图时用 emoji 帧兜底（零依赖）
 * 对齐 Grok Bot 宠物形态：状态 → 帧轮播。
 */

export type PetAction = "idle" | "walk" | "jump" | "sleep" | "celebrate" | "work" | "think";

export interface PetSkin {
  id: string;
  name: string;
  frames: Record<PetAction, string[]>;
  fps: number;
}

const EMOJI_DEFAULT: Record<PetAction, string[]> = {
  idle: ["🙂", "😊", "🙂"],
  walk: ["🚶", "🏃"],
  jump: ["🤸", "🦘"],
  sleep: ["😴", "💤"],
  celebrate: ["🎉", "🥳", "🎉"],
  work: ["🤔", "🧠", "📝"],
  think: ["💭", "🤔", "💭"],
};

const STYLE_EMOJI: Record<string, Partial<Record<PetAction, string[]>>> = {
  pixel: {
    idle: ["🐾", "🐾", "🐾"],
    walk: ["🐾", "🐾"],
    jump: ["🐾", "🐾"],
  },
  cute: {
    idle: ["🐰", "🐻", "🐰"],
    sleep: ["😪", "💤"],
    celebrate: ["🌈", "⭐", "🌈"],
  },
};

/** 默认皮肤（emoji 帧，无需图片） */
export const DEFAULT_SKIN: PetSkin = {
  id: "default",
  name: "默认",
  frames: EMOJI_DEFAULT,
  fps: 2,
};

export class PetSkinRegistry {
  private skins = new Map<string, PetSkin>([["default", DEFAULT_SKIN]]);

  constructor() {
    for (const [style, partial] of Object.entries(STYLE_EMOJI)) {
      this.skins.set(style, {
        id: style,
        name: style === "pixel" ? "像素" : style === "cute" ? "圆润" : style,
        frames: { ...EMOJI_DEFAULT, ...partial } as Record<PetAction, string[]>,
        fps: style === "pixel" ? 4 : 2,
      });
    }
  }

  list(): PetSkin[] {
    return [...this.skins.values()];
  }
  get(id?: string): PetSkin {
    return (id && this.skins.get(id)) || DEFAULT_SKIN;
  }
  /** 注册新皮肤（例如形象生成后写入皮肤帧） */
  register(skin: PetSkin) {
    this.skins.set(skin.id, skin);
  }
  /** 取某动作当前帧（frameIndex 轮播） */
  frame(skinId: string | undefined, action: PetAction, frameIndex: number): string {
    const skin = this.get(skinId);
    const frames = skin.frames[action] ?? skin.frames.idle;
    if (!frames.length) return "🙂";
    return frames[frameIndex % frames.length];
  }
  /** 动作帧数（循环周期） */
  frameCount(skinId: string | undefined, action: PetAction): number {
    const skin = this.get(skinId);
    const frames = skin.frames[action] ?? skin.frames.idle;
    return Math.max(1, frames.length);
  }
}

export const petSkins = new PetSkinRegistry();
