/**
 * 例行结果落到 bot 对话（对齐 Grok Routines in transcript）。
 * 执行仍在 sched-* 会话；对用户可见的是单聊 transcript。
 */

/** 可否把例行结果帖进该会话（排除群 / bot 间 / 内部调度会话） */
export function canPostRoutineToSession(sid: string): boolean {
  if (!sid) return false;
  if (sid.startsWith("group-") || sid.startsWith("b2b-")) return false;
  if (/^(plan|sched|wh)-/.test(sid)) return false;
  return true;
}

/**
 * 挑选例行结果应写入的会话：
 * 钉死的 task.sessionId → 当前注视会话 → 最近一条可用单聊。
 * 都没有则返回 null（调用方再 ensure 新会话）。
 */
export function pickRoutineTranscriptSessionId(args: {
  pinned?: string | null;
  gazed?: string | null;
  sessionExists: (id: string) => boolean;
  /** 已按 updatedAt 降序 */
  recentSessions: { id: string }[];
}): string | null {
  const tryOne = (id?: string | null): string | null =>
    id && canPostRoutineToSession(id) && args.sessionExists(id) ? id : null;
  return (
    tryOne(args.pinned) ??
    tryOne(args.gazed) ??
    (args.recentSessions.find((s) => canPostRoutineToSession(s.id))?.id ?? null)
  );
}
