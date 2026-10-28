import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECOMMENDED_PETDEX, fetchPetdexManifest, installPetdex, petdexSkinId, searchPetdex, type PetdexEntry } from "../core/petdex";

const pets: PetdexEntry[] = [
  { slug: "doro-2", displayName: "Doro", spritesheetUrl: "https://a/doro.webp", petJsonUrl: "https://a/doro.json", spriteVersionNumber: 1 },
  { slug: "guga-2", displayName: "咕嘎", spritesheetUrl: "https://a/guga.webp", petJsonUrl: "https://a/guga.json", spriteVersionNumber: 2 },
];
const fakeFetch = (async (url: string) => {
  if (String(url).endsWith("/api/manifest")) return new Response(JSON.stringify({ pets }));
  return new Response(new Uint8Array([1, 2, 3]));
}) as unknown as typeof fetch;

describe("petdex 形象库", () => {
  test("搜索按 slug / 中文名匹配", () => {
    expect(searchPetdex(pets, "doro").map((p) => p.slug)).toEqual(["doro-2"]);
    expect(searchPetdex(pets, "咕嘎").map((p) => p.slug)).toEqual(["guga-2"]);
    // 推荐别名：displayName 是 Doro，搜「玫瑰」仍能命中
    expect(searchPetdex(pets, "玫瑰").map((p) => p.slug)).toContain("doro-2");
  });

  test("manifest 落盘缓存", async () => {
    const dir = mkdtempSync(join(tmpdir(), "petdex-"));
    expect((await fetchPetdexManifest(dir, fakeFetch)).length).toBe(2);
    expect(existsSync(join(dir, "petdex-manifest.json"))).toBe(true);
    const failing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect((await fetchPetdexManifest(dir, failing)).length).toBe(2);
  });

  test("安装：V2 精灵图 11 行，文件落到 skins/pd-<slug>", async () => {
    const dir = mkdtempSync(join(tmpdir(), "petdex-"));
    const skin = await installPetdex(pets[1], dir, "咕嘎", fakeFetch);
    expect(skin.id).toBe(petdexSkinId("guga-2"));
    expect(skin.sprite?.rows).toBe(11);
    expect(skin.sprite?.cols).toBe(8);
    expect(existsSync(skin.sprite!.path)).toBe(true);
    const v1 = await installPetdex(pets[0], dir, undefined, fakeFetch);
    expect(v1.sprite?.rows).toBe(9);
  });

  test("推荐列表覆盖 Doro / 咕嘎 / 短视频", () => {
    const groups = new Set(RECOMMENDED_PETDEX.map((r) => r.group));
    for (const g of ["Doro", "咕嘎", "短视频"]) expect(groups.has(g)).toBe(true);
  });
});
