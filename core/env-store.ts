import { join } from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./atomic-fs";

export interface EnvEntry {
  key: string;
  value: string;
  /** 给人看的名称，如「飞书 App ID」 */
  label?: string;
  /** 用途说明：哪个功能 / 哪个服务用 */
  note?: string;
  /** 归属 bot；不填 = 所有 bot 共用 */
  botId?: string;
  updatedAt: number;
  /** 谁写的（bot id 或 user） */
  updatedBy?: string;
}

/** 看起来是密码 / Token 的 key 或值：不能明文存，要走 ui.secret 加密 */
export function looksSecret(key: string, value: string): boolean {
  if (/(secret|token|password|passwd|pwd|private|credential|api_?key|access_?key|cookie|session)/i.test(key)) return true;
  return /^(sk|pk|rk|ghp|gho|github_pat|xox[abp]|AKIA|eyJ)[-_A-Za-z0-9]{12,}/.test(value.trim());
}

export function normalizeEnvKey(key: string): string {
  return key.trim().replace(/[^\w]/g, "_").replace(/^(\d)/, "_$1").toUpperCase();
}

/**
 * 环境配置：用户给 bot 的非敏感配置（接口地址、账号名、项目 ID、环境变量等），明文存 env.json。
 * 每轮注入 bot 的系统提示（bot 记得自己配过什么），bash.run 执行时作为环境变量注入。
 * 密码 / Token 不放这里，走 SecretStore 加密。
 */
export class EnvStore {
  private file: string;
  private entries: EnvEntry[] = [];

  constructor(home: string) {
    this.file = join(home, "env.json");
    const data = readJsonSafe<EnvEntry[]>(this.file, []);
    this.entries = Array.isArray(data) ? data.filter((e) => e?.key) : [];
  }

  private persist() {
    writeJsonAtomic(this.file, this.entries, { mode: 0o600 });
  }

  list(): EnvEntry[] {
    return [...this.entries];
  }

  /** bot 能用到的：共用的 + 自己的（同名时自己的优先） */
  visibleTo(botId: string): EnvEntry[] {
    const map = new Map<string, EnvEntry>();
    for (const e of this.entries) if (!e.botId) map.set(e.key, e);
    for (const e of this.entries) if (e.botId === botId) map.set(e.key, e);
    return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  set(input: Omit<EnvEntry, "updatedAt" | "key"> & { key: string }): EnvEntry {
    const key = normalizeEnvKey(input.key);
    if (!key) throw new Error("key 不能为空");
    const i = this.entries.findIndex((e) => e.key === key && (e.botId ?? "") === (input.botId ?? ""));
    const prev = i >= 0 ? this.entries[i] : undefined;
    const e: EnvEntry = { ...prev, ...input, key, label: input.label ?? prev?.label, note: input.note ?? prev?.note, updatedAt: Date.now() };
    if (i >= 0) this.entries[i] = e;
    else this.entries.push(e);
    this.persist();
    return e;
  }

  remove(key: string, botId?: string): boolean {
    const k = normalizeEnvKey(key);
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !(e.key === k && (e.botId ?? "") === (botId ?? "")));
    if (this.entries.length === before) return false;
    this.persist();
    return true;
  }

  envFor(botId: string): Record<string, string> {
    return Object.fromEntries(this.visibleTo(botId).map((e) => [e.key, e.value]));
  }
}
