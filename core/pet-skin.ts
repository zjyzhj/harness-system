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
  /** Live2D Cubism 3/4/5 模型（model3.json 路径，相对 pet.html 或绝对 file 路径） */
  live2d?: { model: string; scale?: number };
  /** 用 bot.avatar 形状色块当桌宠（代码绘制，非 PNG 文件） */
  shape?: boolean;
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

/** 内置兜底帧（Live2D 加载失败时 sprite 区显示；不再作为可选「简易形象」暴露） */
export const DEFAULT_SKIN: PetSkin = {
  id: "default",
  name: "默认",
  frames: EMOJI_FALLBACK,
  fps: 2,
  color: "#4F46E5",
  desc: "内部兜底，不出现在形象菜单",
};

/** 内置 Live2D 角色（Live2D 官方示例模型，Free Material License） */
export const LIVE2D_SKINS: PetSkin[] = [
  { id: "live2d-hiyori", name: "日和 Hiyori", color: "#F9A8D4", desc: "Live2D 少女：9 组待机动作随机切换", fps: 2, frames: EMOJI_FALLBACK, live2d: { model: "live2d/Hiyori/Hiyori.model3.json" } },
  { id: "live2d-haru", name: "春 Haru", color: "#93C5FD", desc: "Live2D 少女：8 种表情 + 触摸动作", fps: 2, frames: EMOJI_FALLBACK, live2d: { model: "live2d/Haru/Haru.model3.json" } },
  { id: "live2d-mao", name: "真央 Mao", color: "#C4B5FD", desc: "Live2D 魔法少女：8 种表情 + 6 组触摸动作", fps: 2, frames: EMOJI_FALLBACK, live2d: { model: "live2d/Mao/Mao.model3.json" } },
];
export const DEFAULT_PET_SKIN_ID = "live2d-hiyori";

/** 代码绘制的形状桌宠：渲染走 bot.avatar 的 blob SVG，不是假 PNG */
export const SHAPE_SKIN: PetSkin = {
  id: "shape-blob",
  name: "形状色块",
  frames: EMOJI_FALLBACK,
  fps: 2,
  color: "#3b82f6",
  desc: "按描述用代码画的形状头像（眼睛会眨眼/忙碌时晃动）",
  shape: true,
};
export const SHAPE_SKIN_ID = SHAPE_SKIN.id;

export class PetSkinRegistry {
  private skins = new Map<string, PetSkin>();
  /** G5.5：社区皮肤索引文件（assets/skins/index.json） */
  private indexFile?: string;

  constructor(assetsDir?: string) {
    for (const l of LIVE2D_SKINS) this.skins.set(l.id, l);
    this.skins.set(SHAPE_SKIN.id, SHAPE_SKIN);
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
    // Live2D / sprite / 代码形状；内部 emoji default 兜底不出现在菜单
    return [...this.skins.values()].filter((s) => s.live2d || s.sprite || s.shape);
  }
  get(id?: string): PetSkin {
    if (id && this.skins.get(id)) return this.skins.get(id)!;
    return this.skins.get(DEFAULT_PET_SKIN_ID) || DEFAULT_SKIN;
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
