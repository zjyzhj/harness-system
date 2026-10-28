import { join } from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./atomic-fs";

export interface SecretCipher {
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}

export interface SecretInfo { name: string; label?: string; note?: string; savedBy?: string; botId?: string; savedAt: number }
type SecretEntry = Omit<SecretInfo, "name"> & { value: string };

/**
 * 本机密钥：bot 用 ui.secret 请用户填写，值加密落盘（Electron safeStorage → 系统钥匙串）。
 * 模型只知道名字，工具参数里写 {{secret:名字}}，执行前才替换成真值，输出里再打码。
 * botId 为空 = 所有 bot 共用；否则只有该 bot 能看到和使用。
 */
export class SecretStore {
  private file: string;
  private data: Record<string, SecretEntry> = {};

  constructor(home: string, private cipher: SecretCipher) {
    this.file = join(home, "secrets.json");
    const data = readJsonSafe<SecretStore["data"]>(this.file, {});
    this.data = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  }

  private persist() {
    writeJsonAtomic(this.file, this.data, { mode: 0o600 });
  }

  private visible(e: SecretEntry | undefined, botId?: string): e is SecretEntry {
    return !!e && (botId === undefined || !e.botId || e.botId === botId);
  }

  /** meta.botId：undefined 保持原范围，null 改为共用 */
  set(name: string, value: string, label?: string, meta?: { note?: string; savedBy?: string; botId?: string | null }) {
    const prev = this.data[name];
    const botId = meta?.botId === undefined ? prev?.botId : meta.botId ?? undefined;
    this.data[name] = { value: this.cipher.encrypt(value), label: label ?? prev?.label, note: meta?.note ?? prev?.note, savedBy: meta?.savedBy ?? prev?.savedBy, botId, savedAt: Date.now() };
    this.persist();
  }

  setScope(name: string, botId: string | null): boolean {
    const e = this.data[name];
    if (!e) return false;
    if (botId) e.botId = botId; else delete e.botId;
    this.persist();
    return true;
  }

  /** 名称在命令里以 $NAME / ${NAME} 出现、且这个 bot 能用的密钥 */
  referencedIn(command: string, botId?: string): string[] {
    return Object.keys(this.data).filter((n) => this.visible(this.data[n], botId) && /^[A-Za-z_]\w*$/.test(n) && new RegExp(`\\$\\{?${n}\\b`).test(command));
  }

  get(name: string, botId?: string): string | undefined {
    const e = this.data[name];
    if (!this.visible(e, botId)) return undefined;
    try { return this.cipher.decrypt(e.value); } catch { return undefined; }
  }

  has(name: string): boolean {
    return name in this.data;
  }

  /** 名字已被别的 bot 私有占用 */
  ownedByOther(name: string, botId: string): boolean {
    const e = this.data[name];
    return !!e?.botId && e.botId !== botId;
  }

  remove(name: string) {
    delete this.data[name];
    this.persist();
  }

  list(botId?: string): SecretInfo[] {
    return Object.entries(this.data)
      .filter(([, e]) => this.visible(e, botId))
      .map(([name, e]) => ({ name, label: e.label, note: e.note, savedBy: e.savedBy, botId: e.botId, savedAt: e.savedAt }));
  }

  /** 把参数里的 {{secret:名字}} 换成真值；缺失（或这个 bot 无权使用）的名字返回给调用方提示 */
  fill(args: Record<string, unknown>, botId?: string): { args: Record<string, unknown>; missing: string[]; used: string[] } {
    const missing = new Set<string>();
    const used = new Set<string>();
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") {
        return v.replace(/\{\{\s*secret:([\w.\-]+)\s*\}\}/g, (_m, name: string) => {
          const val = this.get(name, botId);
          if (val === undefined) { missing.add(name); return _m; }
          used.add(name);
          return val;
        });
      }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      return v;
    };
    return { args: walk(args) as Record<string, unknown>, missing: [...missing], used: [...used] };
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
