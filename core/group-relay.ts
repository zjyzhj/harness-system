import type { Bot } from "./types";

export const GROUP_END_MARK = "【讨论结束】";
export const GROUP_MAX_TURNS = 12;
export const GROUP_MAX_MEMBERS = 6;

/**
 * 群聊底层：一间共用的聊天室。
 * - 谁先开口：调用方传入 start（用户 @ / 【交给】点到的人；没点名通常只让主持人先说）。
 * - 谁接着说：刚才那句里点到的人（同样认 @ / → / 【交给】 / @everyone）。
 * - 什么时候停：没人再被点到、有人写【讨论结束】、你点了停止，或碰到硬顶。
 * - 一轮小结：这一轮至少两个人说过才回调 onRoundEnd。
 * 硬顶只防互相点名说不停。点了几个人不缩短这段能说几次。
 */

/** 群设置里的硬顶，夹在 1～40。 */
export function relayCeiling(ceiling: number): number {
  return Math.max(1, Math.min(40, ceiling || GROUP_MAX_TURNS));
}

/**
 * 这一段能说几次 = 硬顶。
 * 停住后再开口：已经用完就再给一段硬顶；没用完就沿用原来的上限。
 */
export function stretchLimit(held: { turns: number; maxTurns: number } | undefined, ceiling: number): number {
  const slice = relayCeiling(ceiling);
  if (!held) return slice;
  if (held.turns >= held.maxTurns) return held.turns + slice;
  return held.maxTurns;
}

/** 文中出现了哪些人。长名字先占住自己的字，不含说话人自己。「主控」指主控 bot。 */
export function mentionedBots(text: string, bots: Bot[], selfId = ""): Bot[] {
  const hits: { bot: Bot; at: number }[] = [];
  const taken: [number, number][] = [];
  const overlaps = (s: number, e: number) => taken.some(([a, b]) => s < b && e > a);
  const claim = (bot: Bot, key: string) => {
    if (!key || bot.id === selfId) return;
    let from = 0;
    while (from < text.length) {
      const at = text.indexOf(key, from);
      if (at < 0) break;
      const end = at + key.length;
      if (!overlaps(at, end)) {
        taken.push([at, end]);
        hits.push({ bot, at });
      }
      from = end;
    }
  };
  for (const b of [...bots].sort((a, b) => b.name.length - a.name.length)) claim(b, b.name);
  const master = bots.find((b) => b.isMaster);
  if (master && !bots.some((b) => b.name === "主控")) claim(master, "主控");
  const out: Bot[] = [];
  for (const h of hits.sort((a, b) => a.at - b.at)) if (!out.some((b) => b.id === h.bot.id)) out.push(h.bot);
  return out;
}

/**
 * 写明了要交给谁：`@名字`、`→ 名字`、段首「名字：」，以及「【交给】名字」。
 * `@everyone` / `@所有人` / `【交给】全员` 在提供 room 时叫满房间里除自己以外的人。
 * 「请/让/叫」「你看一下」这种说法不在这里认，交给 resolveAddressed 判断。
 * 按首次出现的顺序返回 bot id，不含说话人自己。
 */
export function addressedBots(text: string, bots: Bot[], selfId: string, room?: string[]): string[] {
  const hits: { id: string; at: number }[] = [];
  const patterns = (name: string) => {
    const n = escapeRe(name);
    return [
      new RegExp(`@${n}`, "g"),
      new RegExp(`(?:→|->|➡️?)\\s*\\**${n}`, "g"),
      new RegExp(`(?:^|\\n)\\s*\\**${n}\\**\\s*[：:]`, "g"),
    ];
  };
  const taken: [number, number][] = [];
  const overlaps = (s: number, e: number) => taken.some(([a, b]) => s < b && e > a);
  for (const b of [...bots].sort((a, b) => b.name.length - a.name.length)) {
    for (const re of patterns(b.name)) {
      for (const m of text.matchAll(re)) {
        const s = m.index ?? 0, e = s + m[0].length;
        if (overlaps(s, e) || b.id === selfId) continue;
        taken.push([s, e]);
        hits.push({ id: b.id, at: s });
      }
    }
  }
  const master = bots.find((b) => b.isMaster);
  if (master && master.id !== selfId) {
    for (const m of text.matchAll(/(?:@|→|->)\s*\**主控|(?:^|\n)\s*\**主控\**\s*[：:]/g)) hits.push({ id: master.id, at: m.index ?? 0 });
  }
  for (const block of text.matchAll(/【交给】([^\n【]*)/g)) {
    const body = block[1] ?? "";
    const base = block.index ?? 0;
    if (room?.length && /^(?:全员|所有人|everyone)\s*$/i.test(body.trim())) {
      for (const id of room) if (id !== selfId) hits.push({ id, at: base });
      continue;
    }
    let cursor = 0;
    for (const b of mentionedBots(body, bots, selfId)) {
      const key = body.includes(b.name) ? b.name : "主控";
      const rel = body.indexOf(key, cursor);
      hits.push({ id: b.id, at: base + (rel < 0 ? 0 : rel) });
      if (rel >= 0) cursor = rel + key.length;
    }
  }
  if (room?.length) {
    for (const m of text.matchAll(/@(?:everyone\b|所有人|全员)/gi)) {
      const at = m.index ?? 0;
      for (const id of room) if (id !== selfId) hits.push({ id, at });
    }
  }
  const out: string[] = [];
  for (const h of hits.sort((a, b) => a.at - b.at)) if (h.id !== selfId && !out.includes(h.id)) out.push(h.id);
  return out;
}

/**
 * 这句在叫谁接话。
 * 有「【交给】」就信这行（「无」就是没人），不再猜测。
 * 没有这行、但出现了人名，才问一次 judge。判断失败就只保留 @ / → / 段首名字。
 * 一个名字都没有，就没人接。
 */
export async function resolveAddressed(
  text: string,
  bots: Bot[],
  selfId: string,
  judge?: (text: string, candidates: Bot[]) => Promise<string[]>,
  room?: string[],
): Promise<string[]> {
  const explicit = addressedBots(text, bots, selfId, room);
  if (/【交给】/.test(text) || !judge) return explicit;
  const pending = mentionedBots(text, bots, selfId).filter((b) => !explicit.includes(b.id));
  if (!pending.length) return explicit;
  try {
    const judged = await judge(text, pending);
    const allowed = new Set(pending.map((b) => b.id));
    const merged = [...explicit];
    for (const id of judged) if (allowed.has(id) && id !== selfId && !merged.includes(id)) merged.push(id);
    const at = (id: string) => {
      const bot = bots.find((b) => b.id === id);
      const nameAt = bot ? text.indexOf(bot.name) : -1;
      if (nameAt >= 0) return nameAt;
      return bot?.isMaster ? text.indexOf("主控") : -1;
    };
    return merged.sort((a, b) => (at(a) < 0 ? 1e9 : at(a)) - (at(b) < 0 ? 1e9 : at(b)));
  } catch {
    return explicit;
  }
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const DECISION_EMPTY = /^(?:无|没有|暂无|还没有|无新事项|暂无新事项|没什么|暂无事项)$/;

function keepDecision(raw: string): string | null {
  const t = raw.trim().replace(/[。．.]+$/, "");
  if (!t || DECISION_EMPTY.test(t)) return null;
  return t;
}

/** 从发言里收下已经定下来的事。「写作助手的表格」这种提及不算。 */
export function collectDecisions(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\n/)) {
    const m = line.trim().match(/^(?:定了|决定|已定|达成)[：:]\s*(.+)$/);
    const kept = m?.[1] ? keepDecision(m[1]) : null;
    if (kept) out.push(kept);
  }
  for (const block of text.matchAll(/【已定】([^\n【]+)/g)) {
    for (const part of block[1].split(/[；;]/)) {
      const kept = keepDecision(part);
      if (kept) out.push(kept);
    }
  }
  return [...new Set(out)];
}

/** 「取消：原来的那句」把板上对应的一条拿掉。 */
export function collectRetractions(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\n/)) {
    const m = line.trim().match(/^取消[：:]\s*(.+)$/);
    if (!m?.[1]) continue;
    for (const part of m[1].split(/[；;]/)) {
      const t = part.trim().replace(/[。．.]+$/, "");
      if (t) out.push(t);
    }
  }
  return [...new Set(out)];
}

export type RelayReason = "quiet" | "ended" | "limit" | "stopped";
/** 接力停在哪。queue 里第一个是下一个该开口的人 */
export interface RelayCursor {
  queue: RelayItem[];
  roundLeft: number;
  round: number;
  turns: number;
  ending: boolean;
}
export interface RelayItem {
  id: string;
  by: string | null;
  note?: string;
  /** 这轮是被点名拉进来的。不在群里也可以说这一句 */
  invited?: boolean;
}

/**
 * 群聊接力（房间里的一轮发言）。
 * 点了名就从这些人开始；没点名由调用方传入 opener（通常是主持人），勿默认全员齐声。
 * 之后谁被点名谁接话（群外 bot 被点名也会被叫进来），
 * 直到没人被点到、有人宣布【讨论结束】、你停止，或碰到硬顶。
 * - 「一轮」= 上一轮里被点到的所有人；轮与轮之间回调 onRoundEnd（主持人小结）
 * - inbox：中途插话插到队首；被 @ 的人先回应，没 @ 就由 fallback 回应
 * - relay=false：只回应用户（首轮 + 插话），不跟着点名走
 * - oneShot：首轮说完后不再跟交接（例如没点名时回一句就停）
 */
export async function runGroupRelay(opts: {
  members: string[];
  /**
   * 谁先开口。
   * - 传入数组（可空）：严格按数组，空 = 没人说（不会回落成全员）
   * - 不传 / undefined：兼容旧调用 = 成员按顺序（仅 resume 外的遗留路径）
   */
  start?: string[];
  bots: Bot[];
  maxTurns?: number;
  /** 关了就不再跟着点名走。传函数时每轮现读，中途改设置会在下一句生效 */
  relay?: boolean | (() => boolean);
  /** 首轮队列说完后强制结束，忽略发言里的交接 */
  oneShot?: boolean;
  aborted: () => boolean;
  /** 这一句还该不该说。人已经不在群里、bot 已经删了，就跳过；被点名拉进来的由调用方放行 */
  canSpeak?: (item: RelayItem) => boolean;
  reply: (botId: string, turn: number, calledBy: string | null, note?: string) => Promise<string>;
  inbox?: () => { text: string; targets: string[]; from?: string; explicit?: boolean }[];
  /** 接着上次停住的队列说，不再从头轮一遍 */
  resume?: RelayCursor;
  /** 每句开口前记下队列，进程关掉后还能从这句话接着说 */
  onCheckpoint?: (cursor: RelayCursor) => void;
  /** 插话没点名时由谁回应 */
  fallback?: string;
  /** 这句回复要交给谁。不传就只认 @ / → / 【交给】 */
  whoNext?: (text: string, selfId: string) => Promise<string[]>;
  onTurn?: (info: { turn: number; speaker: string; next: string[]; round: number }) => void;
  onRoundEnd?: (round: number, turns: number) => Promise<void>;
}): Promise<{ turns: number; rounds: number; reason: RelayReason }> {
  const max = opts.maxTurns ?? GROUP_MAX_TURNS;
  const relayOn = () => (typeof opts.relay === "function" ? opts.relay() : opts.relay !== false);
  const known = new Set(opts.bots.map((b) => b.id));
  const members = new Set(opts.members);
  // 显式传入 start（含 []）时绝不回落成全员；只有完全不传才用成员列表（旧兼容）
  const first = opts.resume ? [] : (opts.start !== undefined ? opts.start : opts.members);
  let queue: RelayItem[] = opts.resume
    ? opts.resume.queue.filter((q) => known.has(q.id)).map((q) => ({ ...q }))
    : first.filter((id) => known.has(id)).map((id) => ({ id, by: null, invited: !members.has(id) }));
  let roundLeft = opts.resume ? Math.min(opts.resume.roundLeft, queue.length) : queue.length;
  let round = opts.resume?.round ?? 1;
  let turns = opts.resume?.turns ?? 0;
  // 宣布结束后：这条里点到的人还会回一句，但不再接新的点名
  let ending = opts.resume?.ending ?? false;
  let spokenInRound = 0;
  const mark = (extra?: RelayItem) => opts.onCheckpoint?.({
    queue: extra ? [{ ...extra }, ...queue.map((q) => ({ ...q }))] : queue.map((q) => ({ ...q })),
    roundLeft: extra ? roundLeft + 1 : roundLeft,
    round,
    turns,
    ending,
  });
  const drainInbox = () => {
    const items = opts.inbox?.() ?? [];
    if (!items.length) return false;
    for (const it of items.reverse()) {
      const targets = (it.targets.length ? it.targets : [opts.fallback ?? opts.members[0]]).filter((id) => known.has(id));
      const before = queue.length;
      queue = [...targets.map((id) => ({ id, by: it.from ?? "user", note: it.text, invited: !!it.explicit })), ...queue.filter((q) => !targets.includes(q.id))];
      roundLeft += queue.length - before;
      ending = false;
    }
    return true;
  };
  for (;;) {
    if (drainInbox()) mark();
    if (!queue.length) break;
    if (opts.aborted()) return { turns, rounds: round, reason: "stopped" };
    if (turns >= max) return { turns, rounds: round, reason: "limit" };
    const item = queue.shift()!;
    roundLeft--;
    if (opts.canSpeak && !opts.canSpeak(item)) {
      mark();
      continue;
    }
    opts.onTurn?.({ turn: turns, speaker: item.id, next: queue.map((q) => q.id), round });
    mark(item);
    const text = await opts.reply(item.id, turns, item.by, item.note);
    turns++;
    spokenInRound++;
    const nextIds = opts.oneShot
      ? []
      : opts.whoNext ? await opts.whoNext(text, item.id) : addressedBots(text, opts.bots, item.id, opts.members);
    if (!ending && relayOn() && !opts.oneShot) {
      for (const next of nextIds) {
        if (!queue.some((q) => q.id === next)) queue.push({ id: next, by: item.id, invited: true });
      }
    }
    if (opts.oneShot && roundLeft <= 0 && !queue.length) ending = true;
    if (!ending && text.includes(GROUP_END_MARK)) {
      ending = true;
      const pinged = new Set(relayOn() && !opts.oneShot ? nextIds : []);
      queue = queue.filter((q) => pinged.has(q.id) || q.by === "user");
      roundLeft = Math.min(roundLeft, queue.length);
    }
    // 这一轮至少两个人说过，才写主持人小结；一个人说完就交接的不打扰
    if (roundLeft <= 0 && queue.length && !ending && !opts.aborted() && turns < max) {
      if (spokenInRound >= 2) await opts.onRoundEnd?.(round, turns);
      round++;
      spokenInRound = 0;
      roundLeft = queue.length;
    }
    mark();
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
