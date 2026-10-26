import { contentText, type Bot, type ChatMessage, type PetState, type Provider, type Session } from "./types";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_HOME = join(homedir(), ".harness-bot");

/**
 * 纯 JS 文件存储（兼容 bun / Node / Electron，零原生依赖）。
 * 每个集合一个 JSON 文件；写入走「临时文件 + rename」原子替换。
 * 数据量小（几个 bot、几百条消息），文件存储足够，且迁移 = 复制文件。
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
    this.messagesBySession = this.load("messages.json", {});
    this.pets = this.load("pets.json", {});
    for (const arr of Object.values(this.messagesBySession)) {
      for (const m of arr) this.nextMsgId = Math.max(this.nextMsgId, (m as any).id ?? 0) + 1;
    }
    this.ensureConfig();
  }

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

  // ---- sessions / messages ----
  listSessions(botId?: string): Session[] {
    const all = Object.values(this.sessions).sort((a, b) => b.updatedAt - a.updatedAt);
    return botId ? all.filter((s) => s.botId === botId) : all;
  }
  addMessage(m: ChatMessage) {
    const sid = m.sessionId;
    if (!this.sessions[sid]) {
      this.sessions[sid] = { id: sid, botId: m.to, title: contentText(m.content).slice(0, 24) || "新会话", createdAt: Date.now(), updatedAt: Date.now() };
    }
    const arr = this.messagesBySession[sid] || (this.messagesBySession[sid] = []);
    arr.push({ ...m, id: this.nextMsgId++ });
    this.sessions[sid].updatedAt = Date.now();
    this.persist("messages.json", this.messagesBySession);
    this.persist("sessions.json", this.sessions);
  }
  listMessages(sessionId: string): ChatMessage[] {
    return (this.messagesBySession[sessionId] ?? []).map(({ id: _id, ...rest }) => rest as ChatMessage);
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
