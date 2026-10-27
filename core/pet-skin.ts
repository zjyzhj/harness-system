/**
 * G3 宠物皮肤系统。
 * - PetSkinRegistry：皮肤注册/查找/默认皮肤
 * - 每 skin 含多动作帧（idle/walk/jump/sleep/celebrate/work/think），帧为 dataUrl 或 emoji 短码
 * - 无图时用 emoji 帧兜底（零依赖）
 * - G5.5：社区 spritesheet 皮肤可持久化（assets/skins/index.json），重启后恢复
 * 对齐 Grok Bot 宠物形态：状态 → 帧轮播。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type PetAction = "idle" | "walk" | "jump" | "sleep" | "celebrate" | "work" | "think";

export interface PetSkin {
  id: string;
  name: string;
  frames: Record<PetAction, string[]>;
  fps: number;
  /** G5.5：品牌主色（宠物头像描边/徽章主题色） */
  color?: string;
  /** G5.5：一句话描述（菜单展示） */
  desc?: string;
  /** G5.5：spritesheet 皮肤（来自 openpets/petdex 生态） */
  sprite?: { url: string; path: string; rows: number; cols: number; cellW?: number; cellH?: number };
}

export const EMOJI_FALLBACK: Record<PetAction, string[]> = {
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
  frames: EMOJI_FALLBACK,
  fps: 2,
  color: "#4F46E5",
  desc: "通用 emoji 伙伴",
};

/** G5.5：品牌/主题预设皮肤（对齐主流 AI 品牌与社区形象，离线 emoji 帧） */
const BRAND_SKINS: PetSkin[] = [
  {
    id: "deepseek",
    name: "DeepSeek 鲸",
    color: "#4D6BFE",
    desc: "DeepSeek 蓝白鲸鱼风",
    fps: 2,
    frames: {
      idle: ["🐳", "🐋", "🐳"],
      walk: ["🐳", "🐋"],
      jump: ["🐳", "💦", "🐳"],
      sleep: ["😴", "💤"],
      celebrate: ["🎉", "🐳", "🎉"],
      work: ["🧠", "📊", "🧠"],
      think: ["💭", "🐳", "💭"],
    },
  },
  {
    id: "claude",
    name: "Claude 橙块",
    color: "#D97757",
    desc: "Claude/Clawd 橙色调方块小人",
    fps: 2,
    frames: {
      idle: ["🟧", "🙂", "🟧"],
      walk: ["🟧", "🟨"],
      jump: ["🟧", "⭐"],
      sleep: ["😴", "🟧"],
      celebrate: ["🟧", "🎉", "🟧"],
      work: ["🟧", "🤖", "🟧"],
      think: ["💭", "🟧", "💭"],
    },
  },
  {
    id: "doro",
    name: "Doro 团子",
    color: "#FF9EC7",
    desc: "Codex 桌宠 Doro：粉发白团子",
    fps: 2,
    frames: {
      idle: ["🍡", "🌸", "🍡"],
      walk: ["🍡", "🍡"],
      jump: ["🍡", "🌸"],
      sleep: ["😴", "💤"],
      celebrate: ["🎀", "🍡", "🎀"],
      work: ["💻", "🍡", "💻"],
      think: ["💭", "🍡", "💭"],
    },
  },
  {
    id: "guga",
    name: "咕嘎",
    color: "#22C55E",
    desc: "咕嘎：绿色小怪兽",
    fps: 2,
    frames: {
      idle: ["👾", "🐸", "👾"],
      walk: ["👾", "👾"],
      jump: ["👾", "💚"],
      sleep: ["😴", "💤"],
      celebrate: ["🎉", "👾", "🎉"],
      work: ["🛠", "👾", "🛠"],
      think: ["💭", "👾", "💭"],
    },
  },
  {
    id: "grok",
    name: "Grok 星",
    color: "#111111",
    desc: "xAI Grok：黑金星空风",
    fps: 2,
    frames: {
      idle: ["🌌", "🤖", "🌌"],
      walk: ["🌌", "⭐"],
      jump: ["🤖", "✨"],
      sleep: ["😴", "💤"],
      celebrate: ["🎉", "✨", "🎉"],
      work: ["🧠", "🔮", "🧠"],
      think: ["💭", "🤖", "💭"],
    },
  },
];

export class PetSkinRegistry {
  private skins = new Map<string, PetSkin>([["default", DEFAULT_SKIN]]);
  /** G5.5：社区皮肤索引文件（assets/skins/index.json） */
  private indexFile?: string;

  constructor(assetsDir?: string) {
    for (const [style, partial] of Object.entries(STYLE_EMOJI)) {
      this.skins.set(style, {
        id: style,
        name: style === "pixel" ? "像素" : style === "cute" ? "圆润" : style,
        frames: { ...EMOJI_FALLBACK, ...partial } as Record<PetAction, string[]>,
        fps: style === "pixel" ? 4 : 2,
      });
    }
    // 注册品牌预设
    for (const b of BRAND_SKINS) this.skins.set(b.id, b);
    // 恢复持久化的社区皮肤（下载后立即落盘，重启不丢失）
    if (assetsDir) {
      this.indexFile = join(assetsDir, "skins", "index.json");
      try {
        if (existsSync(this.indexFile)) {
          const saved = JSON.parse(readFileSync(this.indexFile, "utf8")) as PetSkin[];
          for (const sk of saved) {
            if (sk.sprite?.path) this.skins.set(sk.id, sk);
          }
        }
      } catch { /* 索引损坏时忽略，仅保留内置皮肤 */ }
    }
  }

  list(): PetSkin[] {
    return [...this.skins.values()];
  }
  get(id?: string): PetSkin {
    return (id && this.skins.get(id)) || DEFAULT_SKIN;
  }
  /** 注册新皮肤（例如形象生成后写入皮肤帧）；持久化社区皮肤 */
  register(skin: PetSkin) {
    this.skins.set(skin.id, skin);
    if (this.indexFile) this.persist();
  }
  /** G5.5：社区皮肤索引落盘（仅 sprite 皮肤需要重启后恢复） */
  persist() {
    if (!this.indexFile) return;
    const community = [...this.skins.values()].filter((x) => x.sprite?.path);
    try {
      mkdirSync(dirname(this.indexFile), { recursive: true });
      writeFileSync(this.indexFile, JSON.stringify(community, null, 2), "utf8");
    } catch { /* 落盘失败不影响内存注册 */ }
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

/**
 * G5.5：spritesheet 皮肤（openpets/petdex 生态格式）
 * - 统一 9 行（状态）× 8 列（帧）规格，按透明 gutter 自动切帧
 * - 帧通过 background-position 播放（dataUrl 大图避免多次传输）
 */
export interface SpriteSheetMeta {
  url: string;
  rows: number;   // 状态数（典型 9）
  cols: number;   // 每状态帧数（典型 8）
  cellW: number;
  cellH: number;
  dataUrl?: string;   // 下载后缓存
}

/** 估算 spritesheet 每格尺寸：默认 128px 网格（1536x1872/12 列？实际按检测） */
export function estimateSpriteGrid(w: number, h: number, rows = 9, cols = 8): { cellW: number; cellH: number } {
  return { cellW: Math.floor(w / cols), cellH: Math.floor(h / rows) };
}
