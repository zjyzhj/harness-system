/**
 * 编码工作线：按 bot + 工程目录记住进度和各家 CLI 的会话号。
 * 不挂在某次聊天上。新会话不清。换 CLI 时旧会话号留着，切回去还能续。
 */
import { join } from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./atomic-fs";

export type AgentResumePref = "auto" | "always" | "once";

export interface CodingThread {
  botId: string;
  cwd: string;
  /** 最近一次实质性任务，供聊天短摘要 */
  goal: string;
  /** CLI 输出尾部，不另开模型总结 */
  lastSummary: string;
  updatedAt: number;
  /** cli id → 我们记下的会话号。不用「最近一次」。 */
  sessions: Record<string, string>;
}

const STUB_MAX = 400;
const BRIEF_MAX = 4096;
const SUMMARY_MAX = 1500;

export class CodingThreadStore {
  private file: string;
  private threads: CodingThread[] = [];

  constructor(home: string) {
    this.file = join(home, "coding-threads.json");
    const raw = readJsonSafe<CodingThread[]>(this.file, []);
    this.threads = Array.isArray(raw) ? raw.filter((t) => t?.botId && t?.cwd) : [];
  }

  get(botId: string, cwd: string): CodingThread | undefined {
    return this.threads.find((t) => t.botId === botId && t.cwd === cwd);
  }

  save(thread: CodingThread): CodingThread {
    const next = { ...thread, sessions: { ...thread.sessions }, updatedAt: Date.now() };
    const i = this.threads.findIndex((t) => t.botId === next.botId && t.cwd === next.cwd);
    if (i >= 0) this.threads[i] = next;
    else this.threads.push(next);
    writeJsonAtomic(this.file, this.threads);
    return next;
  }
}

/** 聊天每轮易变上下文：只带短摘要，不进稳定系统提示 */
export function threadStub(thread: CodingThread | undefined): string {
  if (!thread || (!thread.goal && !thread.lastSummary)) return "";
  const body = [
    `【编码工作线】${thread.cwd}`,
    thread.goal ? `目标：${thread.goal}` : "",
    thread.lastSummary ? `上次：${thread.lastSummary}` : "",
  ].filter(Boolean).join("\n");
  return body.length <= STUB_MAX ? body : `${body.slice(0, STUB_MAX - 1)}…`;
}

/** 新开进程时塞进 CLI 提示；续会话时不要带，避免和 CLI 自己的历史重复 */
export function threadBrief(thread: CodingThread | undefined): string {
  if (!thread || (!thread.goal && !thread.lastSummary)) return "";
  const body = [
    thread.goal ? `目标：${thread.goal}` : "",
    thread.lastSummary ? `上次结果：${thread.lastSummary}` : "",
  ].filter(Boolean).join("\n");
  return body.length <= BRIEF_MAX ? body : `${body.slice(0, BRIEF_MAX - 1)}…`;
}

const FRESH_RE = /重新做|从头开始|从头来|另起|新开一条|不要续|别续/;

export function wantsFreshTask(task: string): boolean {
  return FRESH_RE.test(task);
}

/** 有会话号才可能续。once 强制新开；always 忽略「重新做」；auto 遇到重新做则新开。 */
export function shouldResume(opts: { pref?: AgentResumePref; task: string; sessionId?: string }): boolean {
  if (!opts.sessionId) return false;
  if (opts.pref === "once") return false;
  if (opts.pref === "always") return true;
  if (wantsFreshTask(opts.task)) return false;
  return true;
}

export function clipSummary(text: string): string {
  const t = text.trim();
  if (t.length <= SUMMARY_MAX) return t;
  return t.slice(-SUMMARY_MAX);
}

export function nextCodingThread(
  prev: CodingThread | undefined,
  patch: { botId: string; cwd: string; cli: string; task: string; summary: string; sessionId?: string; keepGoal?: boolean },
): CodingThread {
  const sessions = { ...(prev?.sessions ?? {}) };
  if (patch.sessionId) sessions[patch.cli] = patch.sessionId;
  const goal = patch.keepGoal && prev?.goal ? prev.goal : patch.task.trim().slice(0, 280);
  return {
    botId: patch.botId,
    cwd: patch.cwd,
    goal: goal || prev?.goal || "",
    lastSummary: clipSummary(patch.summary),
    updatedAt: Date.now(),
    sessions,
  };
}

const RESUME_MISSING_RE = /no conversation found|could not resume|chat not found|no such session|session .{0,80}not found|thread .{0,80}not found|resume failed|no saved session/i;

export interface ParsedAgentOutput {
  text: string;
  sessionId?: string;
  resumeMissing: boolean;
}

/** 从 text / json / jsonl 里抽出给人看的正文和会话号 */
export function parseAgentOutput(raw: string, exitCode: number): ParsedAgentOutput {
  const resumeMissing = exitCode !== 0 && RESUME_MISSING_RE.test(raw);
  const lines = raw.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const chunks = lines.length > 1 && lines.every((l) => l.startsWith("{")) ? lines : [raw.trim()];
  const ids: string[] = [];
  const texts: string[] = [];
  for (const chunk of chunks) {
    if (!chunk.startsWith("{")) continue;
    try {
      const j = JSON.parse(chunk) as Record<string, unknown>;
      const id = firstString(j, ["session_id", "sessionId", "chatId", "chat_id", "thread_id", "threadId"]);
      if (id) ids.push(id);
      if (typeof j.result === "string") texts.push(j.result);
      const item = j.item as { type?: string; text?: string } | undefined;
      if (j.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") texts.push(item.text);
    } catch {
      /* 不是 json */
    }
  }
  return {
    text: texts.length ? texts.join("\n") : raw.trim(),
    sessionId: ids.at(-1),
    resumeMissing,
  };
}

function firstString(j: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = j[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}
