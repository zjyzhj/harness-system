/**
 * 本机通讯录：姓名 / 邮箱 / 备注。无支付、无云邮箱身份。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./atomic-fs";

export interface Contact {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  address?: string;
  /** 何时用这条联系人（对齐 Grok Vault Hints） */
  hint?: string;
  note?: string;
  updatedAt: number;
}

export class ContactStore {
  private file: string;
  private items: Contact[] = [];

  constructor(home: string) {
    this.file = join(home, "contacts.json");
    const data = readJsonSafe<Contact[]>(this.file, []);
    this.items = Array.isArray(data) ? data.filter((c) => c?.id && c?.name) : [];
  }

  private persist() {
    writeJsonAtomic(this.file, this.items, { mode: 0o600 });
  }

  list(): Contact[] {
    return [...this.items].sort((a, b) => a.name.localeCompare(b.name, "zh"));
  }

  search(q: string): Contact[] {
    const n = q.trim().toLowerCase();
    if (!n) return this.list();
    return this.list().filter(
      (c) =>
        c.name.toLowerCase().includes(n) ||
        (c.email ?? "").toLowerCase().includes(n) ||
        (c.phone ?? "").toLowerCase().includes(n) ||
        (c.address ?? "").toLowerCase().includes(n) ||
        (c.hint ?? "").toLowerCase().includes(n) ||
        (c.note ?? "").toLowerCase().includes(n),
    );
  }

  get(idOrName: string): Contact | undefined {
    const key = idOrName.trim();
    return this.items.find((c) => c.id === key) ?? this.items.find((c) => c.name === key);
  }

  upsert(input: { id?: string; name: string; email?: string; phone?: string; address?: string; hint?: string; note?: string }): Contact {
    const name = input.name.trim();
    if (!name) throw new Error("联系人姓名不能为空");
    const id = input.id?.trim() || randomUUID();
    const i = this.items.findIndex((c) => c.id === id);
    const c: Contact = {
      id,
      name,
      email: input.email?.trim() || undefined,
      phone: input.phone?.trim() || undefined,
      address: input.address?.trim() || undefined,
      hint: input.hint?.trim() || undefined,
      note: input.note?.trim() || undefined,
      updatedAt: Date.now(),
    };
    if (i >= 0) this.items[i] = c;
    else this.items.push(c);
    this.persist();
    return c;
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((c) => c.id !== id);
    if (this.items.length === before) return false;
    this.persist();
    return true;
  }
}
