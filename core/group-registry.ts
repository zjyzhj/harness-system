import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * G4 群组注册表 — 对标 Grok Bot 群组协作。
 * - 群组：name + members(botId[]) + admin(botId 或 "user")
 * - @组名 解析 → 成员列表（用于 MessageBus.broadcast）
 * - 持久化 groups.json
 */
export interface Group {
  id: string;
  name: string;
  members: string[];
  admin: string;          // "user" 或 bot id
  createdAt: number;
}

export class GroupRegistry {
  private groups = new Map<string, Group>();
  private file: string;

  constructor(private home: string) {
    this.file = join(home, "groups.json");
    this.load();
  }

  private load() {
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as Group[];
        for (const g of raw) this.groups.set(g.id, g);
      } catch { /* 损坏则重置 */ }
    }
  }
  private persist() {
    writeFileSync(this.file, JSON.stringify([...this.groups.values()], null, 2), "utf8");
  }

  create(name: string, admin: string, members: string[] = []): Group {
    const g: Group = { id: randomUUID(), name, admin, members: [...new Set(members)], createdAt: Date.now() };
    this.groups.set(g.id, g);
    this.persist();
    return g;
  }

  join(groupId: string, botId: string) {
    const g = this.groups.get(groupId);
    if (!g) return null;
    if (!g.members.includes(botId)) { g.members.push(botId); this.persist(); }
    return g;
  }

  leave(groupId: string, botId: string) {
    const g = this.groups.get(groupId);
    if (!g) return null;
    g.members = g.members.filter((m) => m !== botId);
    this.persist();
    return g;
  }

  remove(groupId: string) {
    this.groups.delete(groupId);
    this.persist();
  }

  list(botId?: string): Group[] {
    const all = [...this.groups.values()];
    return botId ? all.filter((g) => g.members.includes(botId) || g.admin === botId) : all;
  }

  get(groupId: string): Group | null {
    return this.groups.get(groupId) ?? null;
  }

  members(groupId: string): string[] {
    return this.groups.get(groupId)?.members ?? [];
  }

  /** @组名 → 群组对象（去掉 @ 前缀） */
  findByName(name: string): Group | null {
    const n = name.replace(/^@/, "");
    return [...this.groups.values()].find((g) => g.name === n) ?? null;
  }

  /** 文本中 @组名 → 匹配的群组列表 */
  resolveAt(text: string): Group[] {
    const hits: Group[] = [];
    const re = /@([\p{L}\p{N}_\-\u4e00-\u9fa5]+)/gu;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const g = this.findByName(m[1]);
      if (g && !hits.some((x) => x.id === g.id)) hits.push(g);
    }
    return hits;
  }

  /** 文本中 @组名 → 成员 bot id 列表（不含 @ 关键字前的发起者） */
  resolveMembers(text: string): string[] {
    const groups = this.resolveAt(text);
    return [...new Set(groups.flatMap((g) => g.members))];
  }
}
