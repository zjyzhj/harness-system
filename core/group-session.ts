/**
 * 群聊会话编排：接力讨论、主持人小结/结论、任务分派。
 * 不依赖 Electron；UI 推送 / 状态点通过 hooks 注入。
 */
import { contentText, type Bot, type ContentBlock, type MessageMeta } from "./types";
import type { Store } from "./store";
import type { BotRuntime } from "./bot-runtime";
import type { ProviderCenter } from "./provider-center";
import type { Group, GroupRegistry } from "./group-registry";
import { addressedBots, GROUP_END_MARK, RELAY_REASON_TEXT, runGroupRelay, type RelayReason } from "./group-relay";

export interface GroupProgress {
  sessionId: string;
  groupId: string;
  state: string;
  turn?: number;
  max?: number;
  speaker?: string;
  next?: string[];
  round?: number;
  reason?: string;
  dispatch?: boolean;
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

export class GroupSessionRunner {
  /** sessionId → 用户插话收件箱 */
  private inbox = new Map<string, { text: string; targets: string[] }[]>();

  constructor(private deps: GroupSessionDeps) {}

  moderator(g: Group): Bot | null {
    const { store } = this.deps;
    const id = g.settings?.moderator ?? store.listBots().find((b) => b.isMaster && g.members.includes(b.id))?.id;
    return id ? store.getBot(id) ?? null : null;
  }

  /** 接力进行中插话 */
  interject(groupId: string, sessionId: string, content: string | ContentBlock[]): { ok: boolean } {
    const box = this.inbox.get(sessionId);
    if (!box) return { ok: false };
    const text = contentText(typeof content === "string" ? content : content);
    this.deps.store.addMessage({ sessionId, from: "user", to: groupId, role: "user", content: content as any, kind: "chat", createdAt: Date.now() });
    box.push({ text, targets: addressedBots(text, this.deps.store.listBots(), "user") });
    return { ok: true };
  }

  async chat(groupId: string, content: string | ContentBlock[], sessionId: string | undefined, hooks: GroupSessionHooks) {
    const { store, groups, runtime } = this.deps;
    const g = groups.get(groupId);
    if (!g) throw new Error("群组不存在");
    const sid = sessionId || `group-${groupId}`;
    const text = contentText(typeof content === "string" ? content : content);
    store.addMessage({ sessionId: sid, from: "user", to: groupId, role: "user", content: content as any, kind: "chat", createdAt: Date.now() });
    const userMsgId = store.listMessages(sid).at(-1)?.id ?? 0;
    this.inbox.set(sid, []);
    const nameOf = (id: string) => store.getBot(id)?.name ?? id;
    const mod = this.moderator(g);
    const maxTurns = Math.max(1, Math.min(40, g.settings?.maxTurns ?? 12));
    const memberNames = g.members.map(nameOf).join("、");
    const outsiders = store.listBots().filter((b) => !g.members.includes(b.id)).map((b) => b.name).join("、");
    const rules = `（群聊规则：成员有 ${memberNames}${outsiders ? `；群外还有 ${outsiders}，需要时 @ 名字就会被叫进来` : ""}。${g.settings?.goal ? `群目标：${g.settings.goal}。` : ""}${mod ? `主持人是 ${mod.name}。` : ""}只代表你自己发言，不要替别人说话；想让谁接话就在回复里 @ 他的名字（群里的人不要用 bot.ask 私下问，大家都要看得到）；没有需要别人回应的就不要 @ 任何人；不要调用 ui.ask / ui.confirm 让用户选择，需要用户拍板的事写在发言里，${mod ? "由主持人在结论里统一汇总" : "等用户回复"}；讨论有了结论时在末尾写「${GROUP_END_MARK}」。）`;
    const pinged = addressedBots(text, store.listBots(), "user");
    let lastText = "";
    const progress = (p: Partial<GroupProgress>) => hooks.onProgress({ sessionId: sid, groupId, max: maxTurns, state: "running", ...p });
    const speak = this.speaker(g, sid, userMsgId, hooks);

    try {
      const r = await runGroupRelay({
        members: g.members,
        start: pinged,
        bots: store.listBots(),
        maxTurns,
        relay: g.settings?.relay !== false,
        fallback: mod?.id ?? g.members[0],
        aborted: () => !!hooks.signal?.aborted,
        inbox: () => (this.inbox.get(sid) ?? []).splice(0),
        onTurn: ({ turn, speaker, next, round }) => progress({ state: "running", turn: turn + 1, round, speaker: nameOf(speaker), next: next.map(nameOf) }),
        onRoundEnd: async (round) => {
          if (!mod) return;
          progress({ state: "summary", round, speaker: mod.name });
          await speak(mod.id, `s${round}`, `[群聊「${g.name}」主持] 你是本群主持人。用 2-4 句话小结刚才第 ${round} 轮讨论：达成了什么共识、还有什么分歧、接下来该谁回应什么。不要 @ 任何人，不要调用工具。${g.settings?.goal ? `群目标：${g.settings.goal}` : ""}`, { meta: { tag: "summary" } });
        },
        reply: async (botId, turn, calledBy, note) => {
          const prompt = calledBy === "user"
            ? `[群聊「${g.name}」] 用户中途插话：${note}\n${rules}`
            : calledBy
              ? `[群聊「${g.name}」] ${nameOf(calledBy)} 在群里点到了你，请接着讨论。用户最初说的是：${text}\n${rules}`
              : `[群聊「${g.name}」] 用户${pinged.includes(botId) ? "点名问你" : "说"}：${text}\n${rules}`;
          lastText = await speak(botId, turn, prompt, {
            memoryText: calledBy === "user" ? note : calledBy ? null : text,
            content: calledBy ? prompt : content,
            meta: { replyTo: calledBy ?? "user" },
          });
          return lastText;
        },
      });

      let conclusion: ContentBlock | null = null;
      if (mod && r.reason !== "stopped" && r.turns >= 2) {
        progress({ state: "conclusion", speaker: mod.name });
        hooks.onStream({ sessionId: sid, botId: mod.id, turn: "c", block: { type: "text", text: "" } });
        conclusion = await this.conclusion(g, sid, userMsgId, mod, hooks.signal).catch(() => null);
        if (conclusion) {
          store.addMessage({ sessionId: sid, from: mod.id, to: "user", role: "assistant", content: [conclusion], kind: "chat", createdAt: Date.now(), meta: { tag: "conclusion" } });
        }
      }
      const reasonText = RELAY_REASON_TEXT[r.reason as RelayReason];
      store.addMessage({ sessionId: sid, from: "system", to: "user", role: "assistant", content: `接力结束 · ${r.turns} 次发言 · ${reasonText}${r.reason === "limit" ? "，发一句话就能让大家继续" : ""}`, kind: "event", createdAt: Date.now() });
      progress({ state: "done", turn: r.turns, reason: reasonText });
      return { ok: true as const, sessionId: sid, ...r, lastText, conclusion, reasonText, groupName: g.name };
    } finally {
      this.inbox.delete(sid);
    }
  }

  /** 一位成员在群里发言：历史里去掉触发消息本身（它已经写在 prompt 里） */
  private speaker(g: Group, sid: string, triggerMsgId: number, hooks: GroupSessionHooks) {
    const { store, runtime } = this.deps;
    return async (botId: string, turn: number | string, prompt: string, extra: { memoryText?: string | null; meta?: Partial<MessageMeta>; content?: string | ContentBlock[] }) => {
      const bot = store.getBot(botId)!;
      const push = (b: ContentBlock) => hooks.onStream({ sessionId: sid, botId, turn, block: b });
      hooks.setRunning(botId, sid, `群聊「${g.name}」`);
      push({ type: "text", text: "" });
      try {
        const out = await runtime.handleStream(
          { bot, from: "user", text: prompt, content: extra.content ?? prompt, sessionId: sid, history: store.listMessages(sid).filter((m) => m.id !== triggerMsgId && m.kind !== "event").slice(-200) },
          { onBlock: push, signal: hooks.signal, skipUserRecord: true, memoryText: extra.memoryText ?? null, autoEventMemory: false, meta: extra.meta, extraSystem: hooks.extraSystem },
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

  /**
   * bot 在群里发言：消息以它的身份出现在群聊里，被 @ 的成员（没 @ 就全员）接力回应，
   * 返回各成员的回复交给发言的 bot。发言者自己不进接力（它这一轮还没结束，回复由它在原对话里转告）。
   */
  async post(groupId: string, from: Bot, message: string, hooks: GroupSessionHooks, opts?: { maxTurns?: number }) {
    const { store, groups } = this.deps;
    const g = groups.get(groupId);
    if (!g) throw new Error("群组不存在");
    const sid = `group-${groupId}`;
    store.addMessage({ sessionId: sid, from: from.id, to: groupId, role: "assistant", content: message, kind: "chat", createdAt: Date.now() });
    const triggerId = store.listMessages(sid).at(-1)?.id ?? 0;
    const nameOf = (id: string) => store.getBot(id)?.name ?? id;
    const others = g.members.filter((id) => id !== from.id && store.getBot(id));
    const bots = store.listBots().filter((b) => b.id !== from.id && g.members.includes(b.id));
    const maxTurns = Math.max(1, Math.min(opts?.maxTurns ?? others.length + 2, 8));
    const rules = `（群聊规则：成员有 ${g.members.map(nameOf).join("、")}。只代表你自己发言，不要替别人说话；${from.name} 在等大家的回应，直接回应它说的内容；想让其他成员接话就 @ 他的名字；不要调用 ui.ask / ui.confirm，也不要用 bot.ask 私下问；没什么要补充的就简短回应一句。）`;
    const speak = this.speaker(g, sid, triggerId, hooks);
    const replies: { name: string; text: string }[] = [];
    const progress = (p: Partial<GroupProgress>) => hooks.onProgress({ sessionId: sid, groupId, max: maxTurns, state: "running", ...p });
    const r = await runGroupRelay({
      members: others,
      start: addressedBots(message, bots, from.id),
      bots,
      maxTurns,
      relay: g.settings?.relay !== false,
      aborted: () => !!hooks.signal?.aborted,
      onTurn: ({ turn, speaker, next, round }) => progress({ turn: turn + 1, round, speaker: nameOf(speaker), next: next.map(nameOf) }),
      reply: async (botId, turn, calledBy) => {
        const prompt = calledBy
          ? `[群聊「${g.name}」] ${nameOf(calledBy)} 在群里点到了你，请接着说。最初是 ${from.name} 说的：${message}\n${rules}`
          : `[群聊「${g.name}」] ${from.name} 在群里说：${message}\n${rules}`;
        const text = await speak(botId, turn, prompt, { meta: { replyTo: calledBy ?? from.id } });
        if (text.trim()) replies.push({ name: nameOf(botId), text });
        return text;
      },
    });
    const reasonText = RELAY_REASON_TEXT[r.reason as RelayReason];
    store.addMessage({ sessionId: sid, from: "system", to: "user", role: "assistant", content: `${from.name} 发起的接力结束 · ${r.turns} 次发言 · ${reasonText}`, kind: "event", createdAt: Date.now() });
    progress({ state: "done", turn: r.turns, reason: reasonText });
    return { groupName: g.name, sessionId: sid, replies, reasonText, ...r };
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
