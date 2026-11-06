/**
 * 每个 bot 的系统监听名单：用户手动勾选要盯的 App。
 * 存在 config.json → prefs.systemWatch[botId]
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { detectBrand, lookupAppBundle, resolveAppIdentity, type AppIdentity } from "./app-identity";

export interface BotSystemWatch {
  /** 总开关：关则 bot 不主动盯名单（工具仍可临时传 apps） */
  enabled: boolean;
  /** 要盯的显示名 / bundle 名（如 Cursor、Codex） */
  apps: string[];
}

export const DEFAULT_BOT_WATCH: BotSystemWatch = {
  enabled: true,
  apps: [],
};

export function normalizeBotWatch(raw: unknown): BotSystemWatch {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<BotSystemWatch>;
  const apps = Array.isArray(r.apps)
    ? [...new Set(r.apps.map((x) => String(x ?? "").trim()).filter(Boolean))].slice(0, 40)
    : [];
  return {
    enabled: r.enabled !== false,
    apps,
  };
}

export function readBotWatch(cfg: Record<string, unknown>, botId: string): BotSystemWatch {
  const prefs = (cfg.prefs && typeof cfg.prefs === "object" ? cfg.prefs : {}) as Record<string, unknown>;
  const all = (prefs.systemWatch && typeof prefs.systemWatch === "object" ? prefs.systemWatch : {}) as Record<string, unknown>;
  return normalizeBotWatch(all[botId]);
}

export function writeBotWatch(
  prefs: Record<string, unknown>,
  botId: string,
  patch: Partial<BotSystemWatch>,
): Record<string, unknown> {
  const prevAll = (prefs.systemWatch && typeof prefs.systemWatch === "object" ? prefs.systemWatch : {}) as Record<string, unknown>;
  const cur = normalizeBotWatch(prevAll[botId]);
  const next = normalizeBotWatch({
    enabled: patch.enabled !== undefined ? patch.enabled : cur.enabled,
    apps: patch.apps !== undefined ? patch.apps : cur.apps,
  });
  return { ...prefs, systemWatch: { ...prevAll, [botId]: next } };
}

export interface InstalledAppRow {
  name: string;
  path: string;
  brand: string;
  mark: string;
  identity: AppIdentity;
}

/** 扫本机 Applications，给选 App 面板用 */
export function listInstalledApps(limit = 80): InstalledAppRow[] {
  const roots = ["/Applications", "/System/Applications", join(homedir(), "Applications")];
  const rows: InstalledAppRow[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let ents: string[] = [];
    try {
      ents = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of ents) {
      if (!name.endsWith(".app")) continue;
      const full = join(root, name);
      const label = name.replace(/\.app$/i, "");
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const identity = resolveAppIdentity({ command: label, rawCommand: full, displayHint: label });
      rows.push({
        name: label,
        path: full,
        brand: identity.brand,
        mark: identity.mark,
        identity: { ...identity, bundlePath: full, iconPath: full },
      });
      if (rows.length >= limit) return rows.sort((a, b) => a.name.localeCompare(b.name, "zh"));
    }
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

/** 把用户勾选的名字解析成观察用的关键字 */
export function watchKeywords(watch: BotSystemWatch): string[] {
  if (!watch.enabled || !watch.apps.length) return [];
  return watch.apps.flatMap((name) => {
    const brand = detectBrand(name);
    const keys = [name];
    if (brand !== "unknown") keys.push(brand);
    const bundle = lookupAppBundle(name);
    if (bundle) keys.push(basename(bundle).replace(/\.app$/i, ""));
    return keys;
  });
}
