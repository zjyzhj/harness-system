import { estimateTokens } from "./store";
import { contentText, type ChatMessage } from "./types";

/**
 * G1 上下文预算：估算历史 token，超预算时把最旧段压缩为 summary。
 * 设计对齐 CowAgent/deepseek 的 compaction：
 * - 预算 B（默认 8000 token，user 侧）
 * - 超过 B 时，压缩「未压缩的最旧 30% 段」→ 1 条 summary
 * - 用 Session.lastSeq 记录已压缩边界，避免重复压缩
 */

export interface BudgetOptions {
  budgetTokens?: number;      // 总预算（默认 8000）
  systemTokens?: number;      // system 占用的 token（估算用，默认 800）
  compressRatio?: number;     // 每次压缩最旧的多少比例（默认 0.3）
  /** 上次压缩留下的摘要：会作为最前面的 system 消息，并在下次压缩时与新段合并 */
  prevSummary?: string;
}

export interface TrimResult {
  /** 裁剪后保留给模型的历史（摘要 + 近窗） */
  messages: { role: string; content: string }[];
  /** 本次新增压缩的边界 seq（供 store.markCompacted） */
  compactedUpToSeq: number;
  /** 是否发生压缩 */
  compressed: boolean;
  /** 压缩后的累计摘要（含 prevSummary） */
  summaryText?: string;
}

type Turn = { role: string; content: string };
const toTurn = (m: ChatMessage): Turn => ({ role: m.role === "assistant" ? "assistant" : "user", content: contentText(m.content) });
const summaryTurn = (text: string): Turn => ({ role: "system", content: `【历史摘要】\n${text}` });

/**
 * 裁剪历史到预算内。
 * history 需带 (msg as any).id（seq）；lastSeq 之前的消息已被 prevSummary 概括，不再原样发送。
 */
export function trimHistoryToBudget(
  history: ChatMessage[],
  lastSeq: number,
  /** 返回空或 null 表示摘要失败：这次只临时截掉最旧的消息，不推进压缩边界、不改已有摘要 */
  summarize: (msgs: Turn[]) => Promise<string | null> | string | null,
  opts?: BudgetOptions,
): Promise<TrimResult> {
  const budget = opts?.budgetTokens ?? 8000;
  const systemTokens = opts?.systemTokens ?? 800;
  const ratio = opts?.compressRatio ?? 0.3;
  const prev = opts?.prevSummary?.trim() || "";
  const seqId = (m: ChatMessage) => (m as any).id ?? 0;

  const live = history.filter((m) => seqId(m) > lastSeq);
  const head = prev ? [summaryTurn(prev)] : [];
  const total = live.reduce((n, m) => n + estimateTokens(m.content), 0) + estimateTokens(prev);
  if (total + systemTokens <= budget) {
    return Promise.resolve({ messages: [...head, ...live.map(toTurn)], compactedUpToSeq: lastSeq, compressed: false, summaryText: prev || undefined });
  }

  const take = Math.floor(live.length * ratio);
  const segment = live.slice(0, Math.max(take, live.length > 1 ? 1 : 0));
  const fitTail = (): TrimResult => {
    let room = budget - systemTokens - estimateTokens(prev);
    const keep: ChatMessage[] = [];
    for (let i = live.length - 1; i >= 0; i--) {
      room -= estimateTokens(live[i].content);
      if (room < 0 && keep.length) break;
      keep.unshift(live[i]);
    }
    return { messages: [...head, ...keep.map(toTurn)], compactedUpToSeq: lastSeq, compressed: false, summaryText: prev || undefined };
  };
  if (!segment.length) return Promise.resolve(fitTail());

  const input = [...(prev ? [{ role: "system", content: `已有摘要：${prev}` }] : []), ...segment.map(toTurn)];
  return Promise.resolve().then(() => summarize(input)).catch(() => null).then((raw) => {
    const summaryText = raw?.trim();
    if (!summaryText) return fitTail();
    const boundary = Math.max(...segment.map(seqId));
    const rest = live.filter((m) => seqId(m) > boundary);
    return { messages: [summaryTurn(summaryText), ...rest.map(toTurn)], compactedUpToSeq: boundary, compressed: true, summaryText };
  });
}
