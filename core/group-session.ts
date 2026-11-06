/**
 * 群聊会话 — 一间房里可以有多段对话。
 * 一段对话同时只有一轮接力。换到另一段不停掉这段；同一段再发一句是插话。
 * 底层规则：点名决定谁先说，交接决定谁接着说，硬顶防说不停。不按「简单/复杂」另开一轮模型判断。
 * 不依赖 Electron；UI 推送 / 状态点通过 hooks 注入。
 */
import { join } from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./atomic-fs";
import { contentText, type Bot, type ContentBlock, type MessageMeta } from "./types";
import type { Store } from "./store";
import type { BotRuntime } from "./bot-runtime";
import type { ProviderCenter } from "./provider-center";
import type { Group, GroupRegistry } from "./group-registry";
import { collectDecisions, collectRetractions, GROUP_END_MARK, mentionedBots, RELAY_REASON_TEXT, relayCeiling, resolveAddressed, runGroupRelay, stretchLimit, type RelayCursor, type RelayReason } from "./group-relay";

export interface GroupProgress {
  sessionId: string;
  groupId: string;
  state: string;
  /** 本段已经说了几次（相对硬顶） */
  turn?: number;
  /** 本段硬顶 */
  max?: number;
  /** 这段接力累计说过几次 */
  total?: number;
  speaker?: string;
  next?: string[];
  round?: number;
  reason?: string;
  dispatch?: boolean;
  board?: string[];
}

export interface GroupSessionHooks {
  onProgress: (p: GroupProgress) => void;
  onStream: (ev: { sessionId: string; botId: string; turn: number | string; block: ContentBlock }) => void;
  setRunning: (botId: string, sessionId: string, task: string) => void;
  setIdle: (botId: string) => void;
  /** 全局 / 项目指令 */
  extraSystem?: string;
  signal?: AbortSignal;
}

export interface GroupSessionDeps {
  store: Store;
  groups: GroupRegistry;
  runtime: BotRuntime;
  providers: ProviderCenter;
}

interface PendingLine {
  text: string;
  targets: string[];
  from?: string;
  explicit?: boolean;
}

interface SavedRelay extends RelayCursor {
  sessionId: string;
  groupId: string;
  status: "running" | "paused";
  seedText: string;
  userMsgId: number;
  maxTurns: number;
  /** 还没排进队列的插话。进程在下一句开始前关掉时，靠它接着叫人 */
  pending?: PendingLine[];
}

interface RelayDisk {
  relays: SavedRelay[];
  boards: Record<string, string[]>;
}

export class GroupSessionRunner {
  /** sessionId → 这段对话正在接力时的插话收件箱。有记录 = 这轮还活着 */
  private inbox = new Map<string, PendingLine[]>();
  private relays = new Map<string, SavedRelay>();
  private boards = new Map<string, string[]>();
  private relayFile: string;

  /** 这段对话有没有正在进行的接力 */
  isLive(sessionId: string): boolean {
    return this.inbox.has(sessionId);
  }

  /** 这个群里正在接力的那段对话 */
  liveSession(groupId: string): string | undefined {
    const prefix = `group-${groupId}`;
    for (const sid of this.inbox.keys()) {
      if (sid === prefix || sid.startsWith(`${prefix}-`)) return sid;
    }
    return undefined;
  }

  /** 关掉时停住的接力。发一句就从下一个人接着说 */
  peek(sessionId: string): { turns: number; max: number; next: string[]; board: string[] } | null {
    const held = this.relays.get(sessionId);
    if (!held || held.status !== "paused" || (!held.queue.length && !held.pending?.length)) return null;
    const nameOf = (id: string) => this.deps.store.getBot(id)?.name ?? id;
    const ids = [...held.queue.map((q) => q.id), ...(held.pending ?? []).flatMap((p) => p.targets)];
    return { turns: held.turns, max: held.maxTurns, next: [...new Set(ids)].map(nameOf), board: this.boardOf(sessionId) };
  }

  boardOf(sessionId: string): string[] {
    return [...(this.boards.get(sessionId) ?? [])];
  }

  constructor(private deps: GroupSessionDeps) {
    this.relayFile = join(deps.store.home, "group-relays.json");
    const disk = readJsonSafe<RelayDisk>(this.relayFile, { relays: [], boards: {} });
    for (const [sid, items] of Object.entries(disk.boards ?? {})) this.boards.set(sid, items);
    for (const relay of disk.relays ?? []) {
      if (!relay?.sessionId) continue;
      if (relay.status === "running") relay.status = "paused";
      this.relays.set(relay.sessionId, relay);
    }
    this.persistRelays();
  }

  private persistRelays() {
    const disk: RelayDisk = {
      relays: [...this.relays.values()],
      boards: Object.fromEntries(this.boards),
    };
    writeJsonAtomic(this.relayFile, disk);
  }

  private noteBoard(sessionId: string, items: string[], drop: string[] = []) {
    if (!items.length && !drop.length) return;
    const cur = this.boards.get(sessionId) ?? [];
    const next = cur.filter((x) => !drop.includes(x));
    for (const item of items) if (item && !next.includes(item)) next.push(item);
    const capped = next.slice(-12);
    if (capped.length === cur.length && capped.every((x, i) => x === cur[i])) return;
    this.boards.set(sessionId, capped);
    this.persistRelays();
  }

  private remember(sessionId: string, relay: SavedRelay) {
    const prev = this.relays.get(sessionId);
    const pending = relay.pending !== undefined ? relay.pending : (prev?.pending ?? []);
    const next: SavedRelay = { ...relay };
    if (pending.length) next.pending = pending;
    else delete next.pending;
    this.relays.set(sessionId, next);
    this.persistRelays();
  }

  /** 插话先落盘，再等接力把它排进队列 */
  private notePending(sessionId: string, item: PendingLine) {
    const held = this.relays.get(sessionId);
    if (!held) return;
    this.remember(sessionId, { ...held, pending: [...(held.pending ?? []), item] });
  }

  /** 接力取走插话，并清掉已经排进队列的那份落盘 */
  private takeInbox(sessionId: string): PendingLine[] {
    const items = (this.inbox.get(sessionId) ?? []).splice(0);
    const held = this.relays.get(sessionId);
    if (held && items.length) held.pending = [];
    return items;
  }

  /** 收板上的决定，并把「【已定】」这行从聊天记录里拿掉 */
  private capture(sessionId: string, botId: string, text: string) {
    this.noteBoard(sessionId, collectDecisions(text), collectRetractions(text));
    this.hideDecisionMarks(sessionId, botId);
  }

  private hideDecisionMarks(sessionId: string, botId: string) {
    const last = [...this.deps.store.listMessages(sessionId)].reverse().find((m) => m.from === botId && m.role === "assistant" && m.kind !== "event");
    if (last?.id == null) return;
    const next = withoutDecisionMarks(last.content);
    const same = typeof last.content === "string" ? next === last.content : JSON.stringify(next) === JSON.stringify(last.content);
    if (same) return;
    this.deps.store.updateMessage(sessionId, last.id, (m) => ({ ...m, content: next }));
  }

  /**
   * 轮数到了且还有人没说：停住，不出结论。不再问模型这题算不算答完。
   * 队列空了才算这轮结束。
   */
  private settle(sid: string, groupId: string, r: { turns: number; reason: RelayReason }, hooks: GroupSessionHooks, maxTurns: number, nameOf: (id: string) => string, lead?: string): { paused: boolean } {
    const saved = this.relays.get(sid);
    const total = r.turns;
    const stretchBase = saved ? Math.max(0, (saved.maxTurns ?? maxTurns) - maxTurns) : 0;
    const turn = total - stretchBase;
    const hold = r.reason === "limit" && !!saved?.queue.length;
    if (hold && saved) {
      this.remember(sid, { ...saved, status: "paused" });
      const next = saved.queue.map((q) => nameOf(q.id));
      const who = next.slice(0, 3).join("、");
      this.deps.store.addMessage({
        sessionId: sid, from: "system", to: "user", role: "assistant",
        content: `接力停住了 · 已说 ${total} 次 · 接下来：${who}${next.length > 3 ? "…" : ""} · 发一句话就能让大家继续`,
        kind: "event", createdAt: Date.now(),
      });
      hooks.onProgress({ sessionId: sid, groupId, max: maxTurns, state: "paused", turn, total, next, board: this.boardOf(sid), reason: RELAY_REASON_TEXT.limit });
      return { paused: true };
    }
    this.clearRelay(sid);
    const reasonText = RELAY_REASON_TEXT[r.reason];
    this.deps.store.addMessage({
      sessionId: sid, from: "system", to: "user", role: "assistant",
      content: `${lead ? `${lead} 发起的接力结束` : "接力结束"} · ${total} 次发言 · ${reasonText}`,
      kind: "event", createdAt: Date.now(),
    });
    hooks.onProgress({ sessionId: sid, groupId, max: maxTurns, state: "done", turn, total, reason: reasonText, board: this.boardOf(sid) });
    return { paused: false };
  }

  private clearRelay(sessionId: string) {
    if (!this.relays.delete(sessionId)) return;
    this.persistRelays();
  }

  moderator(g: Group): Bot | null {
    const { store } = this.deps;
    const id = g.settings?.moderator ?? store.listBots().find((b) => b.isMaster && g.members.includes(b.id))?.id;
    return id ? store.getBot(id) ?? null : null;
  }

  /** 接力进行中插话 */
  async interject(groupId: string, sessionId: string, content: string | ContentBlock[]): Promise<{ ok: boolean }> {
    const box = this.inbox.get(sessionId);
    if (!box) return { ok: false };
    const text = contentText(typeof content === "string" ? content : content);
    this.deps.store.addMessage({ sessionId, from: "user", to: groupId, role: "user", content: content as any, kind: "chat", createdAt: Date.now() });
    const targets = await this.who(text, "user", { room: this.deps.groups.get(groupId)?.members });
    const item = { text, targets, explicit: targets.length > 0 };
    box.push(item);
    this.notePending(sessionId, item);
    return { ok: true };
  }

  /**
   * 成员在这段对话还在接力时插一句。不另开一轮，也不动别的对话。
   */
  async speakInto(groupId: string, from: Bot, message: string, sessionId?: string): Promise<{ ok: boolean }> {
    const sid = sessionId || `group-${groupId}`;
    const box = this.inbox.get(sid);
    const g = this.deps.groups.get(groupId);
    if (!box || !g) return { ok: false };
    this.deps.store.addMessage({ sessionId: sid, from: from.id, to: groupId, role: "assistant", content: message, kind: "chat", createdAt: Date.now() });
    const targets = await this.who(message, from.id, { judge: false, room: g.members });
    const others = g.members.filter((id) => id !== from.id);
    const item = { text: message, targets: targets.length ? targets : others, from: from.id, explicit: targets.length > 0 };
    box.push(item);
    this.notePending(sid, item);
    return { ok: true };
  }

  /**
   * 这句在叫谁。
   * 用户开口：有【交给】或 @ 就直接用；只出现人名时才问一次模型。
   * bot 回复交接：只认写明的点名，不再为口语打模型。
   */
  private async who(text: string, selfId: string, opts?: { judge?: boolean; room?: string[] }): Promise<string[]> {
    const bots = this.deps.store.listBots();
    const room = opts?.room;
    const judge = opts?.judge === false ? undefined : (utterance: string, candidates: Bot[]) => this.judgeCall(utterance, candidates);
    return resolveAddressed(text, bots, selfId, judge, room);
  }

  private async judgeCall(text: string, candidates: Bot[]): Promise<string[]> {
    const { providers, store } = this.deps;
    const bound = store.listBots().map((b) => providers.get(b.providerId)).find((p) => p);
    const p = providers.getDefault() ?? bound ?? null;
    if (!p || !candidates.length) return [];
    const timeout = AbortSignal.timeout(15_000);
    try {
      const r = await providers.complete(p, {
        system: `判断这句话在叫谁接话。候选人只有：${candidates.map((b) => b.name).join("、")}。只输出需要接话的人的名字，多个用中文分号隔开。只是提到、没有要对方说话的，只输出「无」。不要解释。`,
        user: text.slice(-2000),
        signal: timeout,
      });
      const said = new Set(mentionedBots(r.text, candidates).map((b) => b.id));
      return candidates.filter((b) => said.has(b.id)).map((b) => b.id);
    } catch {
      return [];
    }
  }

  async chat(groupId: string, content: string | ContentBlock[], sessionId: string | undefined, hooks: GroupSessionHooks) {
    const { store, groups, runtime } = this.deps;
    const g = groups.get(groupId);
    if (!g) throw new Error("群组不存在");
    const sid = sessionId || `group-${groupId}`;
    if (this.inbox.has(sid)) {
      const joined = await this.interject(groupId, sid, content);
      return { ok: joined.ok, sessionId: sid, joined: true, turns: 0, rounds: 0, reason: "quiet" as const, lastText: "", conclusion: null, reasonText: "插进正在进行的接力", groupName: g.name };
    }
    const text = contentText(typeof content === "string" ? content : content);
    store.addMessage({ sessionId: sid, from: "user", to: groupId, role: "user", content: content as any, kind: "chat", createdAt: Date.now() });
    const freshId = store.listMessages(sid).at(-1)?.id ?? 0;
    const held = this.relays.get(sid);
    const resuming = !!held && held.status === "paused" && (held.queue.length > 0 || (held.pending?.length ?? 0) > 0);
    const live = this.inbox.get(sid) ?? [];
    this.inbox.set(sid, live);
    const named = await this.who(text, "user", { room: g.members });
    const extra = live.splice(0);
    const incoming = { text, targets: named, explicit: named.length > 0 };
    if (resuming && named.length === 0 && held!.queue[0]) {
      held!.queue[0] = { ...held!.queue[0], note: text };
      live.push(...(held!.pending ?? []), ...extra);
    } else if (resuming) {
      live.push(...(held!.pending ?? []), incoming, ...extra);
      this.notePending(sid, incoming);
    } else live.push(...extra);
    const seed = resuming ? held!.seedText : text;
    const userMsgId = resuming ? held!.userMsgId : freshId;
    const ceiling = relayCeiling(g.settings?.maxTurns ?? 12);
    const maxTurns = stretchLimit(resuming ? held : undefined, ceiling);
    const stretchBase = Math.max(0, maxTurns - ceiling);
    const nameOf = (id: string) => store.getBot(id)?.name ?? id;
    const mod = this.moderator(g);
    // 按需发言：@ / 【交给】/ @everyone 决定谁开口；没点名只让主持人先说，绝不默认全员齐声
    const openers = named.length
      ? named
      : [mod?.id ?? g.members[0]].filter((id): id is string => !!id);
    const memberNames = g.members.map(nameOf).join("、");
    const outsiders = store.listBots().filter((b) => !g.members.includes(b.id)).map((b) => b.name).join("、");
    const decided = this.boardOf(sid);
    const rules = this.roomRules({
      memberNames,
      outsiders,
      goal: g.settings?.goal,
      decided,
      modName: mod?.name,
    });
    const pinged = resuming ? [] : named;
    let lastText = "";
    const progress = (p: Partial<GroupProgress>) => hooks.onProgress({ sessionId: sid, groupId, max: ceiling, state: "running", board: this.boardOf(sid), ...p });
    const speak = this.speaker(g, sid, userMsgId, hooks);
    if (!resuming) {
      this.remember(sid, { sessionId: sid, groupId, status: "running", queue: [], roundLeft: 0, round: 1, turns: 0, ending: false, seedText: seed, userMsgId, maxTurns });
    }

    try {
      const r = await runGroupRelay({
        members: g.members,
        start: resuming ? undefined : openers,
        resume: resuming ? held! : undefined,
        bots: store.listBots(),
        maxTurns,
        relay: () => this.deps.groups.get(groupId)?.settings?.relay !== false,
        fallback: mod?.id ?? g.members[0],
        aborted: () => !!hooks.signal?.aborted || !this.deps.groups.get(groupId),
        canSpeak: (item) => this.canSpeak(groupId, item),
        inbox: () => this.takeInbox(sid),
        whoNext: (text, selfId) => this.who(text, selfId, { judge: false, room: g.members }),
        onCheckpoint: (cursor) => this.remember(sid, { ...cursor, sessionId: sid, groupId, status: "running", seedText: seed, userMsgId, maxTurns }),
        onTurn: ({ turn, speaker, next, round }) => {
          const total = turn + 1;
          progress({ state: "running", turn: total - stretchBase, total, max: ceiling, round, speaker: nameOf(speaker), next: next.map(nameOf) });
        },
        onRoundEnd: async (round) => {
          const now = this.deps.groups.get(groupId);
          const host = now ? this.moderator(now) : null;
          if (!now || !host || !now.members.includes(host.id)) return;
          progress({ state: "summary", round, speaker: host.name });
          const summary = await speak(host.id, `s${round}`, `[群聊「${now.name}」主持] 你是本群主持人。用 2-4 句话小结刚才第 ${round} 轮讨论：达成了什么共识、还有什么分歧、接下来该谁回应什么。不要 @ 任何人，不要写【交给】，不要调用工具。若有新定下来的事，末尾另起一行写「【已定】事项一；事项二」，没有就写「【已定】无」。这一行只给记录用。${now.settings?.goal ? `群目标：${now.settings.goal}` : ""}`, { meta: { tag: "summary" } });
          this.capture(sid, host.id, summary);
        },
        reply: async (botId, turn, calledBy, note) => {
          const prompt = calledBy === "user"
            ? `[群聊「${g.name}」] 用户中途插话：${note}\n${rules}`
            : note
              ? `[群聊「${g.name}」] 用户接着说：${note}\n${calledBy ? `${nameOf(calledBy)} 之前点到了你。` : ""}用户最初说的是：${seed}\n${rules}`
              : calledBy
                ? `[群聊「${g.name}」] ${nameOf(calledBy)} 在群里点到了你，请接着讨论。用户最初说的是：${seed}\n${rules}`
                : `[群聊「${g.name}」] 用户${pinged.includes(botId) ? "点名问你" : "说"}：${seed}\n${rules}`;
          lastText = await speak(botId, turn, prompt, {
            memoryText: calledBy === "user" ? note : calledBy ? null : seed,
            content: calledBy || resuming ? prompt : content,
            meta: { replyTo: calledBy ?? "user" },
          });
          this.capture(sid, botId, lastText);
          return lastText;
        },
      });
      // settle 会先推 done；若还要整理结论，会临时盖成 conclusion，结束后必须再推 done，否则底栏卡在「正在整理结论」
      const settled = this.settle(sid, groupId, r, hooks, ceiling, nameOf);
      let conclusion: ContentBlock | null = null;
      if (!settled.paused && mod && r.reason !== "stopped" && r.turns >= 2) {
        progress({ state: "conclusion", speaker: mod.name });
        hooks.onStream({ sessionId: sid, botId: mod.id, turn: "c", block: { type: "text", text: "" } });
        conclusion = await this.conclusion(g, sid, userMsgId, mod, hooks.signal).catch(() => null);
        if (conclusion && conclusion.type === "conclusion") {
          this.noteBoard(sid, collectDecisions(conclusion.decisions.map((d) => `定了：${d}`).join("\n")));
          store.addMessage({ sessionId: sid, from: mod.id, to: "user", role: "assistant", content: [conclusion], kind: "chat", createdAt: Date.now(), meta: { tag: "conclusion" } });
        }
        const reasonText = RELAY_REASON_TEXT[r.reason as RelayReason];
        hooks.onProgress({
          sessionId: sid, groupId, max: ceiling, state: "done",
          turn: r.turns, total: r.turns, reason: reasonText, board: this.boardOf(sid),
        });
      }
      const reasonText = settled.paused ? RELAY_REASON_TEXT.limit : RELAY_REASON_TEXT[r.reason as RelayReason];
      return { ok: true as const, sessionId: sid, ...r, lastText, conclusion, reasonText, groupName: g.name };
    } finally {
      this.inbox.delete(sid);
    }
  }

  /** 一位成员在群里发言：历史里去掉触发消息本身（它已经写在 prompt 里） */
  private speaker(g: Group, sid: string, triggerMsgId: number, hooks: GroupSessionHooks) {
    const { store, runtime } = this.deps;
    // 已经在群里说话：禁止再 group.send / 连环 bot.ask，否则会空转套娃
    const roomSystem = [
      `你正在群聊「${g.name}」里发言，消息会直接出现在这个群里。`,
      "不要调用 group.send（你已经在群里了）。",
      "不要调用 bot.ask / ui.*；有话直接说。",
      "不要复述系统规则或思考过程，只输出要对群友说的正文。",
      hooks.extraSystem?.trim() || "",
    ].filter(Boolean).join("\n");
    return async (botId: string, turn: number | string, prompt: string, extra: { memoryText?: string | null; meta?: Partial<MessageMeta>; content?: string | ContentBlock[] }) => {
      const bot = store.getBot(botId);
      if (!bot) return "";
      const push = (b: ContentBlock) => hooks.onStream({ sessionId: sid, botId, turn, block: b });
      hooks.setRunning(botId, sid, `群聊「${g.name}」`);
      push({ type: "text", text: "" });
      try {
        const out = await runtime.handleStream(
          { bot, from: "user", text: prompt, content: extra.content ?? prompt, sessionId: sid, history: store.listMessages(sid).filter((m) => m.id !== triggerMsgId && m.kind !== "event").slice(-200) },
          { onBlock: push, signal: hooks.signal, skipUserRecord: true, memoryText: extra.memoryText ?? null, autoEventMemory: false, meta: extra.meta, extraSystem: roomSystem },
        );
        return out.text;
      } catch (e) {
        if (!hooks.signal?.aborted) {
          store.addMessage({ sessionId: sid, from: botId, to: "user", role: "assistant", content: `❌ ${bot.name} 回复失败：${e instanceof Error ? e.message : String(e)}`, kind: "chat", createdAt: Date.now() });
        }
        return "";
      } finally {
        hooks.setIdle(botId);
      }
    };
  }

  /** 群内发言规则：谁被 @ / 【交给】谁才说；禁止 bot.ask 私聊空转 */
  private roomRules(opts: {
    memberNames: string;
    outsiders?: string;
    goal?: string;
    decided?: string[];
    modName?: string;
    waitingFor?: string;
  }): string {
    const bits = [
      `成员有 ${opts.memberNames}`,
      opts.outsiders ? `群外还有 ${opts.outsiders}，需要时点名就会被叫进来` : "",
      opts.goal ? `群目标：${opts.goal}` : "",
      opts.decided?.length ? `已定事项：${opts.decided.join("；")}` : "",
      opts.modName ? `主持人是 ${opts.modName}` : "",
      opts.waitingFor ? `${opts.waitingFor} 在等回应，直接回它说的内容` : "",
      "只代表你自己发言，不要替别人说话",
      "想让谁接话，回复末尾另起一行写「【交给】名字」；要全员写「【交给】全员」或 @everyone / @所有人；没有就写「【交给】无」（这行不显示在群里）。也可以直接 @ 名字",
      "只是提到某人、不需要对方说话，就不要【交给】也不要 @",
      "需要谁说话就在群里 @ / 【交给】；不要用 bot.ask 把同一句提示私下转给多人",
      "bot.ask 仅用于核对某一细节，且结论必须带回群里用一句话说清",
      "定下来的事写成「定了：…」，要撤掉写「取消：原来的那句」",
      "不要调用 ui.ask / ui.confirm；需要用户拍板的事写在发言里",
      opts.modName ? "由主持人在结论里统一汇总" : "等用户回复",
      `讨论有了结论时在末尾写「${GROUP_END_MARK}」`,
      opts.waitingFor ? "没什么要补充就简短回应一句" : "",
    ].filter(Boolean);
    return `（群聊规则：${bits.join("；")}。）`;
  }

  /**
   * bot 在群里发言：消息以它的身份出现在群聊里。
   * 被 @ / 【交给】的人回应；没点名时只由主持人（或下一位）回一句，不再默认全员齐声。
   * 发言者自己不进接力。交接只认写明的点名。
   */
  async post(groupId: string, from: Bot, message: string, hooks: GroupSessionHooks, opts?: { maxTurns?: number; sessionId?: string }) {
    const { store, groups } = this.deps;
    const g = groups.get(groupId);
    if (!g) throw new Error("群组不存在");
    const sid = opts?.sessionId || `group-${groupId}`;
    if (this.inbox.has(sid)) {
      const joined = await this.speakInto(groupId, from, message, sid);
      return { groupName: g.name, sessionId: sid, replies: [], reasonText: joined.ok ? "插进正在进行的接力" : "这段对话没有正在进行的接力", joined: joined.ok, turns: 0, rounds: 0, reason: "quiet" as const };
    }
    const held = this.relays.get(sid);
    if (held?.status === "paused" && (held.queue.length || held.pending?.length)) {
      store.addMessage({ sessionId: sid, from: from.id, to: groupId, role: "assistant", content: message, kind: "chat", createdAt: Date.now() });
      const live: PendingLine[] = [];
      this.inbox.set(sid, live);
      const targets = await this.who(message, from.id, { judge: false, room: g.members });
      const ceiling = relayCeiling(g.settings?.maxTurns ?? 12);
      held.maxTurns = stretchLimit(held, ceiling);
      const stretchBase = Math.max(0, held.maxTurns - ceiling);
      const extra = live.splice(0);
      const incoming = { text: message, targets, from: from.id, explicit: targets.length > 0 };
      live.push(...(held.pending ?? []), incoming, ...extra);
      this.notePending(sid, incoming);
      const nameOf = (id: string) => store.getBot(id)?.name ?? id;
      const speak = this.speaker(g, sid, held.userMsgId, hooks);
      const replies: { name: string; text: string }[] = [];
      try {
        const r = await runGroupRelay({
          members: g.members,
          resume: held,
          bots: store.listBots(),
          maxTurns: held.maxTurns,
          relay: () => this.deps.groups.get(groupId)?.settings?.relay !== false,
          fallback: this.moderator(g)?.id ?? g.members[0],
          aborted: () => !!hooks.signal?.aborted || !this.deps.groups.get(groupId),
          canSpeak: (item) => this.canSpeak(groupId, item),
          inbox: () => this.takeInbox(sid),
          whoNext: (text, selfId) => this.who(text, selfId, { judge: false, room: g.members }),
          onCheckpoint: (cursor) => this.remember(sid, { ...cursor, sessionId: sid, groupId, status: "running", seedText: held.seedText, userMsgId: held.userMsgId, maxTurns: held.maxTurns }),
          onTurn: ({ turn, speaker, next, round }) => {
            const total = turn + 1;
            hooks.onProgress({ sessionId: sid, groupId, max: ceiling, state: "running", turn: total - stretchBase, total, round, speaker: nameOf(speaker), next: next.map(nameOf), board: this.boardOf(sid) });
          },
          reply: async (botId, _turn, calledBy, note) => {
            const decided = this.boardOf(sid).join("；") || "还没有";
            const prompt = note
              ? `[群聊「${g.name}」] ${nameOf(calledBy ?? from.id)} 在群里说：${note}\n已定事项：${decided}`
              : calledBy
                ? `[群聊「${g.name}」] ${nameOf(calledBy)} 之前点到了你，请接着讨论。最初说的是：${held.seedText}\n已定事项：${decided}`
                : `[群聊「${g.name}」] 请接着讨论。最初说的是：${held.seedText}\n已定事项：${decided}`;
            const text = await speak(botId, _turn, prompt, { meta: { replyTo: calledBy ?? from.id } });
            this.capture(sid, botId, text);
            if (text.trim()) replies.push({ name: nameOf(botId), text });
            return text;
          },
        });
        const settled = this.settle(sid, groupId, r, hooks, ceiling, nameOf, from.name);
        return { groupName: g.name, sessionId: sid, replies, reasonText: settled.paused ? RELAY_REASON_TEXT.limit : RELAY_REASON_TEXT[r.reason], joined: false, ...r };
      } finally {
        this.inbox.delete(sid);
      }
    }
    store.addMessage({ sessionId: sid, from: from.id, to: groupId, role: "assistant", content: message, kind: "chat", createdAt: Date.now() });
    const triggerId = store.listMessages(sid).at(-1)?.id ?? 0;
    const nameOf = (id: string) => store.getBot(id)?.name ?? id;
    const others = g.members.filter((id) => id !== from.id && store.getBot(id));
    const bots = store.listBots().filter((b) => b.id !== from.id);
    const named = await this.who(message, from.id, { judge: false, room: others });
    const mod = this.moderator(g);
    const fallback = (mod && others.includes(mod.id) ? mod.id : others[0]);
    // 没 @：只叫一位（主持人优先）；@everyone / 【交给】全员 由 who() 展开，不靠口语关键词
    const start = named.length ? named : fallback ? [fallback] : [];
    const unnamed = !named.length;
    const maxTurns = Math.max(1, Math.min(opts?.maxTurns ?? (unnamed ? 1 : others.length + 2), 8));
    this.inbox.set(sid, []);
    this.remember(sid, { sessionId: sid, groupId, status: "running", queue: [], roundLeft: 0, round: 1, turns: 0, ending: false, seedText: message, userMsgId: triggerId, maxTurns });
    const rules = this.roomRules({
      memberNames: g.members.map(nameOf).join("、"),
      waitingFor: from.name,
    });
    const speak = this.speaker(g, sid, triggerId, hooks);
    const replies: { name: string; text: string }[] = [];
    const progress = (p: Partial<GroupProgress>) => hooks.onProgress({ sessionId: sid, groupId, max: maxTurns, state: "running", board: this.boardOf(sid), ...p });
    try {
      const r = await runGroupRelay({
        members: others,
        start,
        bots,
        maxTurns,
        // 没点名：主持人回一句就停，避免一句寒暄又拖出整轮接力
        oneShot: unnamed,
        relay: () => !unnamed && this.deps.groups.get(groupId)?.settings?.relay !== false,
        aborted: () => !!hooks.signal?.aborted || !this.deps.groups.get(groupId),
        canSpeak: (item) => this.canSpeak(groupId, item),
        inbox: () => this.takeInbox(sid),
        whoNext: (text, selfId) => unnamed ? Promise.resolve([]) : this.who(text, selfId, { judge: false, room: g.members }),
        onCheckpoint: (cursor) => this.remember(sid, { ...cursor, sessionId: sid, groupId, status: "running", seedText: message, userMsgId: triggerId, maxTurns }),
        onTurn: ({ turn, speaker, next, round }) => progress({ turn: turn + 1, total: turn + 1, round, speaker: nameOf(speaker), next: next.map(nameOf) }),
        reply: async (botId, turn, calledBy) => {
          const prompt = calledBy
            ? `[群聊「${g.name}」] ${nameOf(calledBy)} 在群里点到了你，请接着说。最初是 ${from.name} 说的：${message}\n${rules}`
            : `[群聊「${g.name}」] ${from.name} 在群里说：${message}\n${rules}`;
          const text = await speak(botId, turn, prompt, { meta: { replyTo: calledBy ?? from.id } });
          this.capture(sid, botId, text);
          if (text.trim()) replies.push({ name: nameOf(botId), text });
          return text;
        },
      });
      const settled = this.settle(sid, groupId, r, hooks, maxTurns, nameOf, from.name);
      return { groupName: g.name, sessionId: sid, replies, reasonText: settled.paused ? RELAY_REASON_TEXT.limit : RELAY_REASON_TEXT[r.reason], joined: false, ...r };
    } finally {
      this.inbox.delete(sid);
    }
  }

  /** 还没开口的成员若已经离群或被删掉，就跳过。被点名拉进来的说完这一句 */
  private canSpeak(groupId: string, item: { id: string; invited?: boolean; by: string | null }): boolean {
    const now = this.deps.groups.get(groupId);
    if (!now || !this.deps.store.getBot(item.id)) return false;
    if (item.invited || (item.by && item.by !== "user")) return true;
    return now.members.includes(item.id);
  }

  /** 结论卡片任务分派执行 */
  async dispatch(groupId: string, sessionId: string, msgId: number, indexes: number[], hooks: GroupSessionHooks) {
    const { store, groups, runtime } = this.deps;
    const g = groups.get(groupId);
    const msg = store.listMessages(sessionId).find((m) => m.id === msgId);
    const card = Array.isArray(msg?.content) ? msg!.content.find((b) => b.type === "conclusion") : undefined;
    if (!g || !card || card.type !== "conclusion") throw new Error("找不到结论卡片");
    const picked = indexes.map((i) => ({ i, t: card.tasks[i] })).filter((x) => x.t && x.t.ownerId && store.getBot(x.t.ownerId));
    store.updateMessage(sessionId, msgId, (m) => ({
      ...m,
      content: (m.content as ContentBlock[]).map((b) => (b.type === "conclusion" ? { ...b, tasks: b.tasks.map((t, i) => (indexes.includes(i) ? { ...t, dispatched: true } : t)) } : b)),
    }));
    let n = 0;
    for (const { t } of picked) {
      if (hooks.signal?.aborted) break;
      const bot = store.getBot(t.ownerId!)!;
      hooks.onProgress({ sessionId, groupId, state: "running", turn: ++n, max: picked.length, speaker: bot.name, next: picked.slice(n).map((x) => x.t.owner), dispatch: true });
      const push = (b: ContentBlock) => hooks.onStream({ sessionId, botId: bot.id, turn: `d${n}`, block: b });
      push({ type: "text", text: "" });
      hooks.setRunning(bot.id, sessionId, t.task.slice(0, 60));
      try {
        await runtime.handleStream(
          { bot, from: "user", text: `[群聊「${g.name}」] 主持人把这项任务分派给你：${t.task}\n现在就开始做：需要工具就调用工具，产出的文件用 file.send 交付，做完在群里简短汇报结果。`, sessionId, history: store.listMessages(sessionId).filter((m) => m.kind !== "event").slice(-120) },
          { onBlock: push, signal: hooks.signal, skipUserRecord: true, memoryText: null, autoEventMemory: false, meta: { replyTo: "user" }, extraSystem: hooks.extraSystem },
        );
      } catch (e) {
        if (!hooks.signal?.aborted) {
          store.addMessage({ sessionId, from: bot.id, to: "user", role: "assistant", content: `❌ ${bot.name} 执行失败：${e instanceof Error ? e.message : String(e)}`, kind: "chat", createdAt: Date.now() });
        }
      } finally {
        hooks.setIdle(bot.id);
      }
    }
    store.addMessage({ sessionId, from: "system", to: "user", role: "assistant", content: hooks.signal?.aborted ? "分派执行已停止" : `分派执行完成 · ${picked.length} 项任务`, kind: "event", createdAt: Date.now() });
    hooks.onProgress({ sessionId, groupId, state: "done", dispatch: true, reason: hooks.signal?.aborted ? "你停止了执行" : "任务都已执行" });
    return { ok: true as const, count: picked.length };
  }

  private async conclusion(g: Group, sid: string, since: number, mod: Bot, signal?: AbortSignal): Promise<ContentBlock | null> {
    const { store, providers } = this.deps;
    const msgs = store.listMessages(sid).filter((m) => (m.id ?? 0) > since && m.kind !== "event");
    if (msgs.length < 2) return null;
    const nameOf = (id: string) => (id === "user" ? "用户" : store.getBot(id)?.name ?? id);
    const transcript = msgs.map((m) => `${nameOf(m.from)}：${contentText(m.content).replace(/```tool[\s\S]*?```/g, "").trim()}`).join("\n\n").slice(-12000);
    const bound = providers.get(mod.providerId);
    const p = bound ?? providers.getDefault();
    if (!p || signal?.aborted) return null;
    const timeout = AbortSignal.timeout(90_000);
    const members = [...new Set([...g.members, ...msgs.map((m) => m.from)])].filter((id) => store.getBot(id)).map(nameOf);
    const r = await providers.complete(p, {
      system: `你是群聊「${g.name}」的主持人 ${mod.name}。根据讨论记录整理结论，只输出 JSON，不要其他文字：
{"summary":"一两句话总结","decisions":["已经定下来的事"],"tasks":[{"owner":"负责人（必须是成员名之一）","task":"要做的具体事情"}],"open":["还没定、需要用户拍板的问题"]}
成员：${members.join("、")}。没有的项给空数组。`,
      user: `${g.settings?.goal ? `群目标：${g.settings.goal}\n\n` : ""}讨论记录：\n${transcript}`,
      model: bound ? mod.model : undefined,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const raw = r.text.match(/\{[\s\S]*\}/)?.[0];
    if (!raw) return null;
    try {
      const j = JSON.parse(raw) as { summary?: string; decisions?: string[]; tasks?: { owner: string; task: string }[]; open?: string[] };
      const bots = store.listBots();
      return {
        type: "conclusion",
        summary: String(j.summary ?? ""),
        decisions: (j.decisions ?? []).map(String).filter(Boolean),
        tasks: (j.tasks ?? []).filter((t) => t?.task).map((t) => ({
          owner: String(t.owner),
          ownerId: bots.find((b) => b.name === t.owner)?.id ?? bots.find((b) => String(t.owner).includes(b.name))?.id,
          task: String(t.task),
        })),
        open: (j.open ?? []).map(String).filter(Boolean),
      };
    } catch {
      return null;
    }
  }
}

function withoutDecisionMarks(content: string | ContentBlock[]): string | ContentBlock[] {
  const strip = (t: string) => t.split("\n").filter((line) => !/^【(?:已定|交给)】/.test(line.trim())).join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  if (typeof content === "string") return strip(content);
  if (!Array.isArray(content)) return content;
  return content.map((b) => (b.type === "text" && b.text ? { ...b, text: strip(b.text) } : b));
}

/** Bot 发进群里时落到哪一段：正在看的优先，其次正在接力的，再其次最近一段 */
export function pickGroupSession(groupId: string, opts: { gazed?: string; live?: string; sessions: Array<{ id: string; updatedAt: number }> }): string {
  if (opts.gazed) return opts.gazed;
  if (opts.live) return opts.live;
  const prefix = `group-${groupId}`;
  const mine = opts.sessions.filter((s) => s.id === prefix || s.id.startsWith(`${prefix}-`));
  mine.sort((a, b) => b.updatedAt - a.updatedAt);
  return mine[0]?.id ?? prefix;
}
