import { join } from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./atomic-fs";
import { contentText, type ChatMessage, type OrchestrationPlan, type ScheduledTask, type Session } from "./types";

/** 值得主动跟进的一件事：都来自软件里真实发生的状态，不是随机话术 */
export interface ProactiveSignal {
  key: string;
  kind: "choice" | "offer" | "plan" | "task";
  botId: string;
  sessionId?: string;
  /** 给模型看的事实描述 */
  fact: string;
  at: number;
}

const HOUR = 3600_000;
const OFFER_RE = /需要我|要不要我|要我[^。！？\n]{0,20}吗|回复「继续」|还没做完|下一步可以|我可以继续/;
const OWN_SESSION = /^s-/;

/** 从会话 / 编排 / 定时任务里找出悬而未决的事 */
export function collectSignals(src: {
  sessions: Session[];
  messages: (sessionId: string) => ChatMessage[];
  plans: OrchestrationPlan[];
  tasks: ScheduledTask[];
  masterId?: string;
  nameOf?: (botId: string) => string;
  now: number;
}): ProactiveSignal[] {
  const out: ProactiveSignal[] = [];
  const { now } = src;
  for (const s of src.sessions) {
    if (!OWN_SESSION.test(s.id) || s.archived || now - s.updatedAt > 72 * HOUR) continue;
    const last = src.messages(s.id).filter((m) => m.role !== "system").at(-1);
    if (!last || last.role !== "assistant" || last.from !== s.botId) continue;
    const age = now - last.createdAt;
    const blocks = Array.isArray(last.content) ? last.content : [];
    const choice = blocks.find((b) => b.type === "choice" && !b.answer);
    if (choice && choice.type === "choice" && age > 2 * HOUR) {
      out.push({ key: `choice:${s.id}:${last.createdAt}`, kind: "choice", botId: s.botId, sessionId: s.id, at: last.createdAt, fact: `在会话「${s.title}」里给用户出了选择题「${choice.question}」（选项：${choice.options.join(" / ")}），用户还没选，事情停在这里` });
      continue;
    }
    const text = contentText(last.content).trim();
    const tailText = text.slice(-200);
    if (age > 3 * HOUR && OFFER_RE.test(tailText)) {
      out.push({ key: `offer:${s.id}:${last.createdAt}`, kind: "offer", botId: s.botId, sessionId: s.id, at: last.createdAt, fact: `在会话「${s.title}」里最后说的是「${tailText.replace(/\s+/g, " ")}」，用户之后没有回复` });
    }
  }
  for (const p of src.plans) {
    if (p.status !== "error" || !p.finishedAt || now - p.finishedAt > 24 * HOUR) continue;
    const bad = p.stages.find((st) => st.status === "error");
    if (bad?.error === "已取消") continue;
    out.push({ key: `plan:${p.id}:${p.finishedAt}`, kind: "plan", botId: src.masterId ?? "", at: p.finishedAt, fact: `编排「${p.title}」没跑完${bad ? `，卡在「${src.nameOf?.(bad.botId) ?? bad.botId}」那一步：${(bad.error ?? "").slice(0, 80)}` : ""}，之后没有重跑` });
  }
  for (const t of src.tasks) {
    if (!t.enabled || !t.lastError || !t.lastRunAt || now - t.lastRunAt > 24 * HOUR) continue;
    out.push({ key: `task:${t.id}:${t.lastRunAt}`, kind: "task", botId: t.botId, at: t.lastRunAt, fact: `定时任务「${t.name}」上次运行失败：${t.lastError.slice(0, 100)}` });
  }
  return out.sort((a, b) => b.at - a.at);
}

export interface ProactiveDeps {
  collect: () => ProactiveSignal[];
  /** 用户最后一次发消息的时间 */
  lastUserActivity: () => number;
  /** 把一件事写成一句自然的跟进话（失败返回 null 就不打扰） */
  phrase: (sig: ProactiveSignal) => Promise<string | null>;
  deliver: (sig: ProactiveSignal, text: string) => void;
  now?: () => number;
  /** 动态空闲阈值（与 prefs.pet.idleMinutes 对齐） */
  idleMs?: () => number;
}

export interface ProactiveOptions {
  maxPerDay?: number;
  /** 用户这么久没动静才跟进，避免打断正在进行的对话 */
  idleMs?: number;
  /** 两次跟进的最短间隔 */
  gapMs?: number;
  /** 只在这些钟点里打扰 [起, 止) */
  hours?: [number, number];
}

/**
 * 主动智能：定时检查悬而未决的事，挑最新的一件，在用户空闲、白天、没超每日上限时跟进一次。
 * 每件事只提一次（记在 proactive.json），用户不理也不会反复催。
 */
export class ProactiveEngine {
  private file: string;
  private state: { sent: Record<string, number> };
  private o: Required<ProactiveOptions>;
  private busy = false;

  constructor(home: string, private deps: ProactiveDeps, opts: ProactiveOptions = {}) {
    this.file = join(home, "proactive.json");
    this.state = readJsonSafe(this.file, { sent: {} as Record<string, number> });
    this.o = { maxPerDay: opts.maxPerDay ?? 3, idleMs: opts.idleMs ?? 30 * 60_000, gapMs: opts.gapMs ?? 2 * HOUR, hours: opts.hours ?? [9, 22] };
  }

  /** 返回这次跟进的事（没跟进返回 null） */
  async tick(): Promise<ProactiveSignal | null> {
    if (this.busy) return null;
    const now = this.deps.now?.() ?? Date.now();
    const hour = new Date(now).getHours();
    if (hour < this.o.hours[0] || hour >= this.o.hours[1]) return null;
    const idleMs = this.deps.idleMs?.() ?? this.o.idleMs;
    if (now - this.deps.lastUserActivity() < idleMs) return null;
    const times = Object.values(this.state.sent);
    if (times.filter((t) => now - t < 24 * HOUR).length >= this.o.maxPerDay) return null;
    if (times.some((t) => now - t < this.o.gapMs)) return null;
    const sig = this.deps.collect().find((s) => !(s.key in this.state.sent) && s.botId);
    if (!sig) return null;
    this.busy = true;
    try {
      const text = await this.deps.phrase(sig);
      this.state.sent[sig.key] = now;
      for (const [k, t] of Object.entries(this.state.sent)) if (now - t > 14 * 24 * HOUR) delete this.state.sent[k];
      writeJsonAtomic(this.file, this.state);
      if (!text?.trim()) return null;
      this.deps.deliver(sig, text.trim());
      return sig;
    } finally {
      this.busy = false;
    }
  }
}
