import type { Bot } from "./types";

export const GROUP_END_MARK = "【讨论结束】";
export const GROUP_MAX_TURNS = 12;

/**
 * 回复里点名了谁：「@名字」「→ 名字」「名字：」开头的段落；「主控」指主控 bot。
 * 按首次出现的顺序返回 bot id，不含说话人自己。
 */
export function addressedBots(text: string, bots: Bot[], selfId: string): string[] {
  const hits: { id: string; at: number }[] = [];
  const byLongest = [...bots].sort((a, b) => b.name.length - a.name.length);
  const master = bots.find((b) => b.isMaster);
  const patterns = (name: string) => [
    new RegExp(`@${escapeRe(name)}`, "g"),
    new RegExp(`(?:→|->|➡️?)\\s*\\**${escapeRe(name)}`, "g"),
    new RegExp(`(?:^|\\n)\\s*\\**${escapeRe(name)}\\**\\s*[：:]`, "g"),
  ];
  const taken: [number, number][] = [];
  const overlaps = (s: number, e: number) => taken.some(([a, b]) => s < b && e > a);
  for (const b of byLongest) {
    for (const re of patterns(b.name)) {
      for (const m of text.matchAll(re)) {
        const s = m.index ?? 0, e = s + m[0].length;
        if (overlaps(s, e)) continue;
        taken.push([s, e]);
        hits.push({ id: b.id, at: s });
      }
    }
  }
  if (master) {
    for (const m of text.matchAll(/(?:@|→|->)\s*\**主控|(?:^|\n)\s*\**主控\**\s*[：:]/g)) hits.push({ id: master.id, at: m.index ?? 0 });
  }
  const out: string[] = [];
  for (const h of hits.sort((a, b) => a.at - b.at)) if (h.id !== selfId && !out.includes(h.id)) out.push(h.id);
  return out;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type RelayReason = "quiet" | "ended" | "limit" | "stopped";
export interface RelayItem { id: string; by: string | null; note?: string }

/**
 * 群聊接力：成员先按顺序各说一轮；之后谁被点名谁接话（不在群里的 bot 被点名也会被叫进来），
 * 直到没人被点名、有人宣布【讨论结束】、用户停止，或达到轮数上限。
 * - 「一轮」= 上一轮里被点到的所有人；轮与轮之间回调 onRoundEnd（主持人小结）
 * - inbox：用户中途插话，插到队首，被 @ 的人（没 @ 就是 fallback）优先回应
 * - relay=false：只回应用户（首轮 + 插话），不自动接力
 */
export async function runGroupRelay(opts: {
  members: string[];
  /** 用户点名了谁就从谁开始（不再全员轮一遍）；空 = 全员按顺序 */
  start?: string[];
  bots: Bot[];
  maxTurns?: number;
  relay?: boolean;
  aborted: () => boolean;
  reply: (botId: string, turn: number, calledBy: string | null, note?: string) => Promise<string>;
  inbox?: () => { text: string; targets: string[] }[];
  /** 插话没 @ 人时由谁回应 */
  fallback?: string;
  onTurn?: (info: { turn: number; speaker: string; next: string[]; round: number }) => void;
  onRoundEnd?: (round: number, turns: number) => Promise<void>;
}): Promise<{ turns: number; rounds: number; reason: RelayReason }> {
  const max = opts.maxTurns ?? GROUP_MAX_TURNS;
  const relay = opts.relay !== false;
  const known = new Set(opts.bots.map((b) => b.id));
  const first = opts.start?.length ? opts.start : opts.members;
  let queue: RelayItem[] = first.filter((id) => known.has(id)).map((id) => ({ id, by: null }));
  let roundLeft = queue.length;
  let round = 1;
  let turns = 0;
  // 宣布结束后：这条里点到的人还会回一句，但不再接新的点名
  let ending = false;
  const drainInbox = () => {
    const items = opts.inbox?.() ?? [];
    for (const it of items.reverse()) {
      const targets = (it.targets.length ? it.targets : [opts.fallback ?? opts.members[0]]).filter((id) => known.has(id));
      const before = queue.length;
      queue = [...targets.map((id) => ({ id, by: "user", note: it.text })), ...queue.filter((q) => !targets.includes(q.id))];
      roundLeft += queue.length - before;
      ending = false;
    }
  };
  for (;;) {
    drainInbox();
    if (!queue.length) break;
    if (opts.aborted()) return { turns, rounds: round, reason: "stopped" };
    if (turns >= max) return { turns, rounds: round, reason: "limit" };
    const item = queue.shift()!;
    roundLeft--;
    opts.onTurn?.({ turn: turns, speaker: item.id, next: queue.map((q) => q.id), round });
    const text = await opts.reply(item.id, turns, item.by, item.note);
    turns++;
    if (!ending && relay) {
      for (const next of addressedBots(text, opts.bots, item.id)) {
        if (!queue.some((q) => q.id === next)) queue.push({ id: next, by: item.id });
      }
    }
    if (!ending && text.includes(GROUP_END_MARK)) {
      ending = true;
      const pinged = new Set(relay ? addressedBots(text, opts.bots, item.id) : []);
      queue = queue.filter((q) => pinged.has(q.id) || q.by === "user");
      roundLeft = Math.min(roundLeft, queue.length);
    }
    if (roundLeft <= 0 && queue.length && !ending && !opts.aborted() && turns < max) {
      await opts.onRoundEnd?.(round, turns);
      round++;
      roundLeft = queue.length;
    }
  }
  if (opts.aborted()) return { turns, rounds: round, reason: "stopped" };
  return { turns, rounds: round, reason: ending ? "ended" : "quiet" };
}

export const RELAY_REASON_TEXT: Record<RelayReason, string> = {
  quiet: "没有人再被点名",
  ended: "有人宣布讨论结束",
  limit: "达到接力轮数上限",
  stopped: "你停止了接力",
};
