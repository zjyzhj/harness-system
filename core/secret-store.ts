import { join } from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./atomic-fs";

export interface SecretCipher {
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}

export interface SecretInfo { name: string; label?: string; note?: string; savedBy?: string; botId?: string; savedAt: number }
type SecretEntry = Omit<SecretInfo, "name"> & { value: string };

/**
 * 本机密钥（对齐 Grok Vault：账号级共用）。
 * bot 用 ui.secret 请用户填写，值加密落盘（Electron safeStorage → 系统钥匙串）。
 * 模型只知道名字；工具参数写 {{secret:名字}}，执行前才替换，输出再打码。
 *
 * 本机所有 bot 都能看到和使用——不能锁给单个 bot（Grok：Vault covers whole account）。
 * savedBy / 历史 botId 只作「谁收录」归因；访问不再按 botId 过滤。
 */
export class SecretStore {
  private file: string;
  private data: Record<string, SecretEntry> = {};

  constructor(home: string, private cipher: SecretCipher) {
    this.file = join(home, "secrets.json");
    const data = readJsonSafe<SecretStore["data"]>(this.file, {});
    this.data = data && typeof data === "object" && !Array.isArray(data) ? data : {};
    this.migrateAccountVault();
  }

  /** 旧版「仅某 bot」ACL → 账号级；落盘一次 */
  private migrateAccountVault() {
    let dirty = false;
    for (const e of Object.values(this.data)) {
      if (e.botId) {
        delete e.botId;
        dirty = true;
      }
    }
    if (dirty) this.persist();
  }

  private persist() {
    writeJsonAtomic(this.file, this.data, { mode: 0o600 });
  }

  /** meta.botId 忽略（兼容旧调用）；一律账号级 */
  set(name: string, value: string, label?: string, meta?: { note?: string; savedBy?: string; botId?: string | null }) {
    const prev = this.data[name];
    this.data[name] = {
      value: this.cipher.encrypt(value),
      label: label ?? prev?.label,
      note: meta?.note ?? prev?.note,
      savedBy: meta?.savedBy ?? prev?.savedBy,
      savedAt: Date.now(),
    };
    this.persist();
  }

  /** @deprecated 账号级保险库不再按 bot 隔离；调用等价于清掉历史 botId 标记 */
  setScope(name: string, _botId: string | null): boolean {
    const e = this.data[name];
    if (!e) return false;
    if (e.botId) {
      delete e.botId;
      this.persist();
    }
    return true;
  }

  /**
   * 主动共用（兼容旧私有标记）：清掉 botId。
   * 账号级下访问本就全员可用；本工具主要统一界面归因，任意 bot 可调。
   */
  share(name: string, _byBotId: string): { ok: true } | { ok: false; error: string } {
    const e = this.data[name];
    if (!e) return { ok: false, error: `没有密钥 ${name}` };
    if (e.botId) {
      delete e.botId;
      this.persist();
    }
    return { ok: true };
  }

  /** 命令里出现的 $NAME / ${NAME} */
  referencedIn(command: string, _botId?: string): string[] {
    return Object.keys(this.data).filter((n) => /^[A-Za-z_]\w*$/.test(n) && new RegExp(`\\$\\{?${n}\\b`).test(command));
  }

  get(name: string, _botId?: string): string | undefined {
    const e = this.data[name];
    if (!e) return undefined;
    try { return this.cipher.decrypt(e.value); } catch { return undefined; }
  }

  has(name: string): boolean {
    return name in this.data;
  }

  /** @deprecated 账号级下名字全局；恒 false（保留调用点不炸） */
  ownedByOther(_name: string, _botId: string): boolean {
    return false;
  }

  /** 元数据（不含真值） */
  meta(name: string): SecretInfo | undefined {
    const e = this.data[name];
    if (!e) return undefined;
    return { name, label: e.label, note: e.note, savedBy: e.savedBy, botId: e.botId, savedAt: e.savedAt };
  }

  remove(name: string) {
    delete this.data[name];
    this.persist();
  }

  list(_botId?: string): SecretInfo[] {
    return Object.entries(this.data).map(([name, e]) => ({
      name, label: e.label, note: e.note, savedBy: e.savedBy, botId: e.botId, savedAt: e.savedAt,
    }));
  }

  /**
   * 把参数里的 {{secret:名字}} 换成真值。
   * missing = 库里没有；denied 保留字段（账号级下恒为空）。
   */
  fill(args: Record<string, unknown>, botId?: string): { args: Record<string, unknown>; missing: string[]; denied: string[]; used: string[] } {
    const missing = new Set<string>();
    const used = new Set<string>();
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") {
        return v.replace(/\{\{\s*secret:([\w.\-]+)\s*\}\}/g, (_m, name: string) => {
          const val = this.get(name, botId);
          if (val === undefined) {
            missing.add(name);
            return _m;
          }
          used.add(name);
          return val;
        });
      }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      return v;
    };
    return { args: walk(args) as Record<string, unknown>, missing: [...missing], denied: [], used: [...used] };
  }

  /** 工具输出里出现的密钥真值打码，防止回流给模型 */
  redact(text: string, names: string[]): string {
    let out = text;
    for (const n of names) {
      const v = this.get(n);
      if (v && v.length >= 4) out = out.split(v).join(`***${n}***`);
    }
    return out;
  }
}
