/**
 * petdex 社区形象库（https://petdex.dev，5000+ Codex 格式宠物）。
 * - catalog：拉取公开 manifest（磁盘缓存 24h），按名字/slug 搜索
 * - install：下载 spritesheet + pet.json 到 assets/skins/pd-<slug>/，返回可注册的 PetSkin
 * V1 atlas 9 行；V2 多 2 行 16 向注视（11 行），列数恒为 8。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EMOJI_FALLBACK, type PetSkin } from "./pet-skin";

export const PETDEX_URL = "https://petdex.dev";
const MANIFEST_TTL_MS = 24 * 3600_000;

export interface PetdexEntry {
  slug: string;
  displayName: string;
  kind?: string;
  spritesheetUrl: string;
  petJsonUrl: string;
  spriteVersionNumber?: number;
}

/** 推荐形象：Doro / 咕嘎 / 抖音系 / AI 娘化（slug 均来自 petdex manifest） */
export const RECOMMENDED_PETDEX: { slug: string; name: string; group: string }[] = [
  { slug: "doro-2", name: "Doro 玫瑰发带", group: "Doro" },
  { slug: "doro-3", name: "Doro 小黄帽", group: "Doro" },
  { slug: "doro-6", name: "Doro 站立版", group: "Doro" },
  { slug: "doro-5", name: "Doro 卫衣", group: "Doro" },
  { slug: "guga-2", name: "咕嘎", group: "咕嘎" },
  { slug: "gugugaga-3", name: "咕咕嘎嘎", group: "咕嘎" },
  { slug: "guga-guga", name: "咕嘎咕嘎", group: "咕嘎" },
  { slug: "strawberry-duo", name: "Doro 和咕咕嘎嘎", group: "咕嘎" },
  { slug: "xiaodouling", name: "小抖灵（抖音直播）", group: "短视频" },
  { slug: "douyin-labubu", name: "豆乳嘟嘟", group: "短视频" },
  { slug: "deepseek-2", name: "蓝色大肥鱼", group: "DeepSeek 大肥鱼" },
  { slug: "blue-whale-girl", name: "大肥鱼·鲸鱼帽", group: "DeepSeek 大肥鱼" },
  { slug: "deepseek-goldwhale-v1", name: "大肥鱼·绣金鲸", group: "DeepSeek 大肥鱼" },
  { slug: "deepseek-drool", name: "流口水 DeepSeek 酱", group: "DeepSeek 大肥鱼" },
  { slug: "deepseek", name: "DeepSeek 酱", group: "DeepSeek 大肥鱼" },
  { slug: "claude-opus-scholar", name: "Claude 酱", group: "Claude" },
  { slug: "clawd-2", name: "Clawd 小螃蟹", group: "Claude" },
  { slug: "clawd-music", name: "Clawd 耳机版", group: "Claude" },
  { slug: "lunaria", name: "ChatGPT 娘", group: "AI 娘化" },
  { slug: "gemini", name: "Gemini", group: "AI 娘化" },
  { slug: "glm", name: "GLM 娘", group: "AI 娘化" },
  { slug: "psychegrok", name: "Grok 娘", group: "AI 娘化" },
  { slug: "qianwen", name: "千问", group: "AI 娘化" },
  { slug: "doubao-7", name: "豆包", group: "AI 娘化" },
  { slug: "cursor-crow", name: "Cursor 猫头鹰", group: "AI 吉祥物" },
  { slug: "froge-openai-mascot", name: "OpenAI 青蛙 Froge", group: "AI 吉祥物" },
  { slug: "codex", name: "Codex", group: "AI 吉祥物" },
  { slug: "nailong-6", name: "奶龙", group: "奶龙" },
  { slug: "nai-long", name: "奶龙 像素版", group: "奶龙" },
  { slug: "moyu-nailong", name: "摸鱼奶龙", group: "奶龙" },
  { slug: "nailong-boat", name: "奶龙划船", group: "奶龙" },
  { slug: "nailong-4", name: "兔帽奶龙", group: "奶龙" },
  { slug: "banana-grin", name: "大笑奶龙", group: "奶龙" },
  { slug: "anon-nailong", name: "奶龙装少女", group: "奶龙" },
];

export function petdexSkinId(slug: string) {
  return `pd-${slug}`;
}

export async function fetchPetdexManifest(cacheDir: string, fetcher: typeof fetch = fetch): Promise<PetdexEntry[]> {
  const file = join(cacheDir, "petdex-manifest.json");
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < MANIFEST_TTL_MS) {
    try { return JSON.parse(readFileSync(file, "utf8")).pets; } catch { /* 缓存损坏则重新拉取 */ }
  }
  const res = await fetcher(`${PETDEX_URL}/api/manifest`, { headers: { Referer: `${PETDEX_URL}/` } });
  if (!res.ok) throw new Error(`petdex manifest HTTP ${res.status}`);
  const data = (await res.json()) as { pets: PetdexEntry[] };
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(file, JSON.stringify(data), "utf8");
  return data.pets;
}

export function searchPetdex(pets: PetdexEntry[], query: string, limit = 60): PetdexEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return pets.slice(0, limit);
  // 推荐列表的中文别名也参与匹配（petdex 原名常是英文，用户会搜「卫衣」「奶龙」）
  const alias = new Map<string, string>();
  for (const r of RECOMMENDED_PETDEX) alias.set(r.slug, `${r.name} ${r.group}`.toLowerCase());
  const scored = pets
    .map((p) => {
      const slug = p.slug.toLowerCase();
      const name = p.displayName.toLowerCase();
      const extra = alias.get(p.slug) || "";
      let score = 0;
      if (slug === q || name === q) score = 100;
      else if (slug.startsWith(q) || name.startsWith(q)) score = 80;
      else if (slug.includes(q) || name.includes(q) || extra.includes(q)) score = 50;
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.p.displayName.localeCompare(b.p.displayName));
  return scored.slice(0, limit).map((x) => x.p);
}

export async function installPetdex(entry: PetdexEntry, assetsDir: string, displayName?: string, fetcher: typeof fetch = fetch): Promise<PetSkin> {
  const id = petdexSkinId(entry.slug);
  const dir = join(assetsDir, "skins", id);
  mkdirSync(dir, { recursive: true });
  const get = async (url: string) => {
    const r = await fetcher(url, { headers: { Referer: `${PETDEX_URL}/` } });
    if (!r.ok) throw new Error(`下载失败 ${url} → HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  };
  const ext = entry.spritesheetUrl.endsWith(".png") ? "png" : "webp";
  const [sheet, petJson] = await Promise.all([get(entry.spritesheetUrl), get(entry.petJsonUrl).catch(() => null)]);
  const path = join(dir, `spritesheet.${ext}`);
  writeFileSync(path, sheet);
  if (petJson) writeFileSync(join(dir, "pet.json"), petJson);
  const rows = entry.spriteVersionNumber === 2 ? 11 : 9;
  return {
    id,
    name: displayName || entry.displayName,
    color: "#F472B6",
    desc: `petdex 社区形象 ${entry.slug}`,
    fps: 8,
    frames: EMOJI_FALLBACK,
    sprite: { url: entry.spritesheetUrl, path, rows, cols: 8 },
  };
}
