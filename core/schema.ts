import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 本机数据目录结构版本（与迁移格式 harness-bot-migration/v2 独立） */
export const SCHEMA_VERSION = 3;

export type SchemaFile = {
  version: number;
  updatedAt: string;
};

/** 启动时确保 ~/.harness-bot/schema.json 存在；低版本时只抬版本号（结构迁移按需另做） */
export function ensureSchema(home: string): { from: number; to: number; created: boolean } {
  mkdirSync(home, { recursive: true });
  const path = join(home, "schema.json");
  let from = 0;
  let created = false;
  if (existsSync(path)) {
    try {
      const cur = JSON.parse(readFileSync(path, "utf8")) as SchemaFile;
      from = Number(cur.version) || 0;
    } catch {
      from = 0;
    }
  } else {
    created = true;
  }
  const to = SCHEMA_VERSION;
  if (from !== to || created) {
    const next: SchemaFile = { version: to, updatedAt: new Date().toISOString() };
    writeFileSync(path, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  }
  return { from: from || to, to, created };
}
