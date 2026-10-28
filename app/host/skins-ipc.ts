/* 宠物形象：本地皮肤列表、openpets / petdex 社区皮肤下载安装 */
import { ipcMain } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EMOJI_FALLBACK, type PetSkinRegistry } from "../../core/pet-skin";
import { RECOMMENDED_PETDEX, fetchPetdexManifest, installPetdex, petdexSkinId, searchPetdex } from "../../core/petdex";

export function registerSkinsIpc(deps: { petSkins: PetSkinRegistry; assetsDir: string }) {
  const { petSkins, assetsDir } = deps;
  ipcMain.handle("skins:list", () => petSkins.list().map((s) => ({ id: s.id, name: s.name, color: s.color, desc: s.desc, fps: s.fps, sprite: s.sprite, live2d: s.live2d, shape: s.shape })));
  // G5.5：下载 openpets/petdex spritesheet 皮肤 → 存本地 assets/skins/<id>/
  ipcMain.handle("skins:download", async (_e, input: { id: string; name: string; url: string; rows?: number; cols?: number }) => {
    const dir = join(assetsDir, "skins", input.id);
    mkdirSync(dir, { recursive: true });
    const res = await fetch(input.url);
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const path = join(dir, "spritesheet.webp");
    writeFileSync(path, buf);
    const rows = input.rows ?? 9, cols = input.cols ?? 8;
    const dataUrl = `data:image/webp;base64,${buf.toString("base64")}`;
    // 注册为 sprite 皮肤（emoji 帧兜底 + sprite 播放）
    petSkins.register({
      id: input.id,
      name: input.name,
      color: "#888",
      desc: `openpets 社区皮肤（${rows}×${cols} 帧）`,
      fps: 8,
      sprite: { url: input.url, path, rows, cols },
      frames: EMOJI_FALLBACK,
    });
    return { ok: true, path, sprite: { path, rows, cols }, dataUrl: dataUrl.slice(0, 50) + "…" };
  });
  // petdex 社区形象库：推荐列表 / 搜索 / 一键安装（带 spritesheet 缩略图 URL）
  ipcMain.handle("skins:recommended", async () => {
    let bySlug = new Map<string, string>();
    try {
      const pets = await fetchPetdexManifest(join(assetsDir, "skins"));
      bySlug = new Map(pets.map((p) => [p.slug, p.spritesheetUrl]));
    } catch { /* 离线时推荐仍可点，只是没有缩略图 */ }
    return RECOMMENDED_PETDEX.map((r) => ({
      ...r,
      id: petdexSkinId(r.slug),
      installed: !!petSkins.list().find((s) => s.id === petdexSkinId(r.slug)),
      thumb: bySlug.get(r.slug) || null,
    }));
  });
  ipcMain.handle("skins:catalog", async (_e, query: string) => {
    const q = (query ?? "").trim();
    if (!q) return [];
    const pets = await fetchPetdexManifest(join(assetsDir, "skins"));
    return searchPetdex(pets, q).map((p) => ({
      slug: p.slug, displayName: p.displayName, kind: p.kind,
      id: petdexSkinId(p.slug), thumb: p.spritesheetUrl,
    }));
  });
  ipcMain.handle("skins:installPetdex", async (_e, slug: string, name?: string) => {
    const pets = await fetchPetdexManifest(join(assetsDir, "skins"));
    const entry = pets.find((p) => p.slug === slug);
    if (!entry) throw new Error(`petdex 上找不到 ${slug}`);
    const skin = await installPetdex(entry, assetsDir, name);
    petSkins.register(skin);
    return { id: skin.id, name: skin.name };
  });
  // G5.5：回写 spritesheet 每格尺寸（pet 窗口 Image 探测后持久化，重启直接播放）
  ipcMain.handle("skins:setMeta", (_e, id: string, meta: { cellW: number; cellH: number; rows?: number }) => {
    const sk = petSkins.get(id);
    if (!sk?.sprite?.path) throw new Error("皮肤不存在或非 sprite 皮肤");
    petSkins.register({ ...sk, sprite: { ...sk.sprite, cellW: meta.cellW, cellH: meta.cellH, rows: meta.rows ?? sk.sprite.rows } });
    return { ok: true };
  });
}
