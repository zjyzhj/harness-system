import { contentText, type Bot, type ChatMessage, type PetState, type Provider, type SearchHit, type Session } from "./types";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, chmodSync, rmSync, renameSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_HOME = join(homedir(), ".harness-bot");

const MSG_FILE = "messages.json";           // 旧格式：{ sid: ChatMessage[] }
const MSG_DIR = "sessions";                 // G1 新格式：sessions/<sid>.jsonl（append-only）

/**
 * 纯 JS 文件存储（兼容 bun / Node / Electron，零原生依赖）。
 * - 配置/元数据：JSON 文件，原子写（临时文件 + rename）
 * - 消息：G1 起按会话分片为 sessions/<sid>.jsonl（append-only，单条 IO 恒定）
 * - 旧 messages.json 在构造时自动迁为 jsonl（原文件保留 + "migrated":true 标记）
 *
 * G1 能力：分页（会话/消息）、全文搜索、归档、会话统计（messageCount/lastSeq/tokenEstimate）
 */
export class Store {
  readonly home: string;
  readonly configPath: string;
  private providers: Record<string, Provider> = {};
  private bots: Record<string, Bot> = {};
  private sessions: Record<string, Session> = {};
  private messagesBySession: Record<string, ChatMessage[]> = {};
  private pets: Record<string, PetState> = {};
  private nextMsgId = 1;

  constructor(home = process.env.HARNESS_HOME || DEFAULT_HOME) {
    this.home = home;
    if (!existsSync(home)) mkdirSync(home, { recursive: true });
    this.configPath = join(home, "config.json");
    this.providers = this.load("providers.json", {});
    this.bots = this.load("bots.json", {});
    this.sessions = this.load("sessions.json", {});
    this.pets = this.load("pets.json", {});
    this.ensureConfig();
    // G1：旧格式升级到 jsonl（幂等：仅当 messages.json 存在且 sessions/ 为空）
    this.migrateMessagesToJsonl();
    // 恢复 nextMsgId：扫描 jsonl（新）或 messages.json（旧，迁移后仍可回滚读取）
    this.scanMsgIds();
    // 懒加载缓存：构造时不再全量读消息（10k 消息秒开的关键）
  }

  // ---------- 迁移：messages.json → sessions/<sid>.jsonl ----------

  private migrateMessagesToJsonl() {
    const legacy = join(this.home, MSG_FILE);
    const msgDir = join(this.home, MSG_DIR);
    if (!existsSync(legacy)) return;
    if (existsSync(msgDir) && readdirSync(msgDir).length > 0) return; // 已迁移过
    try {
      const data = JSON.parse(readFileSync(legacy, "utf8")) as Record<string, ChatMessage[]>;
      let moved = 0;
      for (const [sid, arr] of Object.entries(data)) {
        const bySession = sid.startsWith(`s-`) || sid.startsWith("sched-") || sid.startsWith("x-") || (arr.length && arr[0]?.sessionId === sid);
        const realSid = bySession ? sid : (arr[0]?.sessionId ?? sid);
        const lines = arr.map((m) => JSON.stringify({ ...m, id: m.id ?? 0 }));
        this.appendLines(realSid, lines);
        moved += lines.length;
        // 建/补 SessionIndex
        const s = this.sessions[realSid];
        if (s) {
          s.messageCount = arr.length;
          s.updatedAt = Math.max(s.updatedAt, ...arr.map((m) => m.createdAt));
        } else if (arr[0]) {
          this.sessions[realSid] = {
            id: realSid, botId: arr[0].to, title: contentText(arr[0].content).slice(0, 24) || "新会话",
            createdAt: arr[0].createdAt, updatedAt: arr[0].createdAt, messageCount: arr.length,
          };
        }
      }
      // 标记迁移完成（保留原文件供回滚）
      writeFileSync(legacy, JSON.stringify({ migrated: true, at: new Date().toISOString(), moved }, null, 2), "utf8");
      this.persist("sessions.json", this.sessions);
    } catch (e) {
      // 迁移失败：回滚（删掉半写文件），仍用旧格式内存路径
      try { if (existsSync(msgDir)) rmSync(msgDir, { recursive: true, force: true }); } catch {}
      this.messagesBySession = this.load(MSG_FILE, {});
    }
  }

  private scanMsgIds() {
    const msgDir = join(this.home, MSG_DIR);
    if (existsSync(msgDir)) {
      for (const f of readdirSync(msgDir)) {
        if (!f.endsWith(".jsonl")) continue;
        const sid = basename(f, ".jsonl");
        const arr = this.readSession(sid);
        this.messagesBySession[sid] = arr;
        for (const m of arr) this.nextMsgId = Math.max(this.nextMsgId, (m as any).id ?? 0) + 1;
      }
    } else {
      // 旧格式兜底（迁移失败场景）
      for (const arr of Object.values(this.messagesBySession)) {
        for (const m of arr) this.nextMsgId = Math.max(this.nextMsgId, (m as any).id ?? 0) + 1;
      }
    }
  }

  // ---------- 基础 IO ----------

  private load<T>(file: string, fallback: T): T {
    const p = join(this.home, file);
    if (!existsSync(p)) return fallback;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as T;
    } catch {
      return fallback;
    }
  }
  private persist(file: string, data: unknown) {
    const dest = join(this.home, file);
    const tmp = dest + ".tmp";
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, dest);
  }

  private msgDir(): string {
    const d = join(this.home, MSG_DIR);
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    return d;
  }
  private msgPath(sid: string): string {
    return join(this.msgDir(), `${sid}.jsonl`);
  }
  private appendLines(sid: string, lines: string[]) {
    if (!lines.length) return;
    appendFileSync(this.msgPath(sid), lines.join("\n") + "\n", "utf8");
  }
  private readSession(sid: string): ChatMessage[] {
    const p = join(this.home, MSG_DIR, `${sid}.jsonl`);
    if (!existsSync(p)) return [];
    try {
      const raw = readFileSync(p, "utf8");
      return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as ChatMessage);
    } catch {
      return [];
    }
  }

  private ensureConfig() {
    if (!existsSync(this.configPath)) {
      writeFileSync(this.configPath, "{}", { mode: 0o600, flag: "w" });
    }
    try { chmodSync(this.configPath, 0o600); } catch {}
  }

  readConfig(): Record<string, unknown> {
    return JSON.parse(readFileSync(this.configPath, "utf8"));
  }
  writeConfig(cfg: Record<string, unknown>) {
    writeFileSync(this.configPath, JSON.stringify(cfg, null, 2), { mode: 0o600, flag: "w" });
  }

  // ---- providers ----
  saveProvider(p: Provider) {
    this.providers[p.id] = p;
    if (p.isDefault) {
      for (const id of Object.keys(this.providers)) {
        if (id !== p.id) this.providers[id] = { ...this.providers[id], isDefault: false };
      }
    }
    this.persist("providers.json", this.providers);
  }
  listProviders(): Provider[] {
    return Object.values(this.providers).sort((a, b) => a.createdAt - b.createdAt);
  }
  getProvider(id: string): Provider | null {
    return this.providers[id] ?? null;
  }
  getDefaultProvider(): Provider | null {
    const d = Object.values(this.providers).find((p) => p.isDefault);
    if (d) return d;
    return Object.values(this.providers)[0] ?? null;
  }
  deleteProvider(id: string) {
    delete this.providers[id];
    this.persist("providers.json", this.providers);
  }

  // ---- bots ----
  saveBot(b: Bot) {
    this.bots[b.id] = b;
    this.persist("bots.json", this.bots);
  }
  listBots(): Bot[] {
    return Object.values(this.bots).sort((a, b) => a.createdAt - b.createdAt);
  }
  getBot(id: string): Bot | null {
    return this.bots[id] ?? null;
  }
  deleteBot(id: string) {
    delete this.bots[id];
    this.persist("bots.json", this.bots);
    delete this.pets[id];
    this.persist("pets.json", this.pets);
  }

  // ---- sessions / messages（G1） ----

  /** 会话列表（分页 + 归档过滤），倒序 updatedAt */
  listSessionsPage(opts?: { botId?: string; archived?: boolean; offset?: number; limit?: number }): { sessions: Session[]; total: number } {
    const { botId, archived = false, offset = 0, limit = 50 } = opts ?? {};
    let all = Object.values(this.sessions);
    if (botId) all = all.filter((s) => s.botId === botId);
    all = all.filter((s) => (archived ? !!s.archived : !s.archived));
    all.sort((a, b) => b.updatedAt - a.updatedAt);
    return { sessions: all.slice(offset, offset + limit), total: all.length };
  }

  /** 兼容旧签名：全量会话（保留） */
  listSessions(botId?: string): Session[] {
    const { sessions } = this.listSessionsPage({ botId });
    return sessions;
  }

  addMessage(m: ChatMessage) {
    const sid = m.sessionId;
    const now = Date.now();
    if (!this.sessions[sid]) {
      this.sessions[sid] = { id: sid, botId: m.to, title: contentText(m.content).slice(0, 24) || "新会话", createdAt: now, updatedAt: now, messageCount: 0, lastSeq: 0, tokenEstimate: 0 };
    }
    const msg = { ...m, id: this.nextMsgId++ };
    const arr = this.messagesBySession[sid] || (this.messagesBySession[sid] = []);
    arr.push(msg);
    this.appendLines(sid, [JSON.stringify(msg)]);
    const s = this.sessions[sid];
    s.updatedAt = now;
    s.messageCount = (s.messageCount ?? 0) + 1;
    s.tokenEstimate = (s.tokenEstimate ?? 0) + estimateTokens(m.content);
    this.persist("sessions.json", this.sessions);
  }

  /** 消息分页：返回最新 window（或 beforeId 之前的更旧窗口），附带 hasMore */
  listMessagesPage(sessionId: string, opts?: { limit?: number; beforeId?: number }): { msgs: ChatMessage[]; hasMore: boolean } {
    const { limit = 50, beforeId } = opts ?? {};
    const all = this.listMessages(sessionId);
    const idx = beforeId === undefined ? all.length : all.findIndex((m) => (m as any).id === beforeId);
    if (idx < 0) return { msgs: [], hasMore: false };
    const start = Math.max(0, idx - limit);
    const msgs = all.slice(start, idx);
    return { msgs, hasMore: start > 0 };
  }

  /** 兼容旧签名：会话全量消息（保留） */
  listMessages(sessionId: string): ChatMessage[] {
    if (this.messagesBySession[sessionId]) return this.messagesBySession[sessionId];
    const arr = this.readSession(sessionId);
    this.messagesBySession[sessionId] = arr;
    return arr;
  }

  /** 全文搜索（标题 + 消息），线性扫描 ≤万级足够 */
  searchMessages(opts?: { q?: string; botId?: string; from?: number; to?: number; limit?: number }): SearchHit[] {
    const { q, botId, from, to, limit = 50 } = opts ?? {};
    const kw = (q ?? "").trim().toLowerCase();
    if (!kw) return [];
    const hits: SearchHit[] = [];
    for (const [sid, s] of Object.entries(this.sessions)) {
      if (botId && s.botId !== botId) continue;
      if (from && s.updatedAt < from) continue;
      if (to && s.updatedAt > to) continue;
      if (s.title.toLowerCase().includes(kw)) {
        hits.push({ sessionId: sid, botId: s.botId, msgId: -1, snippet: s.title, createdAt: s.updatedAt, role: "session" });
        if (hits.length >= limit) break;
      }
      const msgs = this.listMessages(sid);
      for (const m of msgs) {
        const t = contentText(m.content).toLowerCase();
        if (t.includes(kw)) {
          const i = t.indexOf(kw);
          hits.push({
            sessionId: sid, botId: s.botId, msgId: (m as any).id ?? 0,
            snippet: t.slice(Math.max(0, i - 24), i + kw.length + 40),
            createdAt: m.createdAt, role: m.role,
          });
          if (hits.length >= limit) return hits;
        }
      }
    }
    return hits;
  }

  /** 归档/恢复会话（软归档，数据不动） */
  archiveSession(sessionId: string, archived: boolean) {
    const s = this.sessions[sessionId];
    if (!s) return;
    s.archived = archived;
    this.persist("sessions.json", this.sessions);
  }

  /** 删除会话（含 jsonl 文件） */
  deleteSession(sessionId: string) {
    delete this.sessions[sessionId];
    delete this.messagesBySession[sessionId];
    try { rmSync(this.msgPath(sessionId), { force: true }); } catch {}
    this.persist("sessions.json", this.sessions);
  }

  /** 更新会话压缩边界（供 BotRuntime 增量摘要） */
  markCompacted(sessionId: string, lastSeq: number) {
    const s = this.sessions[sessionId];
    if (!s) return;
    s.lastSeq = Math.max(s.lastSeq ?? 0, lastSeq);
    this.persist("sessions.json", this.sessions);
  }

  // ---- pets ----
  savePet(p: PetState) {
    this.pets[p.botId] = p;
    this.persist("pets.json", this.pets);
  }
  listPets(): PetState[] {
    return Object.values(this.pets);
  }
  deletePet(botId: string) {
    delete this.pets[botId];
    this.persist("pets.json", this.pets);
  }

  close() {}
}

/** G1：token 估算（text/code ~4 chars/token；image=85；工具/文件=小常数） */
export function estimateTokens(content: string | ChatMessage["content"]): number {
  if (typeof content === "string") return Math.ceil(content.length / 4);
  let n = 0;
  for (const b of content) {
    switch (b.type) {
      case "text": n += Math.ceil(b.text.length / 4); break;
      case "code": n += Math.ceil(b.code.length / 4); break;
      case "thinking": n += Math.ceil(b.text.length / 4); break;
      case "image": n += 85; break;
      case "tool_call": n += 60; break;
      case "file": n += 30; break;
      default: n += 20;
    }
  }
  return n;
}
