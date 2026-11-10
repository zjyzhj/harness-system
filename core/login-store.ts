/**
 * Vault Login：网站 + 用户名 + 密码（密码只进 SecretStore，永不回显）。
 * 不做 Card / 支付。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./atomic-fs";
import type { SecretStore } from "./secret-store";

export interface LoginEntry {
  id: string;
  website: string;
  username: string;
  /** SecretStore 中的密码名 */
  secretName: string;
  hint?: string;
  note?: string;
  updatedAt: number;
}

export class LoginStore {
  private file: string;
  private items: LoginEntry[] = [];

  constructor(
    home: string,
    private secrets: SecretStore,
  ) {
    this.file = join(home, "logins.json");
    const data = readJsonSafe<LoginEntry[]>(this.file, []);
    this.items = Array.isArray(data) ? data.filter((x) => x?.id && x?.website && x?.username && x?.secretName) : [];
  }

  private persist() {
    writeJsonAtomic(this.file, this.items, { mode: 0o600 });
  }

  list(): LoginEntry[] {
    return [...this.items].sort((a, b) => a.website.localeCompare(b.website));
  }

  get(idOrWebsite: string): LoginEntry | undefined {
    const key = idOrWebsite.trim();
    return (
      this.items.find((x) => x.id === key) ??
      this.items.find((x) => x.website === key) ??
      this.items.find((x) => x.website.includes(key) || key.includes(x.website))
    );
  }

  search(q: string): LoginEntry[] {
    const n = q.trim().toLowerCase();
    if (!n) return this.list();
    return this.list().filter(
      (x) =>
        x.website.toLowerCase().includes(n) ||
        x.username.toLowerCase().includes(n) ||
        (x.hint ?? "").toLowerCase().includes(n) ||
        (x.note ?? "").toLowerCase().includes(n),
    );
  }

  /**
   * 新建或更新登录项。password 有值才写入/替换 SecretStore。
   * 返回的条目永不含密码。
   */
  upsert(input: {
    id?: string;
    website: string;
    username: string;
    password?: string;
    hint?: string;
    note?: string;
    secretName?: string;
  }): LoginEntry {
    const website = input.website.trim();
    const username = input.username.trim();
    if (!website || !username) throw new Error("需要网站和用户名");
    const id = input.id?.trim() || randomUUID();
    const prev = this.items.find((x) => x.id === id);
    const secretName = (input.secretName || prev?.secretName || `login-${id.slice(0, 8)}`).trim();
    if (input.password != null && input.password !== "") {
      this.secrets.set(secretName, input.password, `登录 ${website}`, { note: input.hint || input.note, botId: null });
    } else if (!prev && !this.secrets.has(secretName)) {
      throw new Error("新建登录需要密码");
    }
    const entry: LoginEntry = {
      id,
      website,
      username,
      secretName,
      hint: input.hint?.trim() || undefined,
      note: input.note?.trim() || undefined,
      updatedAt: Date.now(),
    };
    const i = this.items.findIndex((x) => x.id === id);
    if (i >= 0) this.items[i] = entry;
    else this.items.push(entry);
    this.persist();
    return entry;
  }

  /** 取密码明文（仅主机侧填充用；绝不进模型上下文） */
  passwordOf(id: string): string | null {
    const e = this.get(id);
    if (!e) return null;
    return this.secrets.get(e.secretName) ?? null;
  }

  remove(id: string, opts?: { deleteSecret?: boolean }): boolean {
    const e = this.items.find((x) => x.id === id);
    if (!e) return false;
    this.items = this.items.filter((x) => x.id !== id);
    this.persist();
    if (opts?.deleteSecret !== false) {
      try {
        this.secrets.remove(e.secretName);
      } catch {
        /* ignore */
      }
    }
    return true;
  }
}
