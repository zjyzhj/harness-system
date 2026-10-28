import { contentText, type Bot, type ChatMessage, type ContentBlock, type PetState, type Provider, type SearchHit, type Session } from "./types";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, chmodSync, rmSync } from "node:fs";
import { appendLinesSafe, parseJsonl, readJsonSafe, writeFileAtomic, writeJsonAtomic } from "./atomic-fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_HOME = join(homedir(), ".harness-bot");

/** 模型 apiKey 落盘加密（Electron 里是 safeStorage → 系统钥匙串） */
export interface KeyCipher {
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}
const isCipherText = (v: string | undefined): v is string => !!v && /^(enc|b64):/.test(v);

const MSG_FILE = "messages.json";           // 旧格式：{ sid: ChatMessage[] }
const MSG_DIR = "sessions";                 // G1 新格式：sessions/<sid>.jsonl（append-only）
const ATTACH_DIR = "attachments";           // 消息里的图片落盘处（jsonl 里只存路径）
const INLINE_IMAGE_RE = /^data:image\/([\w+.-]+);base64,(.+)$/s;

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
  private keyCipher: KeyCipher | null = null;
  /** 解不开的密文原样保留，避免一次写盘就把 key 弄丢 */
  private lockedKeys = new Map<string, string>();

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
    return readJsonSafe(join(this.home, file), fallback);
  }
  private persist(file: string, data: unknown) {
    writeJsonAtomic(join(this.home, file), data);
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
    appendLinesSafe(this.msgPath(sid), lines);
  }
  private readSession(sid: string): ChatMessage[] {
    const p = join(this.home, MSG_DIR, `${sid}.jsonl`);
    if (!existsSync(p)) return [];
    try {
      return parseJsonl<ChatMessage>(readFileSync(p, "utf8"));
    } catch {
      return [];
    }
  }
  private rewriteSession(sid: string, msgs: ChatMessage[]) {
    writeFileAtomic(this.msgPath(sid), msgs.map((m) => JSON.stringify(m)).join("\n") + (msgs.length ? "\n" : ""));
  }

  private ensureConfig() {
    if (!existsSync(this.configPath)) {
      writeFileSync(this.configPath, "{}", { mode: 0o600, flag: "w" });
    }
    try { chmodSync(this.configPath, 0o600); } catch {}
  }

  readConfig(): Record<string, unknown> {
    const cfg = readJsonSafe<unknown>(this.configPath, {});
    return cfg && typeof cfg === "object" && !Array.isArray(cfg) ? (cfg as Record<string, unknown>) : {};
  }
  writeConfig(cfg: Record<string, unknown>) {
    writeJsonAtomic(this.configPath, cfg, { mode: 0o600 });
  }

  // ---- providers ----
  /** 设好加密器后：内存里解密，磁盘上的明文 key 立即改写成密文 */
  setKeyCipher(c: KeyCipher) {
    this.keyCipher = c;
    for (const p of Object.values(this.providers)) {
      if (!isCipherText(p.apiKey)) continue;
      try { p.apiKey = c.decrypt(p.apiKey); } catch { this.lockedKeys.set(p.id, p.apiKey); p.apiKey = undefined; }
    }
    this.persistProviders();
  }
  private persistProviders() {
    const c = this.keyCipher;
    const out = Object.fromEntries(Object.entries(this.providers).map(([id, p]) => {
      const key = p.apiKey ? (c ? c.encrypt(p.apiKey) : p.apiKey) : this.lockedKeys.get(id);
      return [id, { ...p, apiKey: key }];
    }));
    writeJsonAtomic(join(this.home, "providers.json"), out, { mode: 0o600 });
    try { chmodSync(join(this.home, "providers.json"), 0o600); } catch {}
  }
  saveProvider(p: Provider) {
    this.providers[p.id] = p;
    if (p.isDefault) {
      for (const id of Object.keys(this.providers)) {
        if (id !== p.id) this.providers[id] = { ...this.providers[id], isDefault: false };
      }
    }
    this.persistProviders();
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
    this.lockedKeys.delete(id);
    this.persistProviders();
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

  getSession(sessionId: string): Session | null {
    return this.sessions[sessionId] ?? null;
  }

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

  private messageListeners = new Set<(m: ChatMessage) => void>();
  /** 订阅新消息落盘（主进程据此把后台产生的消息实时推给界面） */
  onMessageAdded(fn: (m: ChatMessage) => void): () => void {
    this.messageListeners.add(fn);
    return () => this.messageListeners.delete(fn);
  }

  addMessage(m: ChatMessage) {
    const sid = m.sessionId;
    const now = Date.now();
    if (!this.sessions[sid]) {
      this.sessions[sid] = { id: sid, botId: m.to, title: contentText(m.content).slice(0, 24) || "新会话", createdAt: now, updatedAt: now, messageCount: 0, lastSeq: 0, tokenEstimate: 0 };
    }
    const msg = { ...m, content: this.offloadImages(m.content), id: this.nextMsgId++ };
    const arr = this.messagesBySession[sid] || (this.messagesBySession[sid] = []);
    arr.push(msg);
    this.appendLines(sid, [JSON.stringify(msg)]);
    const s = this.sessions[sid];
    s.updatedAt = now;
    s.messageCount = (s.messageCount ?? 0) + 1;
    s.tokenEstimate = (s.tokenEstimate ?? 0) + estimateTokens(m.content);
    this.persist("sessions.json", this.sessions);
    for (const fn of this.messageListeners) {
      try { fn(msg); } catch {}
    }
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

  setSessionProject(sessionId: string, projectId: string | null) {
    const s = this.sessions[sessionId];
    if (!s) return;
    if (projectId) s.projectId = projectId;
    else delete s.projectId;
    this.persist("sessions.json", this.sessions);
  }

  renameSession(sessionId: string, title: string) {
    const s = this.sessions[sessionId];
    if (!s) return;
    s.title = title.slice(0, 60);
    this.persist("sessions.json", this.sessions);
  }

  /** 删除指定消息并重写该会话 jsonl */
  deleteMessages(sessionId: string, ids: number[]) {
    const drop = new Set(ids);
    const kept = this.listMessages(sessionId).filter((m) => !drop.has((m as any).id));
    this.messagesBySession[sessionId] = kept;
    this.rewriteSession(sessionId, kept);
    const s = this.sessions[sessionId];
    if (s) {
      s.messageCount = kept.length;
      s.tokenEstimate = kept.reduce((n, m) => n + estimateTokens(m.content), 0);
      this.persist("sessions.json", this.sessions);
    }
  }

  /** 改一条已存的消息（如问题卡片记下用户的选择），整份 jsonl 重写 */
  updateMessage(sessionId: string, id: number, mutate: (m: ChatMessage) => ChatMessage): ChatMessage | null {
    const list = this.listMessages(sessionId);
    const idx = list.findIndex((m) => (m as any).id === id);
    if (idx < 0) return null;
    const next = mutate(list[idx]);
    const kept = list.map((m, i) => (i === idx ? next : m));
    this.messagesBySession[sessionId] = kept;
    this.rewriteSession(sessionId, kept);
    return next;
  }

  /** 内嵌的 base64 图片写成文件（同一张图只存一份），消息里只留路径，会话文件不再动辄几 MB */
  private offloadImages(content: ChatMessage["content"]): ChatMessage["content"] {
    if (!Array.isArray(content)) return content;
    let changed = false;
    const out = content.map((b): ContentBlock => {
      if (b.type !== "image" || !b.dataUrl) return b;
      const m = b.dataUrl.match(INLINE_IMAGE_RE);
      if (!m) return b;
      const ext = ({ jpeg: "jpg", "svg+xml": "svg" } as Record<string, string>)[m[1]] ?? m[1];
      const buf = Buffer.from(m[2], "base64");
      const dir = join(this.home, ATTACH_DIR);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${createHash("sha1").update(buf).digest("hex").slice(0, 20)}.${ext}`);
      if (!existsSync(file)) writeFileSync(file, buf);
      changed = true;
      const { dataUrl: _d, ...rest } = b;
      return { ...rest, path: file };
    });
    return changed ? out : content;
  }

  /** 一次性整理：旧会话里内嵌的图片挪成文件，返回处理了几个会话 */
  offloadInlineImages(): number {
    let n = 0;
    const dir = join(this.home, MSG_DIR);
    if (!existsSync(dir)) return 0;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      if (!readFileSync(join(dir, f), "utf8").includes('"dataUrl":"data:image')) continue;
      const sid = basename(f, ".jsonl");
      const msgs = this.readSession(sid).map((m) => ({ ...m, content: this.offloadImages(m.content) }));
      this.messagesBySession[sid] = msgs;
      this.rewriteSession(sid, msgs);
      n++;
    }
    return n;
  }

  /** 删除会话（含 jsonl 文件） */
  deleteSession(sessionId: string) {
    delete this.sessions[sessionId];
    delete this.messagesBySession[sessionId];
    try { rmSync(this.msgPath(sessionId), { force: true }); } catch {}
    this.persist("sessions.json", this.sessions);
  }

  /** 确保会话索引存在（压缩边界要写 lastSeq，不能等首条消息才建） */
  ensureSession(sessionId: string, botId: string, title = "新会话"): Session {
    const s = this.sessions[sessionId];
    if (s) return s;
    const now = Date.now();
    const created: Session = { id: sessionId, botId, title, createdAt: now, updatedAt: now, messageCount: 0, lastSeq: 0, tokenEstimate: 0 };
    this.sessions[sessionId] = created;
    this.persist("sessions.json", this.sessions);
    return created;
  }

  /** 更新会话压缩边界（供 BotRuntime 增量摘要） */
  markCompacted(sessionId: string, lastSeq: number, summary?: string) {
    const s = this.sessions[sessionId];
    if (!s) return;
    s.lastSeq = Math.max(s.lastSeq ?? 0, lastSeq);
    if (summary !== undefined) s.summary = summary;
    this.persist("sessions.json", this.sessions);
  }

  // ---- pets ----
  /** upsert：与已有记录合并（保留 xp/displayId 等未提供的字段，避免移动保存冲掉成长值） */
  savePet(p: PetState) {
    const prev = this.pets[p.botId];
    this.pets[p.botId] = prev ? { ...prev, ...p } : p;
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
/** 中日韩文字大约一个字一个 token，其它字符约四个一个 token */
export function textTokens(s: string): number {
  const cjk = s.match(/[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/g)?.length ?? 0;
  return cjk + Math.ceil((s.length - cjk) / 4);
}

export function estimateTokens(content: string | ChatMessage["content"]): number {
  if (typeof content === "string") return textTokens(content);
  let n = 0;
  for (const b of content) {
    switch (b.type) {
      case "text": n += textTokens(b.text); break;
      case "code": n += textTokens(b.code); break;
      case "thinking": n += textTokens(b.text); break;
      case "image": n += 85; break;
      case "tool_call": n += 60; break;
      case "file": n += 30; break;
      default: n += 20;
    }
  }
  return n;
}
