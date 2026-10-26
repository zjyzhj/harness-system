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
}

export interface TrimResult {
  /** 裁剪后保留给模型的历史（近窗 + summary 占位） */
  messages: { role: string; content: string }[];
  /** 本次新增压缩的边界 seq（供 store.markCompacted） */
  compactedUpToSeq: number;
  /** 是否发生压缩 */
  compressed: boolean;
  summaryText?: string;
}

/**
 * 裁剪历史到预算内。
 * history 需带 (msg as any).id（seq）；已压缩边界 lastSeq 之前的消息不再压缩。
 */
export function trimHistoryToBudget(
  history: ChatMessage[],
  lastSeq: number,
  summarize: (msgs: { role: string; content: string }[]) => Promise<string> | string,
  opts?: BudgetOptions,
): Promise<TrimResult> {
  const budget = opts?.budgetTokens ?? 8000;
  const systemTokens = opts?.systemTokens ?? 800;
  const ratio = opts?.compressRatio ?? 0.3;
  const seqId = (m: ChatMessage) => (m as any).id ?? 0;

  const total = history.reduce((n, m) => n + estimateTokens(m.content), 0);
  if (total + systemTokens <= budget) {
    return Promise.resolve({
      messages: history.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: contentText(m.content) })),
      compactedUpToSeq: lastSeq,
      compressed: false,
    });
  }

  // 找未压缩的最旧段（seq > lastSeq 的最旧 30%）
  const unCompacted = history.filter((m) => seqId(m) > lastSeq);
  const take = Math.max(1, Math.floor(unCompacted.length * ratio));
  const segment = unCompacted.slice(0, take);
  if (!segment.length) {
    // 没有可压缩段（都已压缩）→ 退化为截断近窗
    const keep = history.slice(-Math.floor(budget / 40));
    return Promise.resolve({
      messages: keep.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: contentText(m.content) })),
      compactedUpToSeq: lastSeq,
      compressed: false,
    });
  }

  const segMsgs = segment.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: contentText(m.content) }));
  const summary = summarize(segMsgs);
  return Promise.resolve(summary).then((summaryText) => {
    const boundary = Math.max(...segment.map(seqId));
    const rest = history.filter((m) => seqId(m) > boundary);
    const msgs = [
      { role: "system" as const, content: `【历史摘要】（已压缩 ${take} 条旧消息）\n${summaryText}` },
      ...rest.map((m) => ({ role: m.role === "assistant" ? "assistant" as const : "user" as const, content: contentText(m.content) })),
    ];
    return { messages: msgs, compactedUpToSeq: boundary, compressed: true, summaryText };
  });
}
