/**
 * 宠物自进化：观察 → 提议 → 用户确认（或 autoEvolve）→ 落记忆/人设。
 * 不做黑盒乱变：高影响改动一律可回看、可拒绝。
 *
 * 进化轴（娱乐 + 工作）：
 * - play：玩法 / 口头禅 / 互动习惯
 * - work_style：做事节奏、汇报方式
 * - habit：从用户纠正里长出来的规矩
 * - skill_hint：建议沉淀成技能（只提议，真正写技能仍走 skill.save）
 */
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readJsonSafe, writeJsonAtomic } from "./atomic-fs";
import type { Bot, ChatMessage, MemoryEntry } from "./types";
import { contentText } from "./types";

export type EvolveKind = "play" | "work_style" | "habit" | "skill_hint";

export interface EvolveProposal {
  id: string;
  botId: string;
  kind: EvolveKind;
  title: string;
  detail: string;
  /** 接受后写入 persona 末尾的一小句 */
  personaAppend?: string;
  /** 接受后写入记忆 */
  memory?: { kind: "fact" | "rule"; content: string };
  createdAt: number;
  status: "pending" | "accepted" | "rejected";
}

interface EvolveState {
  /** botId → 上次提议时间 */
  lastPropose: Record<string, number>;
  proposals: EvolveProposal[];
  /** 已用过的信号指纹，避免反复提同一件事 */
  seen: Record<string, number>;
}

export interface EvolveInventContext {
  messages: string[];
  memory: MemoryEntry[];
  xp: number;
  level: number;
}

export interface EvolveDeps {
  bots: () => Bot[];
  memory: (botId: string) => MemoryEntry[];
  recentUserMessages: (botId: string, limit?: number) => ChatMessage[];
  petXp: (botId: string) => number;
  deliver: (botId: string, proposal: EvolveProposal) => void;
  now?: () => number;
  /** 总闸门：是否允许提出进化（prefs.pet.selfEvolve） */
  enabled?: () => boolean;
  /** 是否自动接受（prefs.pet.autoEvolve） */
  autoApply?: () => boolean;
  /** 工作中则跳过——进化是娱乐提议，不打断干活 */
  isBusy?: (botId: string) => boolean;
  apply: (botId: string, proposal: EvolveProposal) => void;
  /** 有模型时现场发明一条提议；null 则走规则观察 */
  invent?: (bot: Bot, ctx: EvolveInventContext) => Promise<{
    kind: EvolveKind;
    title: string;
    detail: string;
    personaAppend?: string;
    memory?: { kind: "fact" | "rule"; content: string };
  } | null>;
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export class PetEvolveEngine {
  private file: string;
  private state: EvolveState;

  constructor(home: string, private deps: EvolveDeps) {
    this.file = join(home, "pet-evolve.json");
    this.state = readJsonSafe(this.file, { lastPropose: {}, proposals: [], seen: {} });
  }

  listPending(botId?: string): EvolveProposal[] {
    return this.state.proposals.filter((p) => p.status === "pending" && (!botId || p.botId === botId));
  }

  /** 进化历史（含已接受/拒绝），新的在前 */
  listHistory(botId?: string, limit = 50): EvolveProposal[] {
    const all = [...this.state.proposals].sort((a, b) => b.createdAt - a.createdAt);
    const filtered = botId ? all.filter((p) => p.botId === botId) : all;
    return filtered.slice(0, limit);
  }

  forgetBot(botId: string) {
    const before = this.state.proposals.length;
    const hadLast = botId in this.state.lastPropose;
    this.state.proposals = this.state.proposals.filter((p) => p.botId !== botId);
    delete this.state.lastPropose[botId];
    if (this.state.proposals.length === before && !hadLast) return;
    writeJsonAtomic(this.file, this.state);
  }

  /** 定期观察：每 bot 最多每天一条提议；优先模型发明，规则兜底 */
  async tick(): Promise<EvolveProposal | null> {
    if (this.deps.enabled && !this.deps.enabled()) return null;
    const now = this.deps.now?.() ?? Date.now();
    for (const bot of this.deps.bots().filter((b) => b.petEnabled)) {
      if (this.deps.isBusy?.(bot.id)) continue;
      if (now - (this.state.lastPropose[bot.id] ?? 0) < DAY) continue;
      const proposal = (await this.observeSmart(bot, now)) || this.observe(bot, now);
      if (!proposal) continue;
      this.state.lastPropose[bot.id] = now;
      this.state.seen[proposal.id] = now;
      // 同 title 指纹，避免模型反复提同一句
      this.state.seen[`t:${hash(proposal.title)}`] = now;
      this.state.proposals.push(proposal);
      this.state.proposals = this.state.proposals.filter((p) => p.status === "pending" || now - p.createdAt < 30 * DAY);
      writeJsonAtomic(this.file, this.state);
      if (this.deps.autoApply?.()) {
        this.accept(proposal.id);
      } else {
        this.deps.deliver(bot.id, proposal);
      }
      return proposal;
    }
    return null;
  }

  private async observeSmart(bot: Bot, now: number): Promise<EvolveProposal | null> {
    if (!this.deps.invent) return null;
    const msgs = this.deps.recentUserMessages(bot.id, 12);
    const texts = msgs.map((m) => contentText(m.content)).filter(Boolean);
    if (!texts.length) return null;
    const xp = this.deps.petXp(bot.id);
    const level = Math.floor(Math.sqrt(xp / 100)) + 1;
    try {
      const drafted = await this.deps.invent(bot, {
        messages: texts.slice(0, 12),
        memory: this.deps.memory(bot.id),
        xp,
        level,
      });
      if (!drafted?.title?.trim() || !drafted?.detail?.trim()) return null;
      const kinds: EvolveKind[] = ["play", "work_style", "habit", "skill_hint"];
      const kind = kinds.includes(drafted.kind) ? drafted.kind : "habit";
      const title = drafted.title.trim().slice(0, 40);
      if (this.state.seen[`t:${hash(title)}`]) return null;
      return this.make(bot, kind, title, drafted.detail.trim().slice(0, 200), {
        personaAppend: drafted.personaAppend?.trim().slice(0, 120),
        memory: drafted.memory?.content
          ? { kind: drafted.memory.kind === "rule" ? "rule" : "fact", content: drafted.memory.content.slice(0, 200) }
          : undefined,
      });
    } catch {
      return null;
    }
  }

  accept(id: string): EvolveProposal | null {
    const p = this.state.proposals.find((x) => x.id === id && x.status === "pending");
    if (!p) return null;
    p.status = "accepted";
    this.deps.apply(p.botId, p);
    writeJsonAtomic(this.file, this.state);
    return p;
  }

  reject(id: string): EvolveProposal | null {
    const p = this.state.proposals.find((x) => x.id === id && x.status === "pending");
    if (!p) return null;
    p.status = "rejected";
    writeJsonAtomic(this.file, this.state);
    return p;
  }

  /**
   * XP 跨级时的娱乐钩子：若今日尚未提议且有聊天素材，顺带观察一条。
   * 不阻塞宿主；工作中直接跳过。
   */
  async onLevelUp(botId: string, level: number): Promise<EvolveProposal | null> {
    if (this.deps.enabled && !this.deps.enabled()) return null;
    if (this.deps.isBusy?.(botId)) return null;
    const bot = this.deps.bots().find((b) => b.id === botId);
    if (!bot?.petEnabled) return null;
    const now = this.deps.now?.() ?? Date.now();
    if (now - (this.state.lastPropose[bot.id] ?? 0) < DAY) return null;
    // 临时把一条「升级」线索塞进 observeSmart 的 messages 语境：通过 invent user 侧已有 level
    const proposal = (await this.observeSmart(bot, now)) || null;
    if (!proposal) return null;
    proposal.detail = `（Lv.${level} 娱乐成长）` + proposal.detail;
    this.state.lastPropose[bot.id] = now;
    this.state.seen[proposal.id] = now;
    this.state.seen[`t:${hash(proposal.title)}`] = now;
    this.state.proposals.push(proposal);
    writeJsonAtomic(this.file, this.state);
    if (this.deps.autoApply?.()) this.accept(proposal.id);
    else this.deps.deliver(bot.id, proposal);
    return proposal;
  }

  /** 用户说「好 / 接受进化」时，取该 bot 最近一条 pending */
  acceptLatest(botId: string): EvolveProposal | null {
    const p = [...this.state.proposals].reverse().find((x) => x.botId === botId && x.status === "pending");
    return p ? this.accept(p.id) : null;
  }

  rejectLatest(botId: string): EvolveProposal | null {
    const p = [...this.state.proposals].reverse().find((x) => x.botId === botId && x.status === "pending");
    return p ? this.reject(p.id) : null;
  }

  private observe(bot: Bot, now: number): EvolveProposal | null {
    const msgs = this.deps.recentUserMessages(bot.id, 12);
    const texts = msgs.map((m) => contentText(m.content)).filter(Boolean);
    const joined = texts.join("\n");
    const mem = this.deps.memory(bot.id);
    const xp = this.deps.petXp(bot.id);
    const level = Math.floor(Math.sqrt(xp / 100)) + 1;

    // 1) 用户纠正 / 「以后都」→ habit
    const ruleHit = texts.find((t) => /以后(都|要|别)|从现在起|不要再|记住：|规范：/.test(t));
    if (ruleHit) {
      const key = `habit:${hash(ruleHit.slice(0, 40))}`;
      if (!this.state.seen[key]) {
        this.state.seen[key] = now;
        return this.make(bot, "habit", "把这句话记成我的规矩？", ruleHit.slice(0, 120), {
          memory: { kind: "rule", content: ruleHit.replace(/^[\s　]+/, "").slice(0, 200) },
        });
      }
    }

    // 2) 反复提到同一工作主题 → skill_hint
    const workTheme = detectTheme(joined);
    if (workTheme) {
      const key = `skill:${workTheme}`;
      if (!this.state.seen[key] && countTheme(texts, workTheme) >= 3) {
        this.state.seen[key] = now;
        return this.make(bot, "skill_hint", `要不要把「${workTheme}」沉淀成我的技能？`,
          `最近多次聊到${workTheme}。同意的话，下次你说「做${workTheme}」我会按固定流程来（仍要你说一声才真正 skill.save）。`, {
            personaAppend: `擅长协助用户处理「${workTheme}」相关事务。`,
          });
      }
    }

    // 3) 升级 → play（娱乐向）
    if (level >= 2) {
      const key = `play:lv${level}`;
      if (!this.state.seen[key]) {
        this.state.seen[key] = now;
        return this.make(bot, "play", `我升到 Lv.${level} 了，要更活泼一点吗？`,
          "同意的话，我会偶尔用更俏皮的口气跟你打招呼；随时说「安静一点」就能收回。", {
            personaAppend: "互动时语气可以更活泼一点，带一点玩笑，但仍以帮用户把事办成优先。",
            memory: { kind: "fact", content: `用户接受了 Lv.${level} 的活泼互动风格` },
          });
      }
    }

    // 4) 工作风格：用户常说「简短 / 详细」
    if (/简洁|短一点|少废话/.test(joined) && !mem.some((m) => /简洁|简短/.test(m.content))) {
      const key = "work:brief";
      if (!this.state.seen[key]) {
        this.state.seen[key] = now;
        return this.make(bot, "work_style", "以后默认回复短一点？",
          "看你最近常嫌话多。同意的话，我默认先给结论，细节你要再展开。", {
            personaAppend: "默认先给结论，控制篇幅；用户要细节时再展开。",
            memory: { kind: "rule", content: "回复默认简短，先结论后细节" },
          });
      }
    }

    return null;
  }

  private make(
    bot: Bot,
    kind: EvolveKind,
    title: string,
    detail: string,
    extra: Partial<Pick<EvolveProposal, "personaAppend" | "memory">> = {},
  ): EvolveProposal {
    return {
      id: randomUUID(),
      botId: bot.id,
      kind,
      title,
      detail,
      createdAt: this.deps.now?.() ?? Date.now(),
      status: "pending",
      ...extra,
    };
  }
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

const THEMES: { key: string; re: RegExp }[] = [
  { key: "周报", re: /周报|weekly/i },
  { key: "会议纪要", re: /会议纪要|纪要|meeting notes/i },
  { key: "代码审查", re: /代码审查|code review|CR\b/i },
  { key: "翻译", re: /翻译|translate/i },
  { key: "日程", re: /日程|提醒|calendar/i },
];

function detectTheme(text: string): string | null {
  for (const t of THEMES) if (t.re.test(text)) return t.key;
  return null;
}

function countTheme(texts: string[], theme: string): number {
  const t = THEMES.find((x) => x.key === theme);
  if (!t) return 0;
  return texts.filter((x) => t.re.test(x)).length;
}

/** 解析模型进化 JSON */
export function parseEvolveInvent(raw: string): {
  kind: EvolveKind;
  title: string;
  detail: string;
  personaAppend?: string;
  memory?: { kind: "fact" | "rule"; content: string };
} | null {
  const m = (raw || "").trim().match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as Record<string, unknown>;
    const kinds: EvolveKind[] = ["play", "work_style", "habit", "skill_hint"];
    const kind = kinds.includes(j.kind as EvolveKind) ? (j.kind as EvolveKind) : null;
    const title = String(j.title || "").trim();
    const detail = String(j.detail || "").trim();
    if (!kind || !title || !detail) return null;
    const mem = j.memory && typeof j.memory === "object" ? (j.memory as Record<string, unknown>) : null;
    return {
      kind,
      title: title.slice(0, 40),
      detail: detail.slice(0, 200),
      personaAppend: j.personaAppend != null ? String(j.personaAppend).trim().slice(0, 120) || undefined : undefined,
      memory: mem?.content
        ? { kind: mem.kind === "rule" ? "rule" : "fact", content: String(mem.content).slice(0, 200) }
        : undefined,
    };
  } catch {
    return null;
  }
}
