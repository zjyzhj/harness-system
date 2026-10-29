import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonSafe, writeJsonAtomic } from "../atomic-fs";
import type { Presence, PresenceVoice } from "./types";

/**
 * 灵境持久化：~/.harness-bot/realm/
 * - presences.json
 * - <id>/voice/ref.*  参考音
 * - <id>/audio/*.mp3  合成音
 */
export class RealmStore {
  readonly root: string;
  private file: string;
  private items: Record<string, Presence> = {};

  constructor(home: string) {
    this.root = join(home, "realm");
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true });
    this.file = join(this.root, "presences.json");
    this.items = readJsonSafe(this.file, {});
  }

  private persist() {
    writeJsonAtomic(this.file, this.items, { mode: 0o600 });
  }

  dirOf(id: string): string {
    const d = join(this.root, id);
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    return d;
  }

  voiceDir(id: string): string {
    const d = join(this.dirOf(id), "voice");
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    return d;
  }

  audioDir(id: string): string {
    const d = join(this.dirOf(id), "audio");
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    return d;
  }

  list(includeArchived = false): Presence[] {
    return Object.values(this.items)
      .filter((p) => includeArchived || !p.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Presence | undefined {
    return this.items[id];
  }

  save(p: Presence): Presence {
    this.items[p.id] = p;
    this.persist();
    return p;
  }

  update(id: string, patch: Partial<Omit<Presence, "id" | "createdAt" | "consent">> & { consent?: Presence["consent"]; voice?: Partial<PresenceVoice> }): Presence {
    const cur = this.items[id];
    if (!cur) throw new Error(`找不到灵境 Presence：${id}`);
    const next: Presence = {
      ...cur,
      ...patch,
      voice: patch.voice ? { ...cur.voice, ...patch.voice } : cur.voice,
      consent: patch.consent ?? cur.consent,
      updatedAt: Date.now(),
    };
    return this.save(next);
  }

  archive(id: string): Presence {
    return this.update(id, { archived: true });
  }

  /** 删除元数据与本地素材目录 */
  remove(id: string) {
    delete this.items[id];
    this.persist();
    const d = join(this.root, id);
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }

  /** 写入参考音频，返回绝对路径 */
  saveRefAudio(id: string, buf: Buffer, ext: string): string {
    const dir = this.voiceDir(id);
    for (const f of readdirSync(dir)) {
      if (f.startsWith("ref.")) rmSync(join(dir, f), { force: true });
    }
    const safe = ext.replace(/^\./, "").replace(/[^a-z0-9]/gi, "") || "webm";
    const path = join(dir, `ref.${safe}`);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, buf);
    renameSync(tmp, path);
    return path;
  }

  /** 写入合成音频，返回绝对路径 */
  saveSpeechAudio(id: string, buf: Buffer, ext = "mp3"): string {
    const path = join(this.audioDir(id), `${Date.now().toString(36)}.${ext}`);
    writeFileSync(path, buf);
    return path;
  }
}
