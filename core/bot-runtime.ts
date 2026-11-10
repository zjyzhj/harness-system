import { contentText, type Bot, type ChatMessage, type ContentBlock, type MemoryEntry, type MessageMeta, type Provider, type RuntimeResult, type ToolCall, type ToolInvocation } from "./types";
import { fetchPage, isPrivateHost, PrivateAddressError, webSearch } from "./web-search";
import { editImage, generateImages } from "./image-tool";
import { textTokens } from "./store";
import { ToolRegistry } from "./tool-registry";
import { trimHistoryToBudget } from "./context-budget";
import { OfflinePersona } from "./offline-persona";
import { supportsNativeTools, type CompletionResult, type WireTurn } from "./adapters/openai-compat";
import { looksSecret, normalizeEnvKey } from "./env-store";
import { defaultAvatar } from "./avatar";
import { ruleParse, buildSystemPrompt } from "./agent-registry";
import { seedBotWelcome } from "./bot-onboard";
import { seedGroupWelcome } from "./group-onboard";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { RuntimeDeps, ToolOutcome, RuntimeOptions, TurnCtx } from "./runtime/types";
import { addSource, QUIET_TOOLS, CONTINUE_HINT, THINK_PROMPT, stripToolBlocks, toolBlockCutoff, BOT_ASK_CONCURRENCY, abortable, mapPool, untrusted, thinkingModelOf, needsReasoning, contextWindowOf, historyBudgetOf, turnBudgetOf, shrinkToolResults, looksLikeRule, buildActionGroundingFacts, ACTION_GROUNDING_SYSTEM, shouldActionGround, parseVerdict, CALL_TOOL, toolRoundEcho, parseToolBlocks, canonicalizeTool, TOOL_ALIASES, GROUNDING_RISK_TOOLS, MCP_STDIO_ALLOW, checkMcpStdioCommand } from "./runtime/turn-helpers";
import { memoryLink, appendSkillRules, isDuplicateRule, type MemoryDraft, CLAIMS_SAVED, memoryFromText } from "./runtime/rules-text";
import { runTaskTool, sendFiles, uiTool, ownHistoryText, isSensitivePath, parseRunAt } from "./runtime/tool-helpers";
import { unattendedApprovalKind } from "./routine-boundary";
import { PromptBuilder, type PromptExtras } from "./runtime/prompt";
import {
  buildAgentPrompt,
  CliAgentPathError,
  isCliAgentBusy,
  parseCliName,
  pickInstalledCli,
  resolveAgentCwd,
  resolveCwdInput,
  runCliAgent,
} from "./cli-agent";
import { cliAgentToolDescription, probeCodingAgents } from "./coding-agents";
import { nextCodingThread, shouldResume, threadBrief, wantsFreshTask } from "./coding-thread";
import { codingDirList, decodeTermKeys, gazeCodingDir, postureSentence, presenceTaskLine, terminalPosture } from "./coding-presence";
import { detectChoiceOffer } from "./choice-offer";
import { summarizeCodingActivity } from "./coding-activity";
import {
  formatObserveText,
  observeDisk,
  observeProcesses,
  observeSystem,
  purgePaths,
  scanOldFiles,
} from "./system-observe";
import { readBotWatch, watchKeywords } from "./system-watch";
import { randomUUID } from "node:crypto";
export * from "./runtime/types";
export * from "./runtime/turn-helpers";
export * from "./runtime/rules-text";
export * from "./runtime/tool-helpers";
export { detectChoiceOffer, extractEnumOptions } from "./choice-offer";

/**
 * Bot 运行时 — 真正的智能体循环：
 * 1. 组装上下文：角色 systemPrompt + 持久记忆 + 技能清单
 * 2. 调用 provider（模型生成）
 * 3. 若回复含 ```tool``` 块 → 解析为工具调用 → 执行技能/内置工具 → 回填结果 → 回到步骤 2
 * 4. 生成最终回复，抽取记忆事件（fact/event），返回 RuntimeResult
 *
 * 工具调用用「文本块约定」而不是 model function-calling：
 * 对 OpenAI 兼容 API 和 CLI 适配器都通用，兼容性最好（成熟 CLI bot 常用方案）。
 *
 * 桌宠不在此：娱乐侧车见 core/pet/sidecar.ts（attachPetEntertainment）。
 */
type LiveTurn = {
  sessionId: string;
  botId: string;
  from: string;
  kind: "chat" | "bot-to-bot";
  blocks: ContentBlock[];
  /** 这一轮模型输出在 blocks 里的起点，撤回只丢掉这之后的正文 */
  roundAt: number;
  draftId?: number;
  timer?: ReturnType<typeof setTimeout>;
  /** 退出时已经落盘，后到的收尾不再覆盖 */
  sealed: boolean;
  userSaved: boolean;
};

/** 两段旁白是否像同一段话的复述（工具轮前后模型常把结论再说一遍） */
function narrationOverlap(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 40 && y.includes(x)) return true;
  if (y.length >= 40 && x.includes(y)) return true;
  // 共同行占比：列表型结论重复时很常见
  const lines = (s: string) => s.split(/\n+/).map((l) => l.replace(/^[-*•\d.)\s]+/, "").trim()).filter((l) => l.length >= 8);
  const A = new Set(lines(x)), B = lines(y);
  if (A.size < 2 || B.length < 2) return false;
  const hit = B.filter((l) => A.has(l) || [...A].some((a) => a.includes(l) || l.includes(a))).length;
  return hit / Math.max(A.size, B.length) >= 0.6;
}

/** 保留工具卡 / 例行卡；丢掉被后文复述的旁白，减轻「流式好看、落盘一跳像重复」 */
function coalesceNarrationBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const b of blocks) {
    if (b.type !== "text") { out.push(b); continue; }
    const text = String(b.text ?? "").trim();
    if (!text) continue;
    // 从后往前找最近一条旁白（中间可夹工具卡）
    let prevIdx = -1;
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].type === "text") { prevIdx = i; break; }
      if (out[i].type !== "tool_call" && out[i].type !== "thinking") break;
    }
    if (prevIdx >= 0 && narrationOverlap(String((out[prevIdx] as { text?: string }).text ?? ""), text)) {
      const prev = String((out[prevIdx] as { text?: string }).text ?? "");
      // 留更完整的那段
      if (text.length >= prev.trim().length) out[prevIdx] = b;
      continue;
    }
    out.push(b);
  }
  return out;
}

export class BotRuntime {
  private tools = new ToolRegistry();
  private prompt: PromptBuilder;
  /** 正在写的一轮：用户消息立刻落盘，回复按间隔写成草稿，退出时能留下 */
  private liveTurns = new Map<string, LiveTurn>();
  /** 最近一次 bot.ask 原文级缓存：相同 from→to+message 短时内不重复跑，掐掉连环空转 */
  private recentAsks = new Map<string, { at: number; output: string }>();
  /** 进行中的 bot.ask：同轮并行两次相同 to+message 时共用一个 askBot，避免打穿缓存、双写 b2b */
  private inflightAsks = new Map<string, Promise<string>>();
  constructor(private deps: RuntimeDeps) {
    this.prompt = new PromptBuilder(deps, () => this.tools.prompt());
    this.installTools();
  }

  /** 供娱乐侧车等外挂注册工具（Bot 核心不内置 pet.*） */
  toolRegistry(): ToolRegistry {
    return this.tools;
  }

  /** 供娱乐侧车注入提示词附加；默认空 = 完整 Bot 设计无桌宠干扰 */
  setPromptExtras(extras: PromptExtras): void {
    this.prompt.setExtras(extras);
  }

  /**
   * 非流式入口：内部走同一套 handleStream（工具循环 / 记忆 / 富内容），丢弃增量。
   * 定时任务、旧调用方用这个；面板走 handleStream。
   */
  async handle(
    input: { bot: Bot; from: string; text: string; content?: string | ContentBlock[]; sessionId: string; history?: ChatMessage[] },
    opts?: RuntimeOptions,
  ): Promise<RuntimeResult> {
    return this.handleStream(input, { ...(opts ?? {}), onBlock: () => {} });
  }

  /**
   * 唯一内核：处理一条用户/bot 消息，工具循环 + 增量块回推。
   * onBlock(chunk) 实时收到 text/tool_call 增量；结束时记录完整富消息并返回。
   */
  async handleStream(
    input: { bot: Bot; from: string; text: string; content?: string | ContentBlock[]; sessionId: string; history?: ChatMessage[] },
    opts: RuntimeOptions & { onBlock: (b: ContentBlock) => void },
  ): Promise<RuntimeResult> {
    const { bot, text, sessionId } = input;
    const userContent: string | ContentBlock[] = input.content ?? text;
    const rawOnBlock = opts.onBlock;
    const liveKey = this.openLive(bot.id, sessionId, input.from, userContent, !!opts.skipUserRecord);
    opts = { ...opts, skipUserRecord: true, onBlock: (b) => { rawOnBlock(b); this.absorbLive(liveKey, b); } };
    const reasoning = needsReasoning(bot, text, opts);
    // 复杂任务 / 无人值守给更多工具轮数；用完时再收尾一轮总结，不直接报错
    const maxRounds = opts?.maxToolRounds ?? (reasoning || opts.unattended ? 12 : 6);
    const bound = this.deps.providers.get(bot.providerId);
    const provider = bound || this.deps.providers.getDefault();
    // bot 绑定的 provider 不存在而回落到默认时，模型名也跟随默认 provider，避免把别家模型名发给它
    const baseModel = bound ? bot.model : undefined;
    const started = Date.now();
    if (!provider) {
      const offline = this.deps.offline ?? new OfflinePersona();
      const reply = offline.reply(bot, text, this.deps.memory.list(bot.id));
      opts.onBlock({ type: "text", text: reply });
      this.recordRich(bot.id, sessionId, userContent, [{ type: "text", text: reply }], { latencyMs: Date.now() - started }, input.from);
      return { text: reply, toolCalls: [], usedSkills: [], content: [{ type: "text", text: reply }] };
    }
    const thinkModel = opts.think && provider.kind === "openai-compat" ? thinkingModelOf(provider) : null;
    const model = thinkModel ?? baseModel;
    const useNative = () => !thinkModel && supportsNativeTools(provider, model);
    const window = contextWindowOf(provider, model);
    /** 这一轮所有模型调用的用量（工具轮、推理预想、自检、压缩、收尾） */
    const meter = { input: 0, output: 0, calls: 0, cached: 0 };
    const meterAdd = (r?: Pick<CompletionResult, "usage"> | null) => {
      meter.calls++;
      meter.input += r?.usage?.inputTokens ?? 0;
      meter.output += r?.usage?.outputTokens ?? 0;
      meter.cached += r?.usage?.cachedTokens ?? 0;
    };
    let planNote = "";
    // 首次加载本地向量模型要十几秒，这里最多等 3 秒，没回来就这一轮不带回想
    const recalled = this.deps.recall && text.trim().length >= 4
      ? await Promise.race([this.deps.recall(bot, text, sessionId).catch(() => ""), new Promise<string>((r) => setTimeout(() => r(""), 3000))])
      : "";
    const recallNote = recalled ? `\n\n${recalled}` : "";
    const turn: TurnCtx = { sources: [], userImages: Array.isArray(userContent) ? userContent.filter((b) => b.type === "image") : [], signal: opts.signal, unattended: opts.unattended };
    /** 推理模型的预先思考：显示成思考块，并作为执行思路注入上下文 */
    const preThought: ContentBlock[] = [];
    if (reasoning) {
      const t0 = Date.now();
      // 推理过程实时显示成思考块（不然前十几秒界面只有「处理中」）
      opts.onBlock({ type: "thinking", text: "先想一下怎么做…\n" });
      const plan = await this.preThink(provider, bot, text, opts, opts.signal, (delta) => opts.onBlock({ type: "thinking", text: delta }), meterAdd);
      if (opts.signal?.aborted) {
        const msg = "（已停止生成）";
        this.recordRich(bot.id, sessionId, userContent, [{ type: "text", text: msg }], { latencyMs: Date.now() - started }, input.from, opts.skipUserRecord);
        return { text: "", toolCalls: [], usedSkills: [], content: [{ type: "text", text: msg }] };
      }
      if (plan) {
        planNote = `\n\n【执行思路（推理模型预先想好的，按它执行；以工具真实结果为准，发现不对就调整）】\n${plan}`;
        preThought.push({ type: "thinking", text: plan, ms: Date.now() - t0 });
      }
    }

    // 整个请求里系统提示保持不变，工具往来只追加在末尾，前缀缓存才能逐轮命中
    const context = this.prompt.buildContext(bot, text, { ...opts, nativeTools: useNative() }) + (opts.think && !thinkModel ? `\n\n${THINK_PROMPT}` : "");
    const turnContext = this.prompt.volatileContext(bot, text, opts) + recallNote + planNote;
    // G1：预算裁剪历史（超预算压缩最旧段为 summary，lastSeq 去重）
    const session = this.deps.store.getSession(sessionId);
    const nameOf = (id: string) => this.deps.store.getBot(id)?.name ?? id;
    const history = (input.history ?? []).map((m) =>
      m.role === "assistant" && m.from !== bot.id
        ? { ...m, role: "user" as const, content: `[${nameOf(m.from)} 说] ${contentText(m.content)}` }
        : m.from === bot.id && Array.isArray(m.content) && m.content.some((b) => b.type === "choice" || b.type === "secret")
          ? { ...m, content: ownHistoryText(m.content) }
          : m);
    const trimmed = await trimHistoryToBudget(history, session?.lastSeq ?? 0, async (msgs) => {
      try {
        const r = await this.deps.providers.complete(provider, {
          system: "把以下对话（可能含已有摘要）合并压缩为一份要点摘要（中文，不超过 12 条），保留人名、决定、待办与关键数字，不要多余内容。",
          user: msgs.map((m) => `${m.role}: ${m.content}`).join("\n"),
          model: baseModel,
          signal: AbortSignal.timeout(45_000),
        });
        meterAdd(r);
        return r.text;
      } catch {
        return null;
      }
    }, { budgetTokens: opts?.budgetTokens ?? historyBudgetOf(window), prevSummary: session?.summary, systemTokens: textTokens(context) + textTokens(turnContext) });
    if (trimmed.compressed) {
      this.deps.store.ensureSession(sessionId, bot.id);
      this.deps.store.markCompacted(sessionId, trimmed.compactedUpToSeq, trimmed.summaryText);
    }
    const conversation: { role: string; content: string }[] = trimmed.messages;
    const toolCalls: ToolCall[] = [];
    const usedSkills: string[] = [];
    const memoryEvents: MemoryEntry[] = [];
    const acc: ContentBlock[] = [];
    /** 已完成轮次的过程：每轮「一句旁白 + 工具卡片」，界面按此拆成多条短消息 */
    const timeline: ContentBlock[] = [...preThought];
    const attachments: ContentBlock[] = [];
    let roundStart = 0;
    const push = (b: ContentBlock) => { opts.onBlock(b); if (b.type !== "retract") acc.push(b); };
    const roundText = () => acc.slice(roundStart).filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
    /** 撤回本轮已推送的正文（纠偏丢弃 / 截断工具块后的假结果） */
    const retractRoundText = (keep?: string) => {
      for (let i = acc.length - 1; i >= roundStart; i--) if (acc[i].type === "text") acc.splice(i, 1);
      opts.onBlock({ type: "retract" });
      if (keep) push({ type: "text", text: keep });
    };
    const finish = (body: ContentBlock[], replyText: string, meta?: MessageMeta) => {
      // 流式时撤回的旁白仍可能留在 timeline：若后文几乎复述前文，落盘时丢掉较短/较早的那段，避免「整轮结束格式一跳还像重复」
      const coalesced = coalesceNarrationBlocks(body);
      const blocks = turn.sources.length ? [...coalesced, { type: "sources" as const, items: turn.sources }] : coalesced;
      const usage = meter.calls ? { usage: { ...meter }, tokensUsed: meter.input + meter.output || undefined } : {};
      this.recordRich(bot.id, sessionId, userContent, blocks, { ...(meta ?? { providerId: provider.id, latencyMs: Date.now() - started, streamed: true }), ...usage, ...opts.meta }, input.from, opts.skipUserRecord);
      if (meter.calls) this.deps.onUsage?.({ botId: bot.id, providerId: provider.id, model: model ?? provider.model, ...meter });
      return { text: replyText, toolCalls, memoryEvents, usedSkills, content: blocks };
    };
    /** 本轮结束前：用户定了规范 / bot 声称记下了，但没调用保存工具时兜底落盘，返回「已记住」卡片 */
    const saveTurnMemory = async (replyText: string): Promise<ContentBlock[]> => {
      const savedByTool = toolCalls.some((c) => ["memory.add", "memory.update", "memory.forget", "remember", "skill.save", "skill.update", "app.updateSelf", "env.set", "env.delete"].includes(c.tool));
      const events = await this.extractMemory(bot, opts.memoryText === undefined ? text : opts.memoryText, replyText, savedByTool, opts.autoEventMemory === true);
      memoryEvents.push(...events);
      const cards: ContentBlock[] = events.filter((e) => e.kind !== "event").map((e) => ({
        type: "tool_call", tool: "memory.add", callId: `m-${e.id}`, args: { content: e.content, kind: e.kind },
        result: `已记住${e.kind === "rule" ? "（规范）" : ""}${e.namespace === "global" ? "，所有 bot 共享" : ""}：${e.content}\n查看 / 修改：${memoryLink(bot, e.kind, e.namespace === "global")}`, status: "ok",
      }));
      cards.forEach((c) => opts.onBlock(c));
      return cards;
    };

    const stopped = (extra = "") => {
      const partial = stripToolBlocks(`${roundText()}${extra}`);
      // 已收完整句时不再追加「已停止」——避免话已说完气泡却像中途挂掉
      const done = /[。！？!?…」》）)]\s*$/.test(partial);
      const text = !partial ? "（已停止生成）" : done ? partial : `${partial}\n\n（已停止生成）`;
      return finish([...timeline, { type: "text", text }, ...attachments], partial);
    };

    const exchange: { role: string; content: string }[] = [];
    /** 同一段工具往来的原生形式（assistant tool_calls + tool 结果），端点支持原生工具时用它 */
    const tail: WireTurn[] = [];
    const failedCalls = new Map<string, string>();
    const canAsk = !!this.deps.askBot && (opts?.depth ?? 0) < 2;
    const mentioned = canAsk && !sessionId.startsWith("group-") ? this.prompt.mentionedBots(bot, text) : [];
    const note = this.prompt.stateNote(bot, mentioned, turnContext);
    let nudgedAsk = false, nudgedGround = false, nudgedChoice = false;
    let verified = false;
    const canUiCard = (opts?.depth ?? 0) === 0 && !sessionId.startsWith("group-") && !opts?.unattended;
    /** 最近一轮工具往来在 exchange / tail 里的起点：这之后的不截短 */
    let exKeep = 0, tailKeep = 0;
    const turnBudget = turnBudgetOf(window);
    const userForModel: string | ContentBlock[] = typeof userContent === "string" ? `${note}\n\n${userContent}` : [{ type: "text", text: note }, ...userContent];
    for (let round = 0; round < maxRounds; round++) {
      if (opts.signal?.aborted) return stopped();
      roundStart = acc.length;
      this.markLiveRound(liveKey);
      if (round > 0) {
        shrinkToolResults(exchange, turnBudget, exKeep, (t) => t.role === "user" && t.content.startsWith("[工具执行返回]"));
        shrinkToolResults(tail as Array<{ role: string; content: string }>, turnBudget, tailKeep, (t) => t.role === "tool" || (t.role === "user" && t.content.startsWith("[工具执行返回]")));
      }
      const msg = (role: string, content: string | ContentBlock[], meta?: MessageMeta): ChatMessage =>
        ({ sessionId, from: role === "assistant" ? bot.id : "user", to: bot.id, role: role as ChatMessage["role"], content, kind: "chat", createdAt: Date.now(), meta });
      const native = useNative();
      const history = conversation.map((m) => msg(m.role, m.content));
      if (!native && exchange.length) history.push(msg("user", userForModel, { inline: true }), ...exchange.slice(0, -1).map((m) => msg(m.role, m.content)));
      let r: CompletionResult;
      const cut = new AbortController();
      const relayAbort = () => cut.abort();
      opts.signal?.addEventListener("abort", relayAbort, { once: true });
      let cutAt: number | null = null;
      try {
        r = await this.deps.providers.streamComplete(provider, {
          model,
          system: context,
          history,
          user: native ? userForModel : exchange.at(-1)?.content ?? userForModel,
          ...(native ? { tools: [CALL_TOOL], tail: tail.length ? tail : undefined } : {}),
          stream: true,
          signal: cut.signal,
          _onChunk: (b: ContentBlock) => {
            if (cutAt !== null) return;
            push(b);
            if (b.type !== "text") return;
            cutAt = toolBlockCutoff(roundText());
            if (cutAt !== null) cut.abort();
          },
        });
      } catch (e) {
        if (opts.signal?.aborted) return stopped();
        if (cutAt === null) throw e;
        r = { text: "", content: [] };
      } finally {
        opts.signal?.removeEventListener("abort", relayAbort);
      }
      meterAdd(r);
      if (opts.signal?.aborted) {
        // cursor 等 CLI 可能在 kill 前已带回比流式更长的全文
        const cur = stripToolBlocks(roundText());
        const fuller = stripToolBlocks(r.text || "");
        if (fuller.length > cur.length) {
          if (fuller.startsWith(cur)) return stopped(fuller.slice(cur.length));
          retractRoundText(fuller);
        }
        return stopped();
      }
      if (cutAt !== null) {
        const kept = roundText().slice(0, cutAt);
        retractRoundText(kept);
        r = { ...r, text: kept, content: (r.content ?? []).filter((b) => b.type !== "text") };
      }

      // 结构化 tool_call 块（适配器返回）优先；否则解析 ```tool``` 文本块
      const structCalls = (r.content ?? []).filter((b: ContentBlock): b is ContentBlock & { type: "tool_call" } => b.type === "tool_call");
      const textReply = r.text || roundText();
      let tools: ToolInvocation[] = [];
      if (structCalls.length) {
        tools = structCalls.map((b, i) => ({ callId: b.callId ?? `c${Date.now()}-${toolCalls.length}-${i}`, ...this.unwrapNativeCall(b.tool, b.args ?? {}) }));
      } else {
        tools = parseToolBlocks(textReply);
      }
      // 动作落地：用模型对照事实判断（替代词表 claims*）；与深度思考的 selfCheck 同族；闲聊跳过
      // 本轮已解析出工具时跳过：马上要真执行，再烧一轮核对只拖延迟；收尾空口完成态才核对
      const toolsNames = tools.map((t) => t.tool);
      const priorNames = toolCalls.map((c) => c.tool);
      /** 落地检查撤回了夸大正文，但仍保留本轮工具 → 后面不再把正文塞回时间线 */
      let groundStripped = false;
      if (!nudgedGround && !tools.length && round < maxRounds - 1 && shouldActionGround(textReply, toolsNames, priorNames)) {
        const view = this.deps.codingPresence?.groundingSnapshot?.(bot.id)
          ?? this.deps.codingPresence?.snapshot(bot.id);
        const others = view?.others?.map((o) => ({
          cwd: o.cwd,
          program: o.program?.kind,
          cli: o.cli,
          phase: o.phase,
        }));
        const ground = await this.actionGrounding(provider, baseModel, textReply, {
          toolsThisRound: toolsNames,
          priorTools: priorNames,
          terminal: view
            ? {
              phase: view.phase,
              program: view.program?.kind,
              cli: view.cli,
              cwd: view.cwd,
              notice: view.notice,
            }
            : null,
          otherTerminals: others,
        }, opts.signal, meterAdd);
        if (opts.signal?.aborted) return stopped();
        if (!ground.ok) {
          nudgedGround = true;
          if (tools.length) {
            // 本轮已有工具块：只撤回夸大正文，照常执行工具（避免丢掉 group.send / cli.agent）
            retractRoundText();
            groundStripped = true;
          } else {
            retractRoundText();
            const how = native ? "调用 call_tool" : "输出 ```tool 工具块";
            const nudge = `[系统检查] 回复与事实不符：\n${ground.issues.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n界面上那段不实回复已撤回。需要做事就${how}（进 Cursor/改仓库用 cli.agent；发群用 group.send；建技能用 skill.save），等工具结果后再说；点「打开」只起 shell。不要道歉，不要提这次检查。`;
            exchange.push({ role: "assistant", content: textReply }, { role: "user", content: nudge });
            tail.push({ role: "assistant", content: textReply }, { role: "user", content: nudge });
            continue;
          }
        }
      }
      /** 假转问 / 强选项：同轮直接代跑工具，禁止「撤回 → 再烧一轮只为吐工具块」 */
      let autoLed = false;
      if (!tools.length) {
        const faked = !nudgedAsk && canAsk ? this.prompt.fakedDelegation(bot, textReply, toolCalls, mentioned) : null;
        if (faked) {
          nudgedAsk = true;
          retractRoundText();
          const askMsg = (() => {
            const re = new RegExp(`@${faked.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "g");
            return text.replace(re, "").trim() || text.trim() || "请根据上下文直接回复。";
          })();
          const lead = `我去问一下「${faked}」。`;
          push({ type: "text", text: lead });
          timeline.push({ type: "text", text: lead });
          tools = [{ callId: `auto-ask-${Date.now()}`, tool: "bot.ask", args: { to: faked, message: askMsg } }];
          autoLed = true;
        } else if (!nudgedChoice && canUiCard) {
          const offer = detectChoiceOffer(textReply);
          if (offer?.kind === "hard") {
            nudgedChoice = true;
            retractRoundText();
            const cleanedLead = stripToolBlocks(textReply);
            const intro = cleanedLead.split("\n").map((l) => l.trim()).find((l) => l && !/^\d{1,2}[.、)）]/.test(l) && !/^[A-Da-d][.、)）]/.test(l) && !/^[-•*]/.test(l));
            const lead = (intro && intro.length <= 80 ? intro : null) || offer.question;
            push({ type: "text", text: lead });
            timeline.push({ type: "text", text: lead });
            tools = [{ callId: `auto-ui-${Date.now()}`, tool: "ui.ask", args: { question: offer.question, options: offer.options } }];
            autoLed = true;
          }
        }
      }
      if (!tools.length) {
        if (reasoning && !verified && round < maxRounds - 1 && textReply.trim()) {
          verified = true;
          const verdict = await this.selfCheck(provider, baseModel, text, timeline, textReply, opts.signal, meterAdd);
          if (opts.signal?.aborted) return stopped();
          if (!verdict.ok) {
            retractRoundText();
            const fix = `[自检] 这份回复还有问题：\n${verdict.issues.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n界面上那段回复已撤回。需要补查的就调用工具，然后给出修正后的完整最终回复（不要提这次自检，不要道歉）。`;
            const note: ContentBlock = { type: "thinking", text: `自检发现：${verdict.issues.join("；")}，正在修正` };
            opts.onBlock(note);
            timeline.push(note);
            exchange.push({ role: "assistant", content: textReply }, { role: "user", content: fix });
            tail.push({ role: "assistant", content: textReply }, { role: "user", content: fix });
            continue;
          }
        }
        const cleaned = stripToolBlocks(textReply);
        const fromContent = (r.content ?? []).filter((b) => b.type !== "tool_call" && !(b.type === "text" && !String((b as { text?: string }).text ?? "").trim()));
        const finalBlocks = fromContent.length
          ? fromContent.map((b) => (b.type === "text" ? { ...b, text: stripToolBlocks(String((b as { text?: string }).text ?? "")) } : b)).filter((b) => b.type !== "text" || String((b as { text?: string }).text ?? "").trim())
          : (cleaned ? [{ type: "text" as const, text: cleaned }] : []);
        const meta: MessageMeta = { providerId: provider.id, model: model ?? provider.model, latencyMs: Date.now() - started, tokensUsed: r.usage ? (r.usage.inputTokens ?? 0) + (r.usage.outputTokens ?? 0) : undefined, streamed: true };
        // 层 2：建议/方案枚举 → 软芯片（不 halt）
        if (canUiCard && cleaned) {
          const soft = detectChoiceOffer(cleaned);
          if (soft?.kind === "soft") meta.suggestions = soft.options;
        }
        const memCards = await saveTurnMemory(cleaned || textReply);
        return finish([...timeline, ...finalBlocks, ...memCards, ...attachments], cleaned || textReply, meta);
      }

      const thought = (r.content ?? []).find((b) => b.type === "thinking");
      if (thought) timeline.push(thought);
      // 代跑 / 落地撤回已写过旁白；有工具时撤回直播正文，去掉夹带的裸 JSON
      const say = autoLed || groundStripped ? "" : stripToolBlocks(textReply);
      if (!autoLed && !groundStripped) retractRoundText(say || undefined);
      if (say) timeline.push({ type: "text", text: say });

      // 执行工具并回填
      // 同一轮里的多个 bot.ask 并行分派（总耗时取最慢的成员），其余工具按顺序执行
      const results: string[] = [];
      /** 同轮已跑过的 bot.ask（to+message）：重复调用只把结果回给模型，不再刷第二张转问卡 */
      const askedOnce = new Set<string>();
      const runOne = async (t: ToolInvocation) => {
        const sig = `${t.tool} ${JSON.stringify(t.args)}`;
        if (failedCalls.has(sig)) {
          return { t, r2: { output: `❌ 这个调用刚才已经失败过（${failedCalls.get(sig)}），重试结果不会变。不要再调用它，换别的办法，或者直接告诉用户做不到以及原因。` } as ToolOutcome, quiet: false };
        }
        const askSig = t.tool === "bot.ask"
          ? `${String(t.args?.to ?? t.args?.bot ?? t.args?.name ?? "").trim()}\0${String(t.args?.message ?? t.args?.text ?? t.args?.question ?? "")}`
          : "";
        const quietAsk = !!askSig && askedOnce.has(askSig);
        if (askSig) askedOnce.add(askSig);
        if (!QUIET_TOOLS.has(t.tool) && !quietAsk) opts.onBlock({ type: "tool_call", tool: t.tool, callId: t.callId, args: t.args, status: "running" });
        turn.onToolProgress = (note) => {
          if (!QUIET_TOOLS.has(t.tool) && !quietAsk) opts.onBlock({ type: "tool_call", tool: t.tool, callId: t.callId, args: t.args, status: "running", result: note.slice(0, 500) });
        };
        const r2 = await this.executeTool(bot, t, text, opts?.depth ?? 0, sessionId, turn);
        if (r2.output.startsWith("❌")) failedCalls.set(sig, r2.output.slice(0, 120));
        return { t, r2, quiet: quietAsk };
      };
      const outcomes = tools.every((t) => t.tool === "bot.ask")
        ? await mapPool(tools, BOT_ASK_CONCURRENCY, runOne)
        : await tools.reduce(async (prev, t) => {
          if (opts.signal?.aborted) return prev;
          return [...(await prev), await runOne(t)];
        }, Promise.resolve([] as { t: ToolInvocation; r2: ToolOutcome; quiet: boolean }[]));
      if (opts.signal?.aborted) return stopped();
      let halt = false;
      for (const { t, r2, quiet } of outcomes) {
        if (r2.blocks) attachments.push(...r2.blocks);
        if (r2.halt) halt = true;
        results.push(`工具 ${t.tool} 结果：${r2.output}`);
        toolCalls.push({ id: t.callId, tool: t.tool, args: t.args });
        if (t.tool.startsWith("skill:")) usedSkills.push(t.tool.slice(6));
        if (QUIET_TOOLS.has(t.tool) || quiet) continue;
        const card: ContentBlock = { type: "tool_call", tool: t.tool, callId: t.callId, args: t.args, result: r2.output.slice(0, t.tool === "bot.ask" ? 4000 : 500), status: r2.output.startsWith("❌") ? "error" : "ok" };
        push(card);
        timeline.push(card);
      }
      // 向用户提问 / 请求确认 / 请求密钥：本轮到此为止，等用户操作后作为新消息继续
      if (halt) {
        const memCards = await saveTurnMemory(say);
        return finish([...timeline, ...memCards, ...attachments], say);
      }
      exKeep = exchange.length;
      tailKeep = tail.length;
      const echoed = `[工具执行返回]\n${results.join("\n")}\n\n${CONTINUE_HINT}`;
      exchange.push({ role: "assistant", content: toolRoundEcho(say, tools) }, { role: "user", content: echoed });
      if (structCalls.length) {
        tail.push({ role: "assistant", content: say, toolCalls: tools.map((t) => ({ id: t.callId, name: CALL_TOOL.name, args: { tool: t.tool, args: t.args } })) });
        tools.forEach((t, i) => tail.push({ role: "tool", id: t.callId, content: `${results[i] ?? ""}${i === tools.length - 1 ? `\n\n${CONTINUE_HINT}` : ""}` }));
      } else {
        tail.push({ role: "assistant", content: toolRoundEcho(say, tools) }, { role: "user", content: echoed });
      }
    }
    // 轮数用完：不再给工具，让模型根据已有结果收尾（做完的、没做完的、下一步）
    let wrap = "";
    try {
      const transcript = [...conversation, { role: "user", content: typeof userContent === "string" ? userContent : contentText(userContent) }, ...exchange]
        .map((m) => `${m.role === "assistant" ? bot.name : "用户/系统"}：${m.content}`).join("\n\n").slice(-12_000);
      const r = await abortable(this.deps.providers.complete(provider, {
        model: baseModel,
        system: `${bot.systemPrompt || `${bot.name}（${bot.role}）`}\n\n这次任务的工具调用轮数已经用完，不能再调用任何工具。根据下面已经拿到的结果直接给用户最终回复：先交付已经完成的部分，再用一两句话说明还没做完的部分和建议的下一步（用户回复「继续」就会接着做）。不要输出工具块。`,
        user: transcript,
        signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
      }), opts.signal);
      meterAdd(r);
      wrap = stripToolBlocks(r.text).trim();
    } catch (e) {
      if (opts.signal?.aborted) return stopped();
      const err = e instanceof Error ? e.message : String(e);
      wrap = `（收尾失败：${err.slice(0, 200)}。已有结果见上方，回复「继续」可接着做。）`;
    }
    const fallback = wrap || "（这次任务步骤较多，工具调用轮数已用完。回复「继续」我接着做。）";
    opts.onBlock({ type: "text", text: fallback });
    const memCards = await saveTurnMemory(fallback);
    return finish([...timeline, { type: "text", text: fallback }, ...memCards, ...attachments], fallback, { providerId: provider.id, latencyMs: Date.now() - started, streamed: true });
  }

  private liveKey(sessionId: string, botId: string) {
    return `${sessionId}\0${botId}`;
  }

  /** 回合一开始就把用户的话写下。群聊等调用方已经记过用户消息时跳过 */
  private openLive(botId: string, sessionId: string, from: string, userContent: string | ContentBlock[], skipUser: boolean): string {
    const key = this.liveKey(sessionId, botId);
    const prev = this.liveTurns.get(key);
    if (prev) this.disarmLive(prev);
    const kind = from === "user" ? "chat" as const : "bot-to-bot" as const;
    const slot: LiveTurn = { sessionId, botId, from, kind, blocks: [], roundAt: 0, sealed: false, userSaved: skipUser };
    this.liveTurns.set(key, slot);
    if (!skipUser) {
      this.deps.store.addMessage({ sessionId, from, to: botId, role: "user", content: userContent, kind, createdAt: Date.now() });
      slot.userSaved = true;
    }
    return key;
  }

  /** 新的一轮模型输出从这里开始，撤回只丢掉这一轮的正文 */
  private markLiveRound(key: string) {
    const slot = this.liveTurns.get(key);
    if (slot) slot.roundAt = slot.blocks.length;
  }

  /** 把界面上已经出现的块收进草稿。相邻正文拼成一段，同一工具卡片就地更新 */
  private absorbLive(key: string, b: ContentBlock) {
    const slot = this.liveTurns.get(key);
    if (!slot || slot.sealed) return;
    if (b.type === "retract") {
      while (slot.blocks.length > slot.roundAt && slot.blocks.at(-1)?.type === "text") slot.blocks.pop();
      this.armLive(key);
      return;
    }
    if (b.type === "text") {
      if (!b.text) return;
      const last = slot.blocks.at(-1);
      if (last?.type === "text" && slot.blocks.length - 1 >= slot.roundAt) last.text = `${last.text ?? ""}${b.text}`;
      else slot.blocks.push({ type: "text", text: b.text });
    } else if (b.type === "thinking") {
      if (!b.text) return;
      const last = slot.blocks.at(-1);
      if (last?.type === "thinking" && !last.ms && !b.ms) last.text = `${last.text ?? ""}${b.text}`;
      else slot.blocks.push({ ...b });
    } else if (b.type === "tool_call" && b.callId) {
      const i = slot.blocks.findIndex((x) => x.type === "tool_call" && x.callId === b.callId);
      if (i >= 0) slot.blocks[i] = b;
      else slot.blocks.push(b);
    } else slot.blocks.push(b);
    this.armLive(key);
  }

  private armLive(key: string) {
    const slot = this.liveTurns.get(key);
    if (!slot || slot.timer || slot.sealed || !slot.blocks.length) return;
    const timer = setTimeout(() => {
      slot.timer = undefined;
      this.writeLive(key);
    }, 400);
    timer.unref?.();
    slot.timer = timer;
  }

  private disarmLive(slot: LiveTurn) {
    if (!slot.timer) return;
    clearTimeout(slot.timer);
    slot.timer = undefined;
  }

  private writeLive(key: string) {
    const slot = this.liveTurns.get(key);
    if (!slot || slot.sealed || !slot.blocks.length) return;
    const meta: MessageMeta = { streamed: true, partial: true };
    if (slot.draftId) {
      // 通知界面替换同一条，避免只留下第一眼的「已深度思考」、正文要等整轮结束才冒出来
      this.deps.store.updateMessage(slot.sessionId, slot.draftId, (m) => ({ ...m, content: slot.blocks, meta: { ...m.meta, partial: true } }), true);
    } else {
      const msg = this.deps.store.addMessage({
        sessionId: slot.sessionId, from: slot.botId, to: slot.from, role: "assistant",
        content: slot.blocks, kind: slot.kind, createdAt: Date.now(), meta,
      });
      slot.draftId = msg.id;
    }
  }

  /**
   * 应用退出时把每一轮已经写出来的内容留下。
   * 之后这轮若还能正常收尾，不再覆盖这条，避免退出过程中把草稿删掉。
   */
  flushInflight(): void {
    for (const [key, slot] of this.liveTurns) {
      this.disarmLive(slot);
      if (slot.sealed) continue;
      const note = "（回复未完成，应用已退出）";
      const hasNote = slot.blocks.some((b) => b.type === "text" && b.text?.includes(note));
      if (!hasNote) slot.blocks.push({ type: "text", text: note });
      this.writeLive(key);
      slot.sealed = true;
    }
  }

  /** 这一轮中途失败：留下已经写出的内容，并补上失败原因。没有进行中的回合时返回 false */
  failLive(botId: string, sessionId: string, errText: string): boolean {
    const key = this.liveKey(sessionId, botId);
    const slot = this.liveTurns.get(key);
    if (!slot) return false;
    this.disarmLive(slot);
    if (!slot.sealed) {
      slot.blocks.push({ type: "text", text: errText });
      this.writeLive(key);
      if (slot.draftId) this.deps.store.updateMessage(slot.sessionId, slot.draftId, (m) => ({ ...m, meta: { ...m.meta, partial: undefined } }), true);
    }
    this.liveTurns.delete(key);
    return true;
  }

  /** 记录富消息（用户 + 助手内容块数组 + meta）。这一轮已经在写草稿时，改那一条，不另起一条 */
  private recordRich(botId: string, sessionId: string, userText: string | ContentBlock[], blocks: ContentBlock[], meta?: MessageMeta, from = "user", skipUser = false) {
    const key = this.liveKey(sessionId, botId);
    const slot = this.liveTurns.get(key);
    if (slot) this.disarmLive(slot);
    if (slot?.sealed) {
      this.liveTurns.delete(key);
      return;
    }
    const kind = from === "user" ? "chat" as const : "bot-to-bot" as const;
    if (!skipUser && !slot?.userSaved) this.deps.store.addMessage({ sessionId, from, to: botId, role: "user", content: userText, kind, createdAt: Date.now() });
    const done: MessageMeta = { ...meta, partial: undefined };
    if (slot?.draftId) {
      this.deps.store.updateMessage(sessionId, slot.draftId, (m) => ({ ...m, content: blocks, meta: done }), true);
    } else {
      this.deps.store.addMessage({ sessionId, from: botId, to: from, role: "assistant", content: blocks, kind, createdAt: Date.now(), meta: done });
    }
    this.liveTurns.delete(key);
  }

  /** 模型路由：复杂任务先交给推理模型想执行思路（没有推理模型就用本模型），失败返回 null 不影响主流程 */
  private async preThink(provider: Provider, bot: Bot, text: string, opts: RuntimeOptions, signal?: AbortSignal, onDelta?: (s: string) => void, onUsage?: (r: CompletionResult) => void): Promise<string | null> {
    const thinker = provider.kind === "openai-compat" ? thinkingModelOf(provider) : null;
    const system = `${this.prompt.buildContext(bot, text, { ...opts, nativeTools: false })}\n\n【现在的任务】你只负责先把这件事想清楚，不调用工具、不直接回复用户。用不超过 300 字写出执行思路：1) 用户真正要的产出；2) 关键约束和容易出错的地方；3) 分几步做，每步用哪个工具或交给哪个 bot（有依赖的按顺序）；4) 怎样算做完。细节没说清时写出你会采用的合理假设，直接按假设交付；只有缺了就完全没法做（比如不知道要处理哪个文件）才计划先问用户。只写思路本身。`;
    try {
      const r = await abortable(this.deps.providers.streamComplete(provider, {
        model: thinker ?? (this.deps.providers.get(bot.providerId) ? bot.model : undefined),
        system,
        user: `${this.prompt.stateNote(bot, [], this.prompt.volatileContext(bot, text, opts))}\n\n${text}`,
        stream: true,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
        _onChunk: (b: ContentBlock) => { if ((b.type === "thinking" || b.type === "text") && b.text) onDelta?.(b.text); },
      }), signal);
      onUsage?.(r);
      return stripToolBlocks(r.text).trim().slice(0, 1500) || null;
    } catch {
      return null;
    }
  }

  /**
   * 动作落地核对（与 selfCheck 同族）：把工具/终端等事实交给模型判断，
   * 不靠中文词表猜「有没有声称做过」。失败则撤回并打回。
   */
  private async actionGrounding(
    provider: Provider,
    model: string | undefined,
    reply: string,
    facts: {
      toolsThisRound: string[];
      priorTools: string[];
      terminal?: { phase?: string; program?: string; cli?: string; cwd?: string; notice?: string } | null;
      otherTerminals?: Array<{ cwd?: string; program?: string; cli?: string; phase?: string }>;
    },
    signal?: AbortSignal,
    onUsage?: (r: CompletionResult) => void,
  ): Promise<{ ok: boolean; issues: string[] }> {
    const factBlock = buildActionGroundingFacts(facts);
    const risk = [...facts.toolsThisRound, ...facts.priorTools].some((t) => GROUNDING_RISK_TOOLS.has(t));
    const pass = (): { ok: boolean; issues: string[] } =>
      risk ? { ok: false, issues: ["落地核对失败，高风险动作暂不采信空口完成态"] } : { ok: true, issues: [] };
    if (this.deps.judgeAction) {
      try {
        return await this.deps.judgeAction({ reply, facts: factBlock });
      } catch {
        return pass();
      }
    }
    // 单测假上游（baseUrl 含 fake）不联网；真实环境走模型，与 selfCheck 同族
    if (/\/\/fake\b/i.test(provider.baseUrl ?? "")) return { ok: true, issues: [] };
    try {
      const r = await abortable(this.deps.providers.complete(provider, {
        model,
        temperature: 0,
        system: ACTION_GROUNDING_SYSTEM,
        user: `【事实】\n${factBlock}\n\n【待发出的回复】\n${reply.slice(0, 6000)}`,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      }), signal);
      onUsage?.(r);
      return parseVerdict(r.text, { failClosed: risk });
    } catch {
      return pass();
    }
  }

  /** 自检：深度思考路径上核对完整性与依据（动作落空已由 actionGrounding 覆盖） */
  private async selfCheck(provider: Provider, model: string | undefined, request: string, timeline: ContentBlock[], reply: string, signal?: AbortSignal, onUsage?: (r: CompletionResult) => void): Promise<{ ok: boolean; issues: string[] }> {
    const record = timeline.flatMap((b) => b.type === "tool_call" ? [`- ${b.tool} ${JSON.stringify(b.args ?? {}).slice(0, 200)} → ${(b.result ?? "").slice(0, 600)}`] : []).join("\n") || "（没有调用工具）";
    try {
      const r = await abortable(this.deps.providers.complete(provider, {
        model,
        temperature: 0,
        system: "你是严格的质检员，检查一份即将发给用户的回复：1) 是否回应了请求里的每个要点，产出是否完整可用；2) 声称已经做过的操作、转述的别的 bot 的话、联网得到的数据，是否在工具记录里有依据；3) 有没有明显的逻辑错误或前后矛盾。措辞、风格、长短不算问题；常识性内容不需要工具依据。只输出 JSON：{\"ok\":true} 或 {\"ok\":false,\"issues\":[\"具体问题\"]}",
        user: `【用户请求】\n${request.slice(0, 3000)}\n\n【工具记录】\n${record}\n\n【待发出的回复】\n${reply.slice(0, 6000)}`,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
      }), signal);
      onUsage?.(r);
      return parseVerdict(r.text);
    } catch {
      return { ok: true, issues: [] };
    }
  }

  /** 原生调用 → 内部工具调用：call_tool(tool, args)；也兼容模型直接把工具名当函数名、参数摊平 */
  private unwrapNativeCall(name: string, args: Record<string, unknown>): { tool: string; args: Record<string, unknown> } {
    const normalize = (tool: string, inner: Record<string, unknown>) => {
      const t = canonicalizeTool(tool);
      if (t === "ui.ask" && !inner.options && (inner.choices || inner.items)) {
        return { tool: t, args: { ...inner, options: inner.choices ?? inner.items } };
      }
      return { tool: t, args: inner };
    };
    if (name === CALL_TOOL.name) {
      const tool = String(args.tool ?? args.name ?? "").trim();
      const inner = args.args && typeof args.args === "object" && !Array.isArray(args.args)
        ? args.args as Record<string, unknown>
        : typeof args.args === "string" ? (() => { try { return JSON.parse(args.args as string); } catch { return {}; } })()
        : Object.fromEntries(Object.entries(args).filter(([k]) => k !== "tool" && k !== "name"));
      return normalize(tool, inner);
    }
    if (this.tools.has(name) || TOOL_ALIASES[name] || TOOL_ALIASES[name.toLowerCase()]) return normalize(name, args);
    const dotted = name.replace(/__/g, ":").replace(/_/g, ".");
    return normalize(this.tools.has(dotted) ? dotted : name, args);
  }

  /** bot 自己的工作目录（不存在就建） */
  workspaceOf(bot: Bot): string | null {
    return this.prompt.workspaceOf(bot);
  }

  /** 执行工具：先填 {{secret:}}，再交给注册表 */
  private async executeTool(bot: Bot, t: ToolInvocation, originalText: string, depth = 0, sessionId?: string, turn: TurnCtx = { sources: [] }): Promise<ToolOutcome> {
    let used: string[] = [];
    const canon = canonicalizeTool(t.tool);
    if (canon !== t.tool) t = { ...t, tool: canon };
    if (t.tool === "ui.ask" && t.args && !t.args.options && (t.args.choices || t.args.items)) {
      t = { ...t, args: { ...t.args, options: t.args.choices ?? t.args.items } };
    }
    const raw = t.args ?? {};
    let args = raw;
    if (turn.signal?.aborted) return { output: "❌ 用户已停止，这一步没有执行" };
    if (turn.unattended && t.tool.startsWith("ui.")) {
      return { output: "❌ 现在是无人值守的自动执行，没有用户能回答或确认。不要再提问，信息不全就自己做合理假设（在产出开头写明假设），直接完成任务。" };
    }
    if (turn.unattended) {
      const kind = unattendedApprovalKind(t.tool);
      if (kind && this.deps.consent?.permissionMode(bot.id) !== "always") {
        return { output: `例行停在批准点：这一步是${kind}（${t.tool}）。bot 不是 Always 时，没人在场不能做。把待批准的事写进回复，不要假装已经完成。` };
      }
    }
    const terminalTool = t.tool === "cli.agent" || t.tool === "cli.term" || t.tool.startsWith("term.");
    const browserTool = t.tool.startsWith("browser.");
    if (terminalTool && JSON.stringify(args).includes("{{secret:")) {
      if (!turn.unattended && !this.terminalSecretsReady(bot, args)) {
        return { output: "❌ 这个目录还没信任，密钥不会进终端。对该目录点「总是允许」，或把 bot 设为 Auto / Always 之后，再用 {{secret:名字}} 或 $名字。" };
      }
      if (!this.deps.secrets) return { output: "❌ 密钥库未启用" };
      const filled = this.deps.secrets.fill(args, bot.id);
      if (filled.missing.length) {
        return { output: `❌ 密钥未设置：${filled.missing.join("、")}。用 ui.secret 请用户填写（账号级保险库，保存后所有 bot 都能用）` };
      }
      args = filled.args;
      this.deps.audit?.append({ botId: bot.id, cap: "secret", action: `use:${t.tool}`, args: filled.used.join(","), granted: true, ok: true });
    }
    if (browserTool && t.tool === "browser.type" && JSON.stringify(args).includes("{{secret:")) {
      if (!turn.unattended && !this.browserSecretsReady(bot)) {
        return { output: "❌ 还没批准开浏览器，密钥不会填进去。先 browser.open 并点「以后不再问」，或把 bot 设为 Auto / Always。" };
      }
      if (!this.deps.secrets) return { output: "❌ 密钥库未启用" };
      const filled = this.deps.secrets.fill(args, bot.id);
      if (filled.missing.length) {
        return { output: `❌ 密钥未设置：${filled.missing.join("、")}。用 ui.secret 请用户填写` };
      }
      args = filled.args;
      this.deps.audit?.append({ botId: bot.id, cap: "secret", action: `use:${t.tool}`, args: filled.used.join(","), granted: true, ok: true });
    }
    // ui.* 需要看到未替换的密钥占位，所以不预填；其它工具执行前替换。终端/浏览器在上面已按信任填过。
    if (!terminalTool && !browserTool && !t.tool.startsWith("ui.") && this.deps.secrets && JSON.stringify(args).includes("{{")) {
      // 网址会被对方服务器记录：密钥不能拼进联网请求
      if (t.tool === "web.search" || t.tool === "web.fetch") return { output: "❌ 联网搜索 / 打开网页不能带 {{secret:}} 密钥。需要用密钥调接口时用 bash.run（会请用户确认）" };
      const filled = this.deps.secrets.fill(args, bot.id);
      if (filled.missing.length) {
        return { output: `❌ 密钥未设置：${filled.missing.join("、")}。用 ui.secret 请用户填写（账号级保险库，保存后所有 bot 都能用 {{secret:名字}}）` };
      }
      args = filled.args;
      used = filled.used;
    }
    if (t.tool === "bash.run") {
      const cmd = String(raw.command ?? "");
      const env: Record<string, string> = this.deps.env?.envFor(bot.id) ?? {};
      for (const n of this.deps.secrets?.referencedIn(cmd, bot.id) ?? []) {
        const v = this.deps.secrets!.get(n, bot.id);
        if (v === undefined) continue;
        env[n] = v;
        if (!used.includes(n)) used.push(n);
      }
      args = { ...args, shownCommand: cmd, signal: turn.signal, env, extraRisks: used.map((n) => `命令里用了密钥 ${n}`) };
    }
    const out = await this.tools.run({
      bot, tool: t.tool, args, originalText, depth, sessionId, turn,
    });
    if (used.length) this.deps.audit?.append({ botId: bot.id, cap: "secret", action: `use:${t.tool}`, args: used.join(","), granted: true, ok: !out.output.startsWith("❌") });
    const finalOut = used.length && this.deps.secrets ? { ...out, output: this.deps.secrets.redact(out.output, used) } : out;
    // 演示录制：引擎内对参数/输出打码；demo.* 自身会被跳过
    this.deps.demo?.record(bot.id, {
      tool: t.tool,
      args: raw,
      output: finalOut.output,
      ok: !finalOut.output.startsWith("❌"),
    });
    return finalOut;
  }

  /** 把内置 / 前缀工具挂进注册表（描述与执行同一处登记） */
  private installTools() {
    const R = this.tools;
    const turn = (ctx: { turn?: unknown }) => (ctx.turn as TurnCtx) ?? { sources: [] };

    R.register("file.send", "把文件/图片交付到对话。参数: path 或 paths", async (ctx) => {
      const r = sendFiles(ctx.args);
      if (!r.sensitive?.length) return r;
      const ok = this.deps.consent
        ? (await this.deps.consent.request(ctx.bot.id, "fs:send", `发送敏感文件：\n${r.sensitive.join("\n")}`, { onceOnly: true, reasons: ["可能包含密钥、证书或账号凭据"] })).granted
        : false;
      return ok ? sendFiles(ctx.args, true) : { output: `❌ 用户没有批准发送这些敏感文件：${r.sensitive.join("、")}` };
    });
    R.register("image.generate", "按描述生成图片。参数: prompt, n?, size?", (ctx) => this.imageTool(ctx.bot, "image.generate", ctx.args, ctx.sessionId, turn(ctx)));
    R.register("image.edit", "修改一张图片。参数: prompt, image?", (ctx) => this.imageTool(ctx.bot, "image.edit", ctx.args, ctx.sessionId, turn(ctx)));
    R.register("web.search", "联网搜索。参数: query, limit?", (ctx) => this.webTool(ctx.bot, "web.search", ctx.args, turn(ctx)));
    R.register("web.fetch", "打开网页读正文。参数: url", (ctx) => this.webTool(ctx.bot, "web.fetch", ctx.args, turn(ctx)));

    R.registerPrefix("ui.", "交互卡片 ui.ask / ui.confirm / ui.secret / ui.form（多字段预填表单）", (ctx) => ctx.depth > 0
      ? { output: "❌ 你是被别的 bot 转问的，对方不是用户，看不到也点不了卡片。直接做能做的；需要用户选择或确认的事写在回复里，由发起方去问用户。" }
      : uiTool(ctx.tool, ctx.args, this.deps.secrets, ctx.bot.id));
    if (this.deps.vault) {
      R.registerPrefix("vault.", "本机保险库只读：vault.list / vault.search / vault.contact（姓名邮箱备注，无支付）", (ctx) => this.vaultTool(ctx.bot, ctx.tool, ctx.args));
    }
    if (this.deps.groupPost) {
      R.register("group.send", "以你的身份在软件里的群聊发言：消息出现在群聊界面里。@ 了谁就谁回；没 @ 时只由主持人（或下一位）回一句，不会默认全员齐声。要全员各说一句时在 message 里写 @所有人 / 【交给】全员。工具结果带回他们的回复。软件内部群聊不算外部，不需要 ui.confirm。参数: group（群名）, message", async (ctx) => {
        const group = String(ctx.args.group ?? ctx.args.name ?? "").trim();
        const message = String(ctx.args.message ?? ctx.args.text ?? "").trim();
        if (!group || !message) return { output: "❌ 需要 group（群名）和 message" };
        // 已在某群会话里发言时再 send，会套娃空转
        if (String(ctx.sessionId || "").startsWith("group-")) {
          return { output: "❌ 你已经在群聊里发言了，直接说正文即可，不要再调用 group.send。" };
        }
        const r = await this.deps.groupPost!(ctx.bot, group, message, turn(ctx).signal);
        if (!r.ok) return { output: `❌ ${r.error}` };
        const link = `[${r.group}](app:group/${encodeURIComponent(r.group)})`;
        if (r.joined) return { output: `已插进群聊 ${link} 正在进行的接力：${message}\n这次没有另开一轮。` };
        const replies = r.replies.length
          ? r.replies.map((x) => `- ${x.name}：${x.text.replace(/```tool[\s\S]*?```/g, "").trim().slice(0, 1500)}`).join("\n")
          : "（没有成员回应）";
        return { output: `已发到群聊 ${link}：${message}\n群成员的回复（${r.reason}）：\n${replies}\n把大家的回复如实转告用户，不要编造没出现的内容。` };
      });
    }
    R.registerPrefix("app.", "查看软件现状 app.state（bot、群聊、定时任务、项目、技能、模型的完整清单）；改自己资料、切模型、建 bot/群", (ctx) => this.appTool(ctx.bot, ctx.tool, ctx.args));
    // pet.* 不在此注册 — 见 core/pet/sidecar.ts attachPetEntertainment
    if (this.deps.demo) {
      R.registerPrefix(
        "demo.",
        "演示→技能：demo.start / status / finish（可带 cron|in 定时重跑）/ cancel。录制本机工具轨迹，不是云电脑跟看",
        (ctx) => this.demoTool(ctx.bot, ctx.tool, ctx.args, ctx.sessionId),
      );
    }
    R.registerPrefix("skill.", "技能管理 skill.list / skill.get(key) / skill.save(name, description, instructions=Grok六段说明书, key?) / skill.update(key, append?: 新规范数组, replace?: [{find, with}] 改掉冲突的旧规则) / skill.delete(key)", (ctx) => this.appTool(ctx.bot, ctx.tool, ctx.args));
    // 编排已全删：保留前缀以免历史对话再调时只得到「未知工具」
    R.registerPrefix("plan.", "已下线勿调用；多步协作改用 group.send / bot.ask", async () => ({
      output: "编排已下线。多步协作请用群聊 @ 或 bot.ask 交接，不要再调用 plan.*。",
    }));

    const builtin = (name: string, desc: string) =>
      R.register(name, desc, (ctx) => this.executeBuiltin(ctx.bot, { callId: "", tool: name, args: ctx.args }, ctx.originalText, ctx.depth, ctx.sessionId, turn(ctx)));

    builtin("fs.read", "读本机文件（任意可读路径，含桌面/下载；~ 可用）。参数: path, offset?");
    builtin("fs.write", "写文件（仅 bot 工作区）。用户工程大改走 cli.agent，不要用 fs.write 改仓库。参数: path, content");
    builtin("fs.list", "列本机目录（任意可读路径，含桌面/下载；~ 可用）。看结构优先用它；不会打开终端面板。不要先 bash ls。参数: path");
    builtin("bash.run", "短命令（授权卡片，不打开终端面板）。只读列目录用 fs.list。被拒绝就别换写法重试。参数: command");
    builtin("notify", "系统通知。参数: title, body");
    builtin("memory.add", "长期记住一件事（重启后还在）。rule=对本角色的做事要求（默认只你）；fact=关于用户的稳定事实/偏好（姓名、时区等默认建议 scope:all）。参数: content, kind（rule|fact）, bot?, scope?（all=全局）。一次性任务要求不要记。没调用就不要说「记下了」");
    R.register("env.set", "保存一项普通配置 / 环境变量（接口地址、账号名、项目 ID、区域等，重启后还在，bash.run 自动注入）。默认所有 bot 共用（账号级交接）。密码 / Token 不要用它，用 ui.secret。参数: key（英文大写，如 FEISHU_APP_ID）, value, label?（中文名称）, note?（用途）, scope?（bot = 仅你覆盖；默认共用）", (ctx) => this.envTool(ctx.bot, "env.set", ctx.args));
    R.register("env.delete", "删除配置。默认只删你的私有覆盖；要删全员共用项必须 scope:\"all\"。参数: key, scope?", (ctx) => this.envTool(ctx.bot, "env.delete", ctx.args));
    R.register("secret.share", "确认密钥名在账号级保险库里（全员本就能用）。参数: name", (ctx) => this.secretShareTool(ctx.bot, ctx.args));
    R.register("secret.delete", "删除账号级保险库里的一个密钥（影响所有 bot）。参数: name", (ctx) => this.secretDeleteTool(ctx.bot, ctx.args));
    R.register(
      "cli.agent",
      () => cliAgentToolDescription(),
      (ctx) => this.cliAgentTool(ctx.bot, ctx.args, turn(ctx)),
    );
    const termHelp =
      "Bot 的终端能力：每个工程目录一块屏幕，默认是 shell，和界面上是同一块。【终端】写着进程开着时就在，不要说不在线。term.open / read / write / keys / stop 都可带 cwd 指定工程（默认正在看的）。term.open 打开/确保 shell；term.read 再看屏幕；term.write data 打一行（会回车）；term.keys data 按键（down/up/enter/tab/esc/space/ctrl-c）；term.stop 关掉该目录终端。改大仓库仍用 cli.agent（会把同槽切到 Coding CLI）。短命令用 bash.run。cli.term 是旧名，action=read|write|keys|stop|open 仍可用。";
    R.register("term.open", "在工程目录打开 shell 终端（不依赖 Coding CLI）。参数: cwd?（默认正在看的工程目录）", (ctx) => this.termTool(ctx.bot, { action: "open", ...ctx.args }, turn(ctx)));
    R.register("term.read", "再看一眼终端屏幕。参数: cwd?（默认正在看的）", (ctx) => this.termTool(ctx.bot, { action: "read", ...ctx.args }, turn(ctx)));
    R.register("term.write", "往终端打一行并回车。参数: data, cwd?", (ctx) => this.termTool(ctx.bot, { action: "write", ...ctx.args }, turn(ctx)));
    R.register("term.keys", "往终端送按键。参数: data（down/up/enter/tab/esc/space/ctrl-c）, cwd?", (ctx) => this.termTool(ctx.bot, { action: "keys", ...ctx.args }, turn(ctx)));
    R.register("term.stop", "关掉终端。参数: cwd?（默认正在看的这块）", (ctx) => this.termTool(ctx.bot, { action: "stop", ...ctx.args }, turn(ctx)));
    R.register("cli.term", termHelp, (ctx) => this.termTool(ctx.bot, ctx.args, turn(ctx)));
    R.register("browser.open", "打开这个 bot 的内部浏览器面板（登录态按 bot 隔离）。参数: url?", (ctx) => this.browserTool(ctx.bot, "open", ctx.args, turn(ctx)));
    R.register("browser.goto", "在 bot 浏览器里打开网址。参数: url", (ctx) => this.browserTool(ctx.bot, "goto", ctx.args, turn(ctx)));
    R.register("browser.snapshot", "看当前页可交互元素（带 e1/e2… ref，供 click/type）；密码框 value 已脱敏", (ctx) => this.browserTool(ctx.bot, "snapshot", ctx.args, turn(ctx)));
    R.register("browser.click", "点击页面元素。参数: ref（来自 snapshot）或 selector", (ctx) => this.browserTool(ctx.bot, "click", ctx.args, turn(ctx)));
    R.register("browser.type", "往输入框打字。参数: text, ref|selector, submit?；已批准时可用 {{secret:名字}}", (ctx) => this.browserTool(ctx.bot, "type", ctx.args, turn(ctx)));
    R.register("browser.fillLogin", "用保险库登录项填用户名/密码（模型只见 loginId，不见密码）。参数: loginId（或 website）, userRef?, passRef?", (ctx) => this.browserTool(ctx.bot, "fillLogin", ctx.args, turn(ctx)));
    R.register("browser.takeover", "验证码/SSO/passkey 时请用户接管浏览器。参数: reason?", (ctx) => this.browserTool(ctx.bot, "takeover", ctx.args, turn(ctx)));
    R.register("browser.keys", "送按键。参数: keys（enter/tab/escape/backspace 或组合）", (ctx) => this.browserTool(ctx.bot, "keys", ctx.args, turn(ctx)));
    R.register("browser.read", "读当前页 url、标题和可见正文摘录", (ctx) => this.browserTool(ctx.bot, "read", ctx.args, turn(ctx)));
    R.register("browser.stop", "关掉浏览器面板（登录态仍保留）", (ctx) => this.browserTool(ctx.bot, "stop", ctx.args, turn(ctx)));
    R.register("vault.login.list", "列出保险库登录项（无密码）。无参数", () => {
      const list = this.deps.logins?.list() ?? this.deps.vault?.logins?.() ?? [];
      if (!list.length) return { output: "还没有登录项。请用户在 Connect → 登录 里添加。" };
      return { output: list.map((l) => `- ${l.id}：${l.website} · ${l.username}${l.hint ? `（${l.hint}）` : ""}`).join("\n") };
    });
    // 后台暖探测缓存，让工具说明 / 提示词能跟上本机安装变化
    void probeCodingAgents().catch(() => {});
    builtin("memory.list", "列出某个 bot 已存的规范/事实单条。用户问「你记得什么 / 关于我知道些什么」时用。参数: bot?（bot 名，默认你自己）, kind?（rule=规范 / fact=事实，默认全部）");
    builtin("memory.search", "按意思检索记忆和过往对话（如「上次聊的那个方案」）。参数: query");
    builtin("memory.update", "改一条已存的记忆 / 规范（用户纠正、规范要改时用，不要再 add 一条相反的）。参数: match（原文里的几个字，用来定位）, content（改成什么）, bot?（改哪个 bot 的，默认你自己）, scope?（all = 全局共享的）");
    builtin("memory.forget", "删掉一条已存的记忆 / 规范（用户说不用再遵守、记错了时用）。参数: match（原文里的几个字）, bot?（删哪个 bot 的，默认你自己）, scope?（all = 全局共享的）");
    builtin("remember", "同 memory.add");
    builtin("bot.list", "列出团队其他 bot");
    builtin("bot.ask", "向另一个 bot 提一个有实质内容的问题并拿回复。密钥 / 环境是账号级共用的，不必为凭据再转问。需要多人在群里露脸或接力时用 group.send（要全员就在 message 里写 @所有人），不要对多人轮流发同一句空提示。参数: to, message");
    builtin("task.create", "建例行/定时任务。参数: name, prompt, cron|at|in；webhook:true 开通入站（外系统 POST JSON：message=用户话；priority=normal|urgent）。紧急可打断并通知。入站 URL 让用户到例行面板 🪝 复制，勿把令牌写进聊天。一次性可设 runPrompt:false 仅宠物闹钟。每个 bot 最多 50 条；周期两次至少隔 5 分钟。");
    builtin("task.list", "列出定时任务");
    builtin("task.delete", "删定时任务。参数: id 或 name");
    for (const n of ["apple.openApp", "apple.activate", "apple.type", "apple.click", "apple.hotkey", "apple.tellApp"]) {
      builtin(n, "控制本机应用（需授权）");
    }
    builtin("screen.screenshot", "截屏（需授权）。参数: rect?");
    // 系统行为底座：观察本机；具体场景（日报/监听/清理）用这些工具 + task.create 组合，不要等产品预制流程
    builtin("sys.observe", "观察本机快照：前台 App、进程、磁盘；可选 Coding 活动账本。参数: apps?（进程名关键字数组）, coding?=true, sinceDays?");
    builtin("sys.processes", "列进程。参数: apps?（关键字数组；不传则按 CPU 取高占用）");
    builtin("sys.disk", "磁盘各卷用量");
    builtin("sys.activity", "Coding 终端活动账本摘要（Harness 拉起的 Cursor/Codex/Claude/shell）。参数: sinceDays?=7, bot?");
    builtin("sys.scan", "扫描家目录下某路径的过期文件（只列不删）。参数: path, minAgeDays?=30, minSizeKb?, limit?");
    builtin("sys.purge", "删除 sys.scan 列出的文件（强确认；只能删文件不能删目录）。参数: paths（字符串数组）");

    if (this.deps.mcpManage) {
      builtin("mcp.list", "列出本软件已接入的 MCP server（名称、工具数、启动命令）。会自动把磁盘 config 与运行时对齐（手改过 config.json 也能补上，不必让用户重启软件）。不要去翻 Claude Desktop 或其他软件的配置路径；也不要说「需要重启」——先调本工具。");
      builtin("mcp.add", "给本软件接入一个 MCP server 并立即热加载（写入配置 + 重连，侧栏 🔌 MCP 会更新，用户不用重启）。禁止用 bash/node 直接改 config.json 的 mcpServers。参数: name（显示名）, command（完整启动命令，如 npx -y mcp-git；或分开填 command+args）, url?（HTTP 端点，与 command 二选一）, id?（英文 id，默认从 name 生成）");
      builtin("mcp.remove", "移除一个已接入的 MCP server（立即热卸载）。参数: id 或 name");
    }
    if (this.deps.connectors) {
      builtin("webhook.list", "列出已登记的出站 Webhook（本软件把结果 POST 出去的端点）。用户说「创建 webhook」时：出站用 webhook.add；入站（外系统触发本 bot）用 task.create + webhook:true，不要去翻记忆/技能/app.state 瞎猜。");
      builtin("webhook.add", "登记一个出站 Webhook（写入 Connect，立刻可用 webhook.post）。参数: name, url（http/https）, note?, headers?（对象；Token 写 {{secret:名字}}，勿塞明文密钥）。禁止用 bash 改 connectors.json。");
      builtin("webhook.remove", "移除已登记的出站 Webhook。参数: name 或 id");
      builtin("webhook.post", "把 JSON 结果 POST 到已登记的出站 Webhook。参数: to（名称或 id）, body?（对象，默认 {}）");
    }
    R.registerPrefix("mcp:", "调用已连接的 MCP 工具 mcp:<server>/<tool>", async (ctx) => {
      if (!this.deps.mcp) return { output: "MCP 未启用" };
      // 管理工具走 mcp.list / mcp.add，不要当 server/tool 解析
      if (ctx.tool === "mcp:list" || ctx.tool === "mcp:add" || ctx.tool === "mcp:remove") {
        return this.executeBuiltin(ctx.bot, { callId: "", tool: ctx.tool.replace(":", "."), args: ctx.args }, ctx.originalText, ctx.depth, ctx.sessionId, turn(ctx));
      }
      const [serverId, ...rest] = ctx.tool.slice(4).split("/");
      const toolName = rest.join("/");
      const cap = `mcp:${serverId}/${toolName}` as const;
      const t0 = Date.now();
      const shownArgs = JSON.stringify(ctx.args).replace(/"(?:[^"\\]|\\.)*"/g, (s) => (s.length > 200 ? `${s.slice(0, 200)}…"` : s)).slice(0, 1500);
      if (this.deps.consent) {
        const r = await this.deps.consent.request(ctx.bot.id, cap, `调用 MCP 工具 ${serverId}/${toolName}\n参数: ${shownArgs}`);
        if (!r.granted) {
          this.deps.audit?.append({ botId: ctx.bot.id, cap, action: "mcp.call", args: shownArgs, granted: false });
          return { output: `❌ 用户没有批准调用 ${serverId}/${toolName}，不要换别的工具重试，直接告诉用户` };
        }
      }
      try {
        const out = (await abortable(this.deps.mcp.callTool(serverId, toolName, ctx.args), turn(ctx).signal)).slice(0, 4000);
        this.deps.audit?.append({ botId: ctx.bot.id, cap, action: "mcp.call", args: shownArgs, granted: true, ok: true, latencyMs: Date.now() - t0 });
        return { output: untrusted(`MCP ${serverId}/${toolName}`, out) };
      } catch (e) {
        this.deps.audit?.append({ botId: ctx.bot.id, cap, action: "mcp.call", args: shownArgs, granted: true, ok: false, latencyMs: Date.now() - t0 });
        return { output: `❌ MCP 调用失败: ${e instanceof Error ? e.message : String(e)}` };
      }
    });
    R.registerPrefix("skill:", "执行技能 skill:<key>", (ctx) => this.runSkill(ctx.bot, ctx.tool.slice(6), ctx.args, ctx.originalText));
    R.register("skill", "执行技能。参数: key", (ctx) => this.runSkill(ctx.bot, String(ctx.args.key ?? ctx.args.name ?? ""), ctx.args, ctx.originalText));
  }

  /** 联网：搜索结果和打开的网页都编号进本轮来源，回复里用 [n] 引用 */
  private async webTool(bot: Bot, tool: string, args: Record<string, unknown>, turn: TurnCtx): Promise<ToolOutcome> {
    try {
      if (tool === "web.search") {
        const q = String(args.query ?? args.q ?? args.keyword ?? "").trim();
        if (!q) return { output: "web.search 需要 query" };
        const hits = await webSearch(q, Math.min(Number(args.limit ?? 6) || 6, 10));
        return { output: untrusted("搜索结果", hits.map((h) => `[${addSource(turn, h)}] ${h.title}\n${h.url}\n${h.snippet}`).join("\n\n")) };
      }
      const url = String(args.url ?? "").trim();
      let page;
      try {
        page = await fetchPage(url);
      } catch (e) {
        if (!(e instanceof PrivateAddressError)) throw e;
        const ok = this.deps.consent ? (await this.deps.consent.request(bot.id, "net:local", `打开本机 / 局域网地址 ${url}`)).granted : false;
        if (!ok) return { output: `❌ ${e.host} 是本机或局域网地址，用户没有批准访问` };
        page = await fetchPage(url, undefined, { allowPrivate: true });
      }
      const n = addSource(turn, { title: page.title, url: page.url, snippet: page.text.slice(0, 160) });
      return { output: `来源 [${n}]：${page.title}\n${page.url}\n\n${untrusted(page.url, page.text)}` };
    } catch (e) {
      return { output: `❌ ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /** 画图 / 改图：结果存进 bot 工作区并作为图片附在回复里 */
  private async imageTool(bot: Bot, tool: string, args: Record<string, unknown>, sessionId: string | undefined, turn: TurnCtx): Promise<ToolOutcome> {
    const cfg = this.deps.imageConfig?.();
    if (!cfg) return { output: "❌ 还没配置图片生成接口。请告诉用户去 [图片生成设置](app:settings/image) 填任意 OpenAI 兼容的 Base URL / Key / 模型名" };
    const prompt = String(args.prompt ?? args.description ?? "").trim();
    if (!prompt) return { output: `${tool} 需要 prompt（画面描述）` };
    const outDir = join(this.workspaceOf(bot) ?? join(homedir(), "Downloads"), "images");
    try {
      let paths: string[];
      if (tool === "image.generate") {
        paths = await generateImages(cfg, prompt, outDir, { n: Number(args.n ?? 1), size: args.size ? String(args.size) : undefined });
      } else {
        const src = this.resolveImage(bot, String(args.image ?? args.path ?? ""), sessionId, outDir, turn.userImages ?? []);
        if (!src) return { output: "❌ 找不到要修改的图片：传工作区内的图片路径，或让用户先把图片发到对话里" };
        if (isSensitivePath(src)) {
          const ok = this.deps.consent
            ? (await this.deps.consent.request(bot.id, "fs:send", `改图会把敏感文件上传到图片接口：\n${src}`, { onceOnly: true, reasons: ["可能包含密钥、证书或账号凭据"] })).granted
            : false;
          if (!ok) return { output: `❌ 用户没有批准使用敏感文件改图：${src}` };
        }
        paths = await editImage(cfg, src, prompt, outDir, { size: args.size ? String(args.size) : undefined });
      }
      return {
        output: `已生成 ${paths.length} 张图片并展示给用户：${paths.join("、")}`,
        blocks: paths.map((p) => ({ type: "image" as const, path: p, alt: prompt.slice(0, 40) })),
      };
    } catch (e) {
      return { output: `❌ ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /** 路径是否在 bot 工作区 / 全局 workspace 内 */
  private pathInWorkspace(bot: Bot, abs: string): boolean {
    const roots = [this.workspaceOf(bot), this.deps.workspaceRoot].filter((x): x is string => !!x);
    if (!roots.length) return false;
    let real = abs;
    try { real = realpathSync(abs); } catch { /* 用不存在的祖先拼出来的路径也按规范化比 */ }
    return roots.some((r) => {
      let root = r;
      try { root = realpathSync(r); } catch {}
      return real === root || real.startsWith(root.endsWith("/") ? root : root + "/");
    });
  }

  /** 改图的原图：工作区内路径，或会话里最近一张用户图（粘贴的图先落盘） */
  private resolveImage(bot: Bot, given: string, sessionId: string | undefined, outDir: string, current: ContentBlock[]): string | null {
    const p = given.startsWith("~") ? join(homedir(), given.slice(1)) : given;
    if (p && isAbsolute(p) && existsSync(p)) {
      if (!this.pathInWorkspace(bot, p)) return null;
      return p;
    }
    const msgs = [...(sessionId ? this.deps.store.listMessages(sessionId) : []), { content: current } as Pick<ChatMessage, "content">];
    for (const m of [...msgs].reverse()) {
      if (!Array.isArray(m.content)) continue;
      const img = [...m.content].reverse().find((b) => b.type === "image") as Extract<ContentBlock, { type: "image" }> | undefined;
      if (!img) continue;
      if (img.path && existsSync(img.path)) return img.path;
      const data = img.dataUrl?.match(/^data:image\/(\w+);base64,(.+)$/);
      if (data) {
        mkdirSync(outDir, { recursive: true });
        const f = join(outDir, `source-${Date.now().toString(36)}.${data[1] === "jpeg" ? "jpg" : data[1]}`);
        writeFileSync(f, Buffer.from(data[2], "base64"));
        return f;
      }
    }
    return null;
  }

  private secretShareTool(bot: Bot, args: Record<string, unknown>): ToolOutcome {
    if (!this.deps.secrets) return { output: "❌ 密钥库未启用" };
    const name = String(args.name ?? args.key ?? "").trim().replace(/[^\w.\-]/g, "_");
    if (!name) return { output: "❌ secret.share 需要 name（密钥英文名）" };
    const r = this.deps.secrets.share(name, bot.id);
    if (!r.ok) return { output: `❌ ${r.error}` };
    this.deps.audit?.append({ botId: bot.id, cap: "config", action: "secret.share", args: name, granted: true, ok: true, detail: "账号级共用" });
    return { output: `密钥 ${name} 在本机保险库里对所有 bot 可用（账号级）。用 {{secret:${name}}} / $${name}，真值不会进对话。\n查看：[环境配置](app:settings/env)` };
  }

  private secretDeleteTool(bot: Bot, args: Record<string, unknown>): ToolOutcome {
    if (!this.deps.secrets) return { output: "❌ 密钥库未启用" };
    const name = String(args.name ?? args.key ?? "").trim().replace(/[^\w.\-]/g, "_");
    if (!name) return { output: "❌ secret.delete 需要 name" };
    if (!this.deps.secrets.has(name)) return { output: `❌ 没有密钥 ${name}` };
    this.deps.secrets.remove(name);
    this.deps.audit?.append({ botId: bot.id, cap: "config", action: "secret.delete", args: name, granted: true, ok: true, detail: "账号级" });
    return { output: `已删除密钥 ${name}（所有 bot 都不能再用）。\n查看：[环境配置](app:settings/env)` };
  }

  /** bot 改软件本身：自己的人设 / 模型、建 bot、建群、技能增删改 */
  private envTool(bot: Bot, tool: string, args: Record<string, unknown>): ToolOutcome {
    if (!this.deps.env) return { output: "❌ 环境配置未启用" };
    const key = normalizeEnvKey(String(args.key ?? args.name ?? ""));
    if (!key) return { output: `❌ ${tool} 需要 key` };
    // 默认账号级共用（对齐 Grok：凭据/配置跨 bot 可交接）；scope:"bot" 才写私有覆盖
    const privateOnly = args.scope === "bot" || args.scope === "private" || args.scope === "self";
    const sharedScope = args.scope === "all" || args.scope === "global";
    const link = "[环境配置](app:settings/env)";
    if (tool === "env.delete") {
      // 无 scope：只删自己的私有覆盖，避免误删全员配置；删共用必须显式 scope:all
      if (!privateOnly && !sharedScope) {
        const okPrivate = this.deps.env.remove(key, bot.id);
        if (okPrivate) {
          this.deps.audit?.append({ botId: bot.id, cap: "config", action: "env.delete", args: key, granted: true, ok: true, detail: "私有" });
          return { output: `已删除你的私有配置 ${key}\n查看：${link}` };
        }
        const hasShared = this.deps.env.list().some((e) => e.key === key && !e.botId);
        if (hasShared) {
          return { output: `❌ ${key} 是所有 bot 共用的配置。确认要删掉全员项时再调用 env.delete，并加 scope:"all"` };
        }
        return { output: `❌ 没有你的配置 ${key}` };
      }
      const ok = this.deps.env.remove(key, privateOnly ? bot.id : undefined);
      if (ok) this.deps.audit?.append({ botId: bot.id, cap: "config", action: "env.delete", args: key, granted: true, ok: true, detail: privateOnly ? "私有" : "共用" });
      return { output: ok ? `已删除${privateOnly ? "你的私有" : "共用"}配置 ${key}\n查看：${link}` : `❌ 没有${privateOnly ? "你的" : "共用的"}配置 ${key}` };
    }
    const value = String(args.value ?? "").trim();
    if (!value) return { output: "❌ env.set 需要 value" };
    if (looksSecret(key, value)) return { output: `❌ ${key} 看起来是密码 / Token，不能明文保存。改用 ui.secret（name: ${key}）让用户在加密输入框里填写` };
    const e = this.deps.env.set({ key, value, label: args.label ? String(args.label) : undefined, note: args.note ? String(args.note) : undefined, botId: privateOnly ? bot.id : undefined, updatedBy: bot.id });
    this.deps.audit?.append({ botId: bot.id, cap: "config", action: "env.set", args: `${e.key}=${e.value}`, granted: true, ok: true, detail: privateOnly ? "私有" : "共用" });
    return { output: `已保存配置 ${e.key}=${e.value}${privateOnly ? "（仅你）" : "（所有 bot 共用）"}，之后 bash.run 里可以直接用 $${e.key}\n查看 / 修改：${link}` };
  }

  /** 共享技能会影响所有 bot，写之前请用户确认（没有授权中心时，如测试环境，直接放行） */
  private async sharedSkillConsent(bot: Bot, desc: string): Promise<boolean> {
    if (!this.deps.consent) return true;
    return (await this.deps.consent.request(bot.id, "skill:shared", desc)).granted;
  }

  private async demoTool(bot: Bot, tool: string, args: Record<string, unknown>, sessionId?: string): Promise<ToolOutcome> {
    const demo = this.deps.demo;
    if (!demo) return { output: "❌ 演示→技能未启用" };
    const str = (k: string) => (args[k] === undefined || args[k] === null ? undefined : String(args[k]).trim());
    switch (tool) {
      case "demo.start": {
        const title = str("title") ?? str("name") ?? str("goal");
        const s = demo.start(bot.id, { sessionId, title });
        return {
          output: [
            `🎬 已开始录制演示「${s.title || "未命名"}」（id=${s.id}）。`,
            "接下来按真实流程调用工具（fs / bash / mcp / web / bot.ask…），每一步会自动记入。",
            "结束：demo.finish name=…；取消：demo.cancel。这是本机工具轨迹，不是云电脑跟看。",
          ].join("\n"),
        };
      }
      case "demo.status": {
        const s = demo.status(bot.id);
        if (!s) return { output: "当前没有进行中的演示。用户说「教你一遍」时用 demo.start 开始。" };
        const lines = s.steps.slice(-12).map((x, i) => `${s.steps.length - Math.min(12, s.steps.length) + i + 1}. ${x.tool}${x.ok ? "" : "（失败）"}`);
        return {
          output: [
            `录制中「${s.title || "未命名"}」id=${s.id}，已 ${s.steps.length} 步，始于 ${new Date(s.startedAt).toLocaleString()}。`,
            lines.length ? lines.join("\n") : "（还没有步骤）",
          ].join("\n"),
        };
      }
      case "demo.cancel": {
        const s = demo.cancel(bot.id);
        return { output: s ? `已取消演示录制「${s.title || s.id}」（丢弃 ${s.steps.length} 步）` : "没有进行中的演示可取消。" };
      }
      case "demo.finish": {
        const finished = demo.finish(bot.id, { name: str("name") ?? str("title"), description: str("description") ?? str("desc") });
        if (!finished.ok) return { output: `❌ ${finished.error}` };
        const { draft, session } = finished;
        let skill;
        try {
          skill = this.deps.skills.save({
            name: draft.name,
            description: draft.description,
            body: draft.body,
            owner: bot.id,
          });
        } catch (e) {
          demo.reopen(bot.id, session);
          return { output: `❌ 技能落盘失败：${e instanceof Error ? e.message : String(e)}（录制已恢复，可重试 finish）` };
        }
        this.deps.onAppChanged?.("skills");
        const link = `[${skill.name}](app:skill/${skill.key})`;
        const bits = [`✅ 已将演示存成私有技能 ${link}（${draft.steps} 步）。`];

        // 可选：挂定时重跑
        const cron = str("cron");
        const runAt = parseRunAt(args);
        if ((cron || runAt) && this.deps.tasks) {
          const taskName = str("taskName") || `重跑：${skill.name}`;
          const prompt = str("prompt") || `请按技能 ${link} 的步骤执行一遍，按当前环境调整路径与参数，完成后汇报结果。`;
          try {
            if (runAt) {
              const t = this.deps.tasks.create({
                botId: bot.id,
                name: taskName,
                prompt,
                cron: "* * * * *",
                kind: "once",
                alarmAt: runAt,
                runPrompt: true,
                notifyPet: false,
                deleteAfterRun: args.keep !== true,
                sessionId,
                skillKey: skill.key,
                source: "demo",
                webhook: args.webhook === true || args.webhook === "true",
              });
              bits.push(`已挂一次性重跑「${t.name}」，约在 ${new Date(t.nextRunAt!).toLocaleString()} 执行。`);
              if (t.webhookToken) bits.push("入站 Webhook 已开通：到例行面板点 🪝 复制触发 URL（令牌不写入聊天）。");
            } else if (cron) {
              const t = this.deps.tasks.create({
                botId: bot.id,
                name: taskName,
                prompt,
                cron,
                sessionId,
                skillKey: skill.key,
                source: "demo",
                webhook: args.webhook === true || args.webhook === "true",
              });
              bits.push(`已挂周期重跑「${t.name}」（${cron}），下次 ${t.nextRunAt ? new Date(t.nextRunAt).toLocaleString() : "待定"}。`);
              if (t.webhookToken) bits.push("入站 Webhook 已开通：到例行面板点 🪝 复制触发 URL（令牌不写入聊天）。");
            }
            this.deps.onAppChanged?.("tasks");
          } catch (e) {
            bits.push(`定时任务创建失败：${e instanceof Error ? e.message : String(e)}`);
          }
        } else if (cron || runAt) {
          bits.push("（未配置定时任务模块，技能已保存但没挂重跑）");
        } else {
          bits.push(`若要定时重跑：task.create name="重跑：${skill.name}" prompt="按技能 ${link} 执行" cron=… 或 in=30m。`);
        }
        bits.push("告诉用户技能链接；不要编造未写入的步骤。");
        return { output: bits.join("\n") };
      }
      default:
        return { output: `未知工具 ${tool}。可用：demo.start / status / finish / cancel` };
    }
  }

  private vaultTool(bot: Bot, tool: string, args: Record<string, unknown>): ToolOutcome {
    const vault = this.deps.vault;
    if (!vault) return { output: "❌ 保险库未启用" };
    const q = String(args.query ?? args.q ?? args.match ?? "").trim();
    if (tool === "vault.list" || tool === "vault.search") {
      const items = tool === "vault.search" || q ? vault.search(q || String(args.kind ?? ""), bot.id) : vault.list(bot.id);
      const kind = String(args.kind ?? "").trim();
      const filtered = kind ? items.filter((x) => x.kind === kind) : items;
      if (!filtered.length) {
        return {
          output: "保险库里没有匹配项。打开 [Connect](app:settings/vault)。云短链填 [短链分享](app:settings/share)；例行入站开 [入站网关](app:settings/gateway)。",
        };
      }
      const lines = filtered.slice(0, 40).map((x) => `- [${x.kind}] ${x.title}${x.detail ? ` — ${x.detail}` : ""}`);
      return { output: `本机保险库（${filtered.length} 项，只读；密钥值不可见，工具参数用 {{secret:名字}}）：\n${lines.join("\n")}\n管理：[Connect](app:settings/vault) · 云短链：[短链分享](app:settings/share)` };
    }
    if (tool === "vault.contact") {
      const key = String(args.name ?? args.id ?? args.contact ?? q).trim();
      if (!key) {
        const all = vault.contacts().slice(0, 30);
        return { output: all.length ? all.map((c) => `- ${c.name}${c.email ? ` <${c.email}>` : ""}${c.note ? ` · ${c.note}` : ""}`).join("\n") : "通讯录为空。用户可在设置「保险库」里添加（无支付）。" };
      }
      const c = vault.contact(key);
      if (!c) return { output: `找不到联系人「${key}」` };
      return { output: `${c.name}${c.email ? `\n邮箱：${c.email}` : ""}${c.note ? `\n备注：${c.note}` : ""}\n（本机通讯录，无支付 / 无云邮箱身份）` };
    }
    return { output: `未知工具 ${tool}。可用：vault.list / vault.search / vault.contact` };
  }

  private async appTool(bot: Bot, tool: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const store = this.deps.store;
    const str = (k: string) => (args[k] === undefined || args[k] === null ? undefined : String(args[k]).trim());
    const changed = (what: string, output: string) => { this.deps.onAppChanged?.(what); return { output }; };
    switch (tool) {
      case "app.updateSelf": {
        const patch: Partial<Bot> = {};
        for (const k of ["name", "role", "persona", "systemPrompt"] as const) if (str(k)) patch[k] = str(k)!;
        const cwd = str("agentCwd") ?? str("projectRoot");
        if (cwd) Object.assign(patch, gazeCodingDir(bot, cwd));
        const cli = parseCliName(str("agentCli") ?? str("cli"));
        if (cli) patch.agentCli = cli;
        if (!Object.keys(patch).length) return { output: "app.updateSelf 需要 name / role / persona / systemPrompt / agentCwd / agentCli 之一" };
        store.saveBot({ ...bot, ...patch });
        return changed("bots", `已更新：${Object.keys(patch).join("、")}`);
      }
      case "app.setModel": {
        const q = str("provider") ?? str("name") ?? "";
        if (!q || /^(默认|default)$/i.test(q)) { store.saveBot({ ...bot, providerId: "", model: undefined }); return changed("bots", "已改为跟随默认模型"); }
        const all = this.deps.providers.list();
        const p = all.find((x) => x.id === q) ?? all.find((x) => x.name === q) ?? all.find((x) => `${x.name} ${x.model ?? ""}`.toLowerCase().includes(q.toLowerCase()));
        if (!p) return { output: `找不到模型「${q}」。可选：${all.map((x) => `${x.name}${x.model ? `(${x.model})` : ""}`).join("、")}` };
        store.saveBot({ ...bot, providerId: p.id, model: str("model") ?? undefined });
        return changed("bots", `已切换到 ${p.name}${p.model ? ` · ${p.model}` : ""}，下一条消息起生效`);
      }
      case "app.state": {
        const bots = store.listBots().map((b) => {
          const rules = this.deps.memory.list(`bot:${b.id}`).filter((e) => e.kind === "rule");
          const ruleBit = rules.length
            ? `，规范 ${rules.length} 条：[查看](app:memory/${b.id}/rule)`
            : "，规范 0 条";
          const petBit = b.petEnabled ? "，桌宠上台" : "";
          return `- [${b.name}](app:bot/${encodeURIComponent(b.name)})（${b.role}${b.isMaster ? "，主控" : ""}${b.id === bot.id ? "，你" : ""}${petBit}${ruleBit}）`;
        });
        const p = this.deps.providers.list();
        const models = p.map((x) => `- ${x.name}${x.model ? ` · ${x.model}` : ""}${x.isDefault ? "（默认）" : ""}`);
        return { output: [`【bot ${bots.length} 个】`, ...bots, "【软件现状】", ...this.prompt.appSnapshot(bot, true).lines, `【模型 ${p.length} 个】`, ...models].join("\n") };
      }
      case "app.listModels":
        return { output: this.deps.providers.list().map((x) => `- ${x.name}${x.model ? ` · ${x.model}` : ""}${x.id === bot.providerId ? "（当前）" : ""}`).join("\n") || "（没有配置模型）" };
      case "app.createBot": {
        const name = str("name");
        if (!name) return { output: "app.createBot 需要 name" };
        if (store.listBots().some((b) => b.name === name)) return { output: `已经有叫「${name}」的 bot 了` };
        // 桌宠是娱乐侧车：建 bot 不自动上台；用户要桌宠请在详情打开，或对话 pet.show
        const askedPet = args.pet === true || args.asPet === true || /^(1|true|yes|上台|桌宠)$/i.test(String(args.pet ?? ""));
        const brief = str("brief") ?? str("about") ?? str("mission") ?? str("desc") ?? "";
        const text = [`创建 bot：${name}`, str("role") ? `角色${str("role")}` : "", str("persona") ? `风格${str("persona")}` : "", brief].filter(Boolean).join("，");
        const parsed = ruleParse(text);
        if (str("role")) parsed.role = str("role")!;
        if (str("persona")) parsed.persona = str("persona")!;
        if (brief && (!parsed.systemPrompt || parsed.systemPrompt.includes("通用助手"))) {
          parsed.systemPrompt = `${buildSystemPrompt(parsed)}\n职责补充：${brief.slice(0, 1200)}`;
        }
        const id = `bot-${Date.now().toString(36)}`;
        const nb: Bot = {
          id, name,
          role: parsed.role || "通用助手",
          persona: parsed.persona || "友好、可靠",
          systemPrompt: parsed.systemPrompt || buildSystemPrompt(parsed),
          providerId: "",
          petEnabled: false,
          avatar: defaultAvatar(id),
          createdAt: Date.now(),
        };
        store.saveBot(nb);
        const welcomeSid = seedBotWelcome(store, nb);
        this.deps.onBotCreated?.({ botId: nb.id, sessionId: welcomeSid });
        const tip = askedPet
          ? "。桌宠是独立娱乐层，建 bot 不会自动上台；请在 bot 详情打开「桌面宠物」，或对它说「出来」"
          : "";
        return changed("bots", `已创建 bot [${name}](app:bot/${encodeURIComponent(name)})，侧栏已刷新；点开可见欢迎语与起步建议${tip}`);
      }
      case "app.createGroup": {
        if (!this.deps.groups) return { output: "群聊未启用" };
        const name = str("name");
        const raw = args.members;
        const names = (Array.isArray(raw) ? raw : String(raw ?? "").split(/[,，、\s]+/)).map((x) => String(x).trim()).filter(Boolean);
        const bots = store.listBots();
        const ids = names.map((n) => bots.find((b) => b.name === n)?.id ?? bots.find((b) => b.name.includes(n))?.id).filter((x): x is string => !!x);
        if (args.includeSelf !== false && !ids.includes(bot.id)) ids.unshift(bot.id);
        if (!name || ids.length < 2) return { output: "app.createGroup 需要 name 和至少 1 个其他成员（members: bot 名数组）" };
        const goal = str("goal");
        let g;
        try {
          g = this.deps.groups.create(name, bot.id, [...new Set(ids)]);
          if (goal) g = this.deps.groups.update(g.id, { settings: { goal, relay: true } }) ?? g;
        } catch (e) { return { output: `❌ ${e instanceof Error ? e.message : String(e)}` }; }
        const memberNames = g.members.map((id) => bots.find((b) => b.id === id)?.name).filter((n): n is string => !!n);
        seedGroupWelcome(store, g, memberNames);
        return changed("groups", `已创建群聊「${name}」，成员：${memberNames.join("、")}${goal ? "；已写入群目标与欢迎房" : "；已写入欢迎房"}`);
      }
      case "app.updateGroup": {
        const groups = this.deps.groups;
        if (!groups) return { output: "群聊未启用" };
        const g = groups.findByName(str("group") ?? str("name") ?? "");
        if (!g) return { output: `❌ 没有这个群聊。现有：${groups.list().map((x) => x.name).join("、") || "无"}` };
        const bots = store.listBots();
        const resolve = (raw: unknown) => (Array.isArray(raw) ? raw : String(raw ?? "").split(/[,，、\s]+/)).map((x) => String(x).trim()).filter(Boolean);
        const unknown: string[] = [];
        const idsOf = (names: string[]) => names.map((n) => {
          const id = bots.find((b) => b.name === n)?.id;
          if (!id) unknown.push(n);
          return id;
        }).filter((x): x is string => !!x);
        const add = idsOf(resolve(args.add));
        const remove = new Set(idsOf(resolve(args.remove)));
        if (unknown.length) return { output: `❌ 找不到 bot：${unknown.join("、")}。现有：${bots.map((b) => b.name).join("、")}` };
        const members = [...new Set([...g.members.filter((id) => !remove.has(id)), ...add])];
        if (members.length < 2) return { output: "❌ 群聊至少要留 2 个成员" };
        const rename = str("rename");
        try { groups.update(g.id, { members, ...(rename ? { name: rename } : {}) }); }
        catch (e) { return { output: `❌ ${e instanceof Error ? e.message : String(e)}` }; }
        const label = rename || g.name;
        return changed("groups", `已更新群聊 [${label}](app:group/${encodeURIComponent(label)})，现在的成员：${members.map((id) => bots.find((b) => b.id === id)?.name ?? id).join("、")}`);
      }
      case "skill.list":
        return {
          output: this.deps.skills.visibleTo(bot.id).map((x) => {
            const on = this.deps.skills.enabledFor(bot, x);
            return `- ${x.key}：${x.name}（${x.owner ? "私有" : "共享"}${on ? "" : "，对本 bot 关闭"}）${x.description}`;
          }).join("\n") || "（还没有技能）",
        };
      case "skill.get": {
        const sk = this.deps.skills.get(str("key") ?? "");
        if (!sk || (sk.owner && sk.owner !== bot.id)) return { output: "没有这个技能" };
        return { output: `名称：${sk.name}\n描述：${sk.description}\n指令：\n${sk.body}` };
      }
      case "skill.save": {
        const key = str("key");
        const prev = key ? this.deps.skills.get(key) : null;
        if (prev?.owner && prev.owner !== bot.id) return { output: "不能修改其他 bot 的私有技能" };
        const willShare = args.shared === true || (prev ? !prev.owner : false);
        const label = str("name") ?? prev?.name ?? "";
        if (willShare && !(await this.sharedSkillConsent(bot, `${prev ? "修改" : "新建"}共享技能「${label}」（所有 bot 都会用到）\n${(str("instructions") ?? str("body") ?? "").slice(0, 1500)}`))) {
          return { output: `❌ 用户没有批准${prev ? "修改" : "新建"}共享技能「${label}」；可以去掉 shared 建成只给你用的私有技能` };
        }
        try {
          const sk = this.deps.skills.save({
            // 新建时可带 key（如 appstore-copy）；已有则只能改原 key
            key: prev ? prev.key : key || undefined,
            name: str("name") ?? prev?.name ?? "",
            description: str("description") ?? prev?.description ?? "",
            body: str("instructions") ?? str("body") ?? prev?.body ?? "",
            owner: args.shared === true ? undefined : prev ? prev.owner : bot.id,
            enabled: true,
          });
          return changed("skills", `${prev ? "已更新" : "已创建"}技能 [${sk.name}](app:skill/${sk.key})（${sk.owner ? "仅你可用" : "所有 bot 共享"}${prev && !prev.enabled ? "，原来是停用的，已经启用" : ""}）`);
        } catch (e) {
          return { output: `❌ ${e instanceof Error ? e.message : String(e)}` };
        }
      }
      case "skill.update": {
        const sk = this.deps.skills.get(str("key") ?? "");
        if (!sk || (sk.owner && sk.owner !== bot.id)) return { output: "❌ 没有这个技能（用 skill.list 看 key），或它是别的 bot 的私有技能" };
        const list = (v: unknown) => (Array.isArray(v) ? v : v == null ? [] : [v]).map((x) => String(x).trim()).filter(Boolean);
        let body = sk.body;
        const missed: string[] = [];
        const replaced: string[] = [];
        for (const r of (Array.isArray(args.replace) ? args.replace : []) as { find?: string; with?: string }[]) {
          const find = String(r?.find ?? "");
          const at = find ? body.indexOf(find) : -1;
          if (at >= 0) { body = body.slice(0, at) + String(r?.with ?? "") + body.slice(at + find.length); replaced.push(String(r?.with ?? "")); }
          else if (find) missed.push(find.slice(0, 40));
        }
        const rules = list(args.append ?? args.rules).filter((rule) => !isDuplicateRule(rule, body, replaced));
        const skipped = list(args.append ?? args.rules).length - rules.length;
        if (rules.length) body = appendSkillRules(body, rules);
        if (body === sk.body && !str("name") && !str("description")) {
          return { output: `❌ 没有改动${missed.length ? `：replace 里这些原文没找到（${missed.join("；")}），先用 skill.get 看原文` : "：给 append（新规范）或 replace（[{find, with}] 改旧规则）"}` };
        }
        if (!sk.owner && !(await this.sharedSkillConsent(bot, `修改共享技能「${sk.name}」（所有 bot 都会受影响）\n${[...replaced.map((x) => `改成：${x}`), ...rules.map((x) => `新增：${x}`)].join("\n").slice(0, 1500)}`))) {
          return { output: `❌ 用户没有批准修改共享技能「${sk.name}」` };
        }
        // 停用的技能不会进技能清单，写进去的规范不会生效，所以写规范时一并启用
        const saved = this.deps.skills.save({ key: sk.key, name: str("name") ?? sk.name, description: str("description") ?? sk.description, body, owner: sk.owner, enabled: true });
        const summary = [
          sk.enabled ? "" : "这个技能原来是停用的，已经启用",
          replaced.length ? `改了 ${replaced.length} 处旧规则` : "",
          rules.length ? `新增 ${rules.length} 条规范` : "",
          skipped ? `${skipped} 条和已有内容重复没再追加` : "",
          missed.length ? `这些原文没找到没改：${missed.join("；")}` : "",
        ].filter(Boolean).join("，");
        return changed("skills", `已写进技能 [${saved.name}](app:skill/${saved.key})${summary ? `：${summary}` : ""}\n现在的指令：\n${saved.body.slice(0, 1500)}`);
      }
      case "skill.delete": {
        const sk = this.deps.skills.get(str("key") ?? "");
        if (!sk) return { output: "没有这个技能" };
        if (sk.owner !== bot.id) return { output: "只能删除你自己的私有技能，共享技能请让用户在技能管理里删" };
        this.deps.skills.delete(sk.key);
        return changed("skills", `已删除技能「${sk.name}」`);
      }
    }
    return { output: `未知工具 ${tool}` };
  }

  /** memory.* 的 bot 参数：默认自己；可点名写给 / 改 / 列其他 bot */
  private resolveMemoryBot(self: Bot, args: Record<string, unknown>): { bot: Bot } | { error: string } {
    const q = String(args.bot ?? args.name ?? args.to ?? "").trim();
    if (!q || /^(我|自己|me|self)$/i.test(q)) return { bot: self };
    const bots = this.deps.store.listBots();
    const hit = bots.find((b) => b.name === q) ?? bots.find((b) => b.name.includes(q) || b.id === q);
    if (!hit) return { error: `❌ 找不到 bot「${q}」。可选：${bots.map((b) => b.name).join("、")}` };
    return { bot: hit };
  }

  private async executeBuiltin(bot: Bot, t: ToolInvocation, originalText: string, depth = 0, sessionId?: string, turn?: TurnCtx): Promise<ToolOutcome> {
    const args = t.args ?? {};
    if (t.tool === "webhook.list" || t.tool === "webhook.add" || t.tool === "webhook.remove" || t.tool === "webhook.post") {
      if (!this.deps.connectors) return { output: "出站 Webhook 未启用" };
      if (t.tool === "webhook.list") {
        const list = this.deps.connectors.listWebhooks();
        if (!list.length) {
          return {
            output: [
              "还没有登记出站 Webhook。",
              "两条路别混：",
              "1) 出站（本软件 POST 到你的 URL）：告诉我名称和 https 地址，我用 webhook.add；或打开 [Connect · Webhook](app:settings/vault)。",
              "2) 入站（外系统触发本 bot）：用 task.create 建例行并设 webhook:true，再到例行面板点 🪝 复制触发 URL（需先开 Connect → 入站网关）。",
            ].join("\n"),
          };
        }
        return {
          output: `${list.map((w) => `- ${w.name}（id=${w.id}）→ ${w.url}`).join("\n")}\n发内容用 webhook.post；管理也可用 [Connect · Webhook](app:settings/vault)。`,
        };
      }
      if (t.tool === "webhook.add") {
        const name = String(args.name ?? args.title ?? "").trim();
        const url = String(args.url ?? args.endpoint ?? "").trim();
        if (!name || !url) return { output: "❌ webhook.add 需要 name 和 url。若用户要的是「外系统触发我」，改用 task.create + webhook:true。" };
        let headers: Record<string, string> | undefined;
        const rawH = args.headers ?? args.header;
        if (rawH && typeof rawH === "object" && !Array.isArray(rawH)) {
          headers = {};
          for (const [k, v] of Object.entries(rawH as Record<string, unknown>)) headers[k] = String(v);
        } else if (typeof rawH === "string" && rawH.trim()) {
          try {
            const j = JSON.parse(rawH) as Record<string, unknown>;
            headers = {};
            for (const [k, v] of Object.entries(j)) headers[k] = String(v);
          } catch {
            return { output: "❌ headers 需为对象或 JSON 对象字符串" };
          }
        }
        try {
          if (await isPrivateHost(new URL(url).hostname)) {
            const ok = this.deps.consent
              ? (await this.deps.consent.request(bot.id, "net:local", `登记本机 / 局域网出站 Webhook：\n${url}`, {
                onceOnly: true,
                reasons: ["之后 webhook.post 可能打到内网"],
              })).granted
              : false;
            if (!ok) return { output: "❌ 用户未允许登记本机 / 局域网 Webhook" };
          }
        } catch {
          return { output: "❌ url 无效，需 http(s)://…" };
        }
        if (this.deps.consent) {
          const ok = (await this.deps.consent.request(bot.id, "webhook:out", `登记出站 Webhook「${name}」\n${url}`, {
            reasons: ["写入本机 Connect 目录，之后可用 webhook.post 发内容"],
          })).granted;
          if (!ok) return { output: "❌ 用户拒绝登记出站 Webhook" };
        }
        try {
          const w = this.deps.connectors.upsertWebhook({
            name,
            url,
            note: args.note != null ? String(args.note) : undefined,
            headers,
          });
          this.deps.onAppChanged?.("vault");
          this.deps.audit?.append({
            botId: bot.id,
            cap: "webhook:out",
            action: "webhook.add",
            args: `${w.name} ${w.url}`.slice(0, 200),
            granted: true,
            ok: true,
            detail: w.id,
          });
          return {
            output: `已登记出站 Webhook「${w.name}」（id=${w.id}）→ ${w.url}。可用 webhook.post to="${w.name}" 试发。查看：[Connect · Webhook](app:settings/vault)`,
          };
        } catch (e) {
          return { output: `❌ ${e instanceof Error ? e.message : String(e)}` };
        }
      }
      if (t.tool === "webhook.remove") {
        const key = String(args.name ?? args.id ?? args.to ?? "").trim();
        if (!key) return { output: "❌ webhook.remove 需要 name 或 id" };
        const w = this.deps.connectors.findWebhook(key);
        if (!w) return { output: `❌ 找不到 Webhook「${key}」。先 webhook.list。` };
        if (this.deps.consent) {
          const ok = (await this.deps.consent.request(bot.id, "webhook:out", `移除出站 Webhook「${w.name}」\n${w.url}`)).granted;
          if (!ok) return { output: "❌ 用户拒绝移除 Webhook" };
        }
        this.deps.connectors.removeWebhook(w.id);
        this.deps.onAppChanged?.("vault");
        this.deps.audit?.append({
          botId: bot.id,
          cap: "webhook:out",
          action: "webhook.remove",
          args: `${w.name} ${w.id}`.slice(0, 200),
          granted: true,
          ok: true,
        });
        return { output: `已移除出站 Webhook「${w.name}」。` };
      }
      const to = String(args.to ?? args.name ?? args.id ?? "").trim();
      if (!to) return { output: "❌ webhook.post 需要 to（名称或 id）" };
      const w = this.deps.connectors.findWebhook(to);
      if (!w) return { output: `❌ 找不到 Webhook「${to}」。先 webhook.list；没有则用 webhook.add 登记。` };
      let allowPrivate = false;
      try {
        if (await isPrivateHost(new URL(w.url).hostname)) {
          const ok = this.deps.consent
            ? (await this.deps.consent.request(bot.id, "net:local", `出站 Webhook 打到本机 / 局域网：\n${w.url}`)).granted
            : false;
          if (!ok) return { output: "❌ 用户未允许向本机 / 局域网发 Webhook" };
          allowPrivate = true;
        }
      } catch { /* url 校验交给 postWebhook */ }
      if (this.deps.consent) {
        const ok = (await this.deps.consent.request(bot.id, "webhook:out", `POST 到出站 Webhook「${w.name}」\n${w.url}`, {
          reasons: ["会把本轮内容发到你配置的 HTTP 端点"],
        })).granted;
        if (!ok) return { output: "❌ 用户拒绝出站 Webhook" };
      }
      const fillSecrets = (h: Record<string, string>) => {
        if (!this.deps.secrets) return h;
        const filled = this.deps.secrets.fill({ ...h }, bot.id);
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(filled.args)) out[k] = String(v);
        return out;
      };
      const startedAt = Date.now();
      const r = await this.deps.connectors.postWebhook(to, args.body ?? args.payload ?? {}, {
        fillSecrets,
        allowPrivate,
        signal: turn?.signal,
      });
      this.deps.audit?.append({
        botId: bot.id,
        cap: "webhook:out",
        action: "webhook.post",
        args: `${w.name} ${w.url}`.slice(0, 200),
        granted: true,
        ok: r.ok,
        latencyMs: Date.now() - startedAt,
        detail: r.ok ? `HTTP ${r.status}` : ("error" in r ? r.error : "failed"),
      });
      if (!r.ok) return { output: `❌ ${r.error}` };
      return { output: `已 POST 到「${r.name}」（HTTP ${r.status}）${r.body ? `\n响应：${r.body.slice(0, 500)}` : ""}` };
    }
    if (t.tool === "mcp.list" || t.tool === "mcp.add" || t.tool === "mcp.remove") {
      if (!this.deps.mcpManage) return { output: "MCP 管理未启用" };
      if (t.tool === "mcp.list") {
        const sync = this.deps.mcpManage.resync ? await this.deps.mcpManage.resync() : null;
        if (sync?.reloaded) this.deps.onAppChanged?.("mcp");
        const list = this.deps.mcpManage.list();
        if (!list.length) return { output: "还没有接入 MCP server。用 mcp.add 安装，例如 command: `npx -y mcp-git`。查看 / 手工改：[MCP 工具](app:settings/mcp)" };
        const lines = list.map((s) => `- ${s.name}（id=${s.id}）${s.error ? ` ✕ ${s.error}` : ` · ${s.tools} 个工具`} · ${s.url ?? [s.command, ...(s.args ?? [])].filter(Boolean).join(" ")}`);
        const note = sync?.reloaded ? `\n（已从磁盘配置热加载，现共 ${sync.count} 个）` : "";
        return { output: `已接入 ${list.length} 个 MCP：\n${lines.join("\n")}\n调用某个工具用 mcp:<id>/<工具名>；管理面板：[MCP 工具](app:settings/mcp)${note}` };
      }
      if (t.tool === "mcp.remove") {
        const key = String(args.id ?? args.name ?? args.server ?? "").trim();
        if (!key) return { output: "❌ mcp.remove 需要 id 或 name" };
        if (this.deps.consent) {
          const ok = (await this.deps.consent.request(bot.id, "mcp:manage", `移除 MCP「${key}」`)).granted;
          if (!ok) return { output: "❌ 用户拒绝移除 MCP" };
        }
        const r = await this.deps.mcpManage.remove(key);
        if ("error" in r) return { output: `❌ ${r.error}` };
        this.deps.onAppChanged?.("mcp");
        return { output: `已移除 MCP「${r.removed}」。查看：[MCP 工具](app:settings/mcp)` };
      }
      const name = String(args.name ?? "").trim();
      const url = args.url != null ? String(args.url).trim() : "";
      const cmdRaw = String(args.command ?? args.cmd ?? "").trim();
      const idHint = String(args.id ?? "").trim();
      if (!name) return { output: "❌ mcp.add 需要 name" };
      if (!url && !cmdRaw && !args.args) return { output: "❌ mcp.add 需要 command（如 `npx -y mcp-git`）或 url" };
      if (url) {
        let u: URL;
        try { u = new URL(url); } catch { return { output: "❌ mcp.add url 无效" }; }
        if (!/^https?:$/.test(u.protocol)) return { output: "❌ MCP url 仅支持 http(s)" };
        if (await isPrivateHost(u.hostname)) {
          const ok = this.deps.consent
            ? (await this.deps.consent.request(bot.id, "net:local", `接入本机 / 局域网 MCP：\n${url}`, { onceOnly: true, reasons: ["可能探测内网服务"] })).granted
            : false;
          if (!ok) return { output: "❌ 用户未允许访问本机 / 局域网 MCP 地址" };
        }
      }
      let command: string | undefined;
      let cmdArgs: string[] | undefined;
      if (!url) {
        if (Array.isArray(args.args)) {
          command = cmdRaw || "npx";
          cmdArgs = args.args.map(String);
        } else {
          const parts = cmdRaw.match(/"[^"]*"|'[^']*'|\S+/g)?.map((x) => x.replace(/^["']|["']$/g, "")) ?? [];
          if (!parts.length) return { output: "❌ command 无效" };
          command = parts[0];
          cmdArgs = parts.slice(1);
        }
      }
      const stdioCheck = command ? checkMcpStdioCommand(command) : { ok: true as const, allowed: true };
      if (this.deps.consent) {
        const detail = url ? `URL ${url}` : `命令 ${[command, ...(cmdArgs ?? [])].filter(Boolean).join(" ")}`;
        const reasons = ["会写入本机配置并立即连接"];
        if (!url && !stdioCheck.allowed) {
          reasons.push(`启动命令「${command}」不在常用白名单（${MCP_STDIO_ALLOW.join(" / ")}）`, "请确认来源可信后再装");
        }
        const ok = (await this.deps.consent.request(bot.id, "mcp:manage", `安装 MCP「${name}」\n${detail}`, {
          onceOnly: !url && !stdioCheck.allowed,
          requiresStrongConsent: !url && !stdioCheck.allowed,
          reasons,
        })).granted;
        if (!ok) return { output: "❌ 用户拒绝安装 MCP" };
      } else if (!url && !stdioCheck.allowed) {
        return { output: `❌ 无授权中心时，MCP 启动命令仅允许：${MCP_STDIO_ALLOW.join("、")}。当前是「${command}」。` };
      }
      const r = await this.deps.mcpManage.add({ id: idHint || undefined, name, command, args: cmdArgs, url: url || undefined });
      this.deps.onAppChanged?.("mcp");
      if (r.error) return { output: `已写入配置，但连接失败：${r.error}\nid=${r.id}。检查命令后可用 mcp.remove 删掉重装。查看：[MCP 工具](app:settings/mcp)` };
      return { output: `已接入 MCP「${r.name}」（id=${r.id}），发现 ${r.tools} 个工具，立刻可用。调用示例：mcp:${r.id}/<工具名>。查看：[MCP 工具](app:settings/mcp)` };
    }
    if (t.tool === "task.create" || t.tool === "task.list" || t.tool === "task.delete") {
      if (!this.deps.tasks) return { output: "定时任务未启用" };
      // 增删走 Scheduler.onChange → app:changed，右栏定时任务列表会跟着刷
      const r = runTaskTool(this.deps.tasks, bot, t.tool, args, sessionId);
      if (t.tool !== "task.create" || !r.output.startsWith("已创建") || !this.deps.notifyCheck) return r;
      const ok = await this.deps.notifyCheck("⏰ 提醒已设好", r.output.replace(/^已创建(一次性|周期)任务/, "").slice(0, 80));
      return {
        ...r,
        output: ok ? r.output : `${r.output}\n⚠️ 系统通知现在弹不出来（macOS 没给本软件通知权限）。到点时提醒会发到这个聊天里。告诉用户这一点，并原样附上这个可点的链接让用户一键去开启：[去开启通知](app:settings/notifications)`,
      };
    }
    if (t.tool === "bot.list") {
      return { output: this.prompt.teamRoster(bot) || "（暂无其他 bot）" };
    }
    if (t.tool === "bot.ask") {
      if (!this.deps.askBot) return { output: "bot 间通信未启用" };
      // 允许被问方再转问一层（Grok：bots coordinate）；再深容易环，卡住
      if (depth >= 2) return { output: "❌ 这一问已经转过两手了，不要再 bot.ask，请凭已有信息直接回答；需要用户拍板的写进回复里。" };
      const target = String(args.to ?? args.bot ?? args.name ?? "").trim();
      const message = String(args.message ?? args.text ?? args.question ?? "");
      if (!target || !message) return { output: "❌ bot.ask 需要 to（bot 名）和 message" };
      const askKey = `${bot.id}\0${target}\0${message}`;
      const hit = this.recentAsks.get(askKey);
      const now = Date.now();
      // 原文完全相同才复用成功结果；软失败（找不到人等）不缓存，避免修好后仍吃旧错
      if (hit && now - hit.at < 90_000) {
        return { output: `（与刚才问过的相同，直接复用上一次回复）\n${hit.output}` };
      }
      const pending = this.inflightAsks.get(askKey);
      if (pending) {
        try {
          const output = await pending;
          return { output: `（与刚才问过的相同，直接复用上一次回复）\n${output}` };
        } catch (e) {
          return { output: `❌ 询问 ${target} 失败：${e instanceof Error ? e.message : String(e)}` };
        }
      }
      // 只跳过工具层软失败；「某某 回复：❌ …」是对方已接通的业务报错，仍可复用
      const askFailed = (out: string) => /^(❌|找不到名为|bot 间通信未启用)/.test(out.trim());
      const run = (async () => {
        const output = await this.deps.askBot!(bot, target, message, depth + 1, sessionId, turn?.signal);
        if (!askFailed(output)) {
          this.recentAsks.set(askKey, { at: Date.now(), output });
          if (this.recentAsks.size > 64) {
            const oldest = [...this.recentAsks.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
            if (oldest) this.recentAsks.delete(oldest);
          }
        }
        return output;
      })();
      this.inflightAsks.set(askKey, run);
      try {
        const output = await run;
        return { output };
      } catch (e) {
        return { output: `❌ 询问 ${target} 失败：${e instanceof Error ? e.message : String(e)}` };
      } finally {
        this.inflightAsks.delete(askKey);
      }
    }
    if (["fs.read", "fs.write", "fs.list", "bash.run", "web.fetch", "notify"].includes(t.tool)) {
      if (!this.deps.executor) return { output: `工具 ${t.tool} 未启用（executor 未注入）` };
      // fs.list/read 不设工程白名单；extraRoots 只给 bash 路径风险提示（工程目录少标风险）。fs.write 仍只限工作区。
      const projectRoot = this.deps.env?.visibleTo(bot.id).find((e) => e.key === "PROJECT_ROOT")?.value?.trim();
      const browseRoots = [...new Set([...codingDirList(bot), ...(projectRoot ? [projectRoot] : [])])];
      const extraRoots = t.tool === "bash.run" ? browseRoots : [];
      const r = await this.deps.executor.run(t.tool, {
        ...args, botId: bot.id,
        extraRoots,
        signal: turn?.signal,
        unattended: !!turn?.unattended,
      });
      return { output: r.ok && (t.tool === "fs.read" || t.tool === "web.fetch") ? untrusted(String(args.path ?? args.url ?? ""), r.output) : r.output };
    }
    if (t.tool === "remember" || t.tool === "memory.add") {
      const content = String(args.content ?? args.text ?? "").trim();
      if (!content) return { output: "❌ memory.add 需要 content" };
      const asked = (["rule", "fact", "note"] as const).find((k) => k === args.kind) ?? "fact";
      // 「以后称呼我…」「回答都用…」是对 bot 的要求：存成规范才会常驻，存成事实会被新事实挤掉
      const kind = asked === "fact" && looksLikeRule(content) ? "rule" : asked;
      const shared = args.scope === "all" || args.scope === "global";
      const target = this.resolveMemoryBot(bot, args);
      if ("error" in target) return { output: target.error };
      const entry = this.deps.memory.add(target.bot.id, {
        kind,
        content,
        tags: args.tags ? String(args.tags).split(",").map((s) => s.trim()) : undefined,
        source: "bot",
        namespace: shared ? "global" : undefined,
      });
      const forWhom = shared ? "，所有 bot 共享" : target.bot.id !== bot.id ? `，写给 ${target.bot.name}` : "";
      return { output: `已记住${kind === "rule" ? "（规范）" : ""}${forWhom}：${entry.content}\n查看 / 修改：${memoryLink(target.bot, kind, shared)}` };
    }
    if (t.tool === "memory.list") {
      const target = this.resolveMemoryBot(bot, args);
      if ("error" in target) return { output: target.error };
      const kindRaw = String(args.kind ?? "").trim().toLowerCase();
      const kind = kindRaw === "rule" || kindRaw === "规范" ? "rule"
        : kindRaw === "fact" || kindRaw === "事实" ? "fact"
        : kindRaw || "";
      const entries = this.deps.memory.list(`bot:${target.bot.id}`)
        .filter((e) => !kind || e.kind === kind)
        .filter((e) => e.kind === "rule" || e.kind === "fact" || e.kind === "note")
        .sort((a, b) => a.updatedAt - b.updatedAt);
      const label = (k: string) => (k === "rule" ? "规范" : k === "fact" ? "事实" : k);
      const link = memoryLink(target.bot, kind === "fact" ? "fact" : "rule");
      if (!entries.length) {
        return { output: `${target.bot.name} 的${kind ? label(kind) : "记忆"}：0 条\n查看：${link}` };
      }
      const lines = entries.map((e, i) => `${i + 1}. [${label(e.kind)}] ${e.content}`);
      return { output: `${target.bot.name} 的${kind ? label(kind) : "记忆"}，共 ${entries.length} 条：\n${lines.join("\n")}\n查看 / 修改：${link}` };
    }
    if (t.tool === "memory.update" || t.tool === "memory.forget") {
      const match = String(args.match ?? args.find ?? args.old ?? "").trim();
      if (!match) return { output: `❌ ${t.tool} 需要 match（原文里的几个字）` };
      const shared = args.scope === "all" || args.scope === "global";
      const target = this.resolveMemoryBot(bot, args);
      if ("error" in target) return { output: target.error };
      const ns = shared ? "global" : `bot:${target.bot.id}`;
      const hits = this.deps.memory.list(ns).filter((e) => e.content.includes(match));
      if (!hits.length) return { output: `❌ 没找到包含「${match}」的${shared ? "全局" : target.bot.id !== bot.id ? target.bot.name + " 的" : ""}记忆，先看【规范存放位置】里的原文再定位` };
      if (hits.length > 1) return { output: `❌ 有 ${hits.length} 条都包含「${match}」，match 再写具体一点：\n${hits.slice(0, 8).map((h) => `- ${h.content}`).join("\n")}` };
      const [hit] = hits;
      const link = memoryLink(target.bot, hit.kind, shared);
      if (t.tool === "memory.forget") {
        this.deps.memory.delete(ns, hit.id);
        return { output: `已删除：${hit.content}\n查看：${link}` };
      }
      const content = String(args.content ?? args.with ?? "").trim();
      if (!content) return { output: "❌ memory.update 需要 content" };
      this.deps.memory.update(ns, hit.id, content);
      return { output: `已修改：${hit.content} → ${content}\n查看 / 修改：${link}` };
    }
    if (t.tool === "recall" || t.tool === "memory.search") {
      const q = String(args.query ?? args.q ?? "");
      const semantic = this.deps.recall ? await this.deps.recall(bot, q).catch(() => "") : "";
      if (semantic) return { output: semantic };
      const groups = this.prompt.groupIdsOf(bot);
      const hits = await this.deps.memory.retrieveCascade(bot.id, groups, q, 6);
      return { output: hits.length ? hits.map((h) => `- [${h.namespace ?? "bot"}] ${h.content}`).join("\n") : "（暂无相关记忆）" };
    }
    if (t.tool === "apple.openApp" || t.tool === "apple.activate" || t.tool === "apple.type" || t.tool === "apple.click" || t.tool === "apple.hotkey" || t.tool === "apple.tellApp") {
      // G5：AppleScript 应用控制（授权后）
      if (!this.deps.systemAccess) return { output: "系统访问未启用" };
      const action = t.tool.slice(6);
      const out = await this.deps.systemAccess.apple(bot.id, action, args);
      return { output: out };
    }
    if (t.tool === "screen.screenshot") {
      // G5：屏幕截图（授权后）→ 直接注入会话 image 块
      if (!this.deps.systemAccess) return { output: "系统访问未启用" };
      const rect = args.rect as Record<string, unknown> | undefined;
      const r = await this.deps.systemAccess.screenshot(bot.id, rect ? {
        x: Number(rect.x ?? 0), y: Number(rect.y ?? 0),
        w: Number(rect.w ?? 800), h: Number(rect.h ?? 600),
      } : undefined);
      if (args.inject === false) return { output: `截图已保存: ${r.path}` };
      return {
        output: `截图已保存: ${r.path}，并已附在这条回复里展示给用户，不用再发送`,
        blocks: [{ type: "image", path: r.path, alt: "截图" }],
      };
    }
    if (t.tool === "sys.observe" || t.tool === "sys.processes" || t.tool === "sys.disk" || t.tool === "sys.activity" || t.tool === "sys.scan" || t.tool === "sys.purge") {
      return this.sysObserveTool(bot, t.tool, args, !!turn?.unattended);
    }
    return { output: `未知工具 ${t.tool}` };
  }

  /** 系统行为观察 / 浅扫 / 受控删除——场景由 bot + task.create 组合 */
  private async sysObserveTool(bot: Bot, tool: string, args: Record<string, unknown>, unattended = false): Promise<ToolOutcome> {
    const home = this.deps.harnessHome;
    if (tool === "sys.purge") {
      const paths = Array.isArray(args.paths) ? args.paths.map((x) => String(x ?? "").trim()).filter(Boolean) : [];
      if (!paths.length) return { output: "❌ sys.purge 需要 paths（文件路径数组）。先 sys.scan 再挑要删的。" };
      if (!this.deps.consent) return { output: "❌ 授权中心未启用，拒绝删除" };
      const r = await this.deps.consent.request(bot.id, "bash:io", `删除 ${paths.length} 个文件：\n${paths.slice(0, 12).join("\n")}${paths.length > 12 ? "\n…" : ""}`, {
        requiresStrongConsent: true,
        unattended,
        reasons: ["不可恢复", "仅允许家目录下的真实路径（拒绝符号链接逃逸）", "点「以后不再问」就记住，不用每次确认"],
      });
      if (!r.granted) {
        this.deps.audit?.append({ botId: bot.id, cap: "bash:io", action: "sys.purge", args: paths.slice(0, 8).join(","), granted: false });
        return { output: "❌ 用户拒绝删除" };
      }
      const out = purgePaths(paths);
      this.deps.audit?.append({ botId: bot.id, cap: "bash:io", action: "sys.purge", args: `${out.deleted.length} deleted`, granted: true, ok: true });
      return {
        output: [
          `已删 ${out.deleted.length} 个`,
          ...out.deleted.slice(0, 30).map((p) => `- ${p}`),
          out.failed.length ? `失败 ${out.failed.length}：` : "",
          ...out.failed.slice(0, 10).map((f) => `- ${f.path}：${f.error}`),
        ].filter(Boolean).join("\n"),
      };
    }

    if (!this.deps.consent) return { output: "❌ 授权中心未启用，拒绝系统观察" };
    {
      const r = await this.deps.consent.request(bot.id, "system:observe", `系统观察：${tool}`);
      if (!r.granted) {
        this.deps.audit?.append({ botId: bot.id, cap: "system:observe", action: tool, granted: false });
        return { output: "❌ 用户未批准系统观察（system:observe）" };
      }
    }
    this.deps.audit?.append({ botId: bot.id, cap: "system:observe", action: tool, granted: true, ok: true });

    const watch = this.deps.harnessHome
      ? readBotWatch(this.deps.store.readConfig(), bot.id)
      : { enabled: true, apps: [] as string[] };
    const defaultApps = watchKeywords(watch);
    const parseApps = () => {
      if (Array.isArray(args.apps)) return args.apps.map((x) => String(x));
      const raw = String(args.apps ?? "").trim();
      if (raw) return raw.split(",").map((s) => s.trim()).filter(Boolean);
      return defaultApps;
    };

    if (tool === "sys.processes") {
      const apps = parseApps();
      const rows = observeProcesses(apps);
      const scope = apps.length ? `（名单：${apps.slice(0, 8).join("、")}）` : "（未设监听名单，按占用）";
      return {
        output: rows.length
          ? `${scope}\n` + rows.map((p) => `${p.identity?.label || p.command} · pid ${p.pid} · CPU ${p.cpu}% · RSS ${Math.round(p.rssKb / 1024)}MB`).join("\n")
          : `${scope}\n（无匹配进程）`,
      };
    }
    if (tool === "sys.disk") {
      const rows = observeDisk();
      return {
        output: rows.map((d) => `${d.identity?.label || d.mount}（${d.mount}） · ${d.usedPct}% · ${(d.usedKb / 1024 / 1024).toFixed(1)}/${(d.totalKb / 1024 / 1024).toFixed(1)} GB`).join("\n") || "（读不到磁盘）",
      };
    }
    if (tool === "sys.activity") {
      if (!home) return { output: "活动账本未启用（无 harnessHome）" };
      const days = Math.max(1, Math.min(90, Number(args.sinceDays) || 7));
      let botId: string | undefined;
      const want = String(args.bot ?? "").trim();
      if (want) {
        const hit = this.deps.store.listBots().find((b) => b.id === want || b.name === want || b.name.includes(want));
        if (!hit) return { output: `❌ 找不到 bot「${want}」` };
        botId = hit.id;
      }
      const summary = summarizeCodingActivity(home, {
        botId,
        since: Date.now() - days * 24 * 60 * 60_000,
      });
      return { output: summary.text };
    }
    if (tool === "sys.scan") {
      const path = String(args.path ?? "").trim();
      if (!path) return { output: "❌ sys.scan 需要 path（家目录内，如 ~/Downloads）" };
      const hits = scanOldFiles(path, {
        minAgeDays: Number(args.minAgeDays) || 30,
        minSizeKb: Number(args.minSizeKb) || 0,
        cap: Number(args.limit) || 80,
      });
      if (!hits.length) return { output: `在 ${path} 下没有找到符合条件的过期文件（或路径不安全/不存在）。` };
      const total = hits.reduce((n, h) => n + h.sizeBytes, 0);
      return {
        output: [
          `${path} · ${hits.length} 个候选 · 约 ${(total / 1024 / 1024).toFixed(1)} MB（只列不删；要删用 sys.purge）`,
          ...hits.slice(0, 60).map((h) => `- ${h.path} · ${(h.sizeBytes / 1024).toFixed(0)} KB · ${new Date(h.mtimeMs).toLocaleDateString()}`),
        ].join("\n"),
      };
    }
    // sys.observe
    const apps = parseApps();
    const days = Math.max(1, Math.min(90, Number(args.sinceDays) || 7));
    const snap = observeSystem(home || homedir(), {
      apps,
      includeCoding: args.coding !== false && !!home,
      codingSinceMs: days * 24 * 60 * 60_000,
    });
    const head = watch.enabled && watch.apps.length
      ? `【本 bot 监听名单】${watch.apps.join("、")}（可用详情页增删）\n`
      : watch.enabled ? "【本 bot 尚未勾选监听 App，详情页可添加】\n" : "【本 bot 监听已关闭】\n";
    return { output: head + formatObserveText(snap) };
  }

  /** G10：派本机 Coding CLI 改工程（与聊天 CLI-ask 分离） */
  private async cliAgentTool(bot: Bot, args: Record<string, unknown>, turn: TurnCtx): Promise<ToolOutcome> {
    const job = await this.runCodingJob(bot, args, turn);
    return { output: job.output };
  }

  /**
   * 改仓库的唯一入口（聊天里的 cli.agent）。
   * 无人值守直接拒绝。
   */
  async runCodingJob(bot: Bot, args: Record<string, unknown>, turn: TurnCtx): Promise<{ ok: boolean; output: string; cwd?: string }> {
    const task = String(args.task ?? args.prompt ?? args.message ?? "").trim();
    if (!task) return { ok: false, output: "cli.agent 需要 task（要改什么、验收标准）" };
    if (!this.deps.consent) return { ok: false, output: "❌ 没有授权中心，拒绝派工 Coding CLI。" };
    if (isCliAgentBusy(bot.id)) return { ok: false, output: "❌ 该 bot 已有一个 cli.agent 在跑，等它结束再派" };

    const projectRoot = this.deps.env?.visibleTo(bot.id).find((e) => e.key === "PROJECT_ROOT")?.value;
    let cwdRaw: string;
    try {
      cwdRaw = resolveCwdInput(args, { projectRoot, agentCwd: bot.agentCwd });
      if (!cwdRaw) {
        return {
          ok: false,
          output:
            "❌ 缺少工程目录。请在终端面板点「选择目录」，或传 cwd，或 env.set PROJECT_ROOT，或先 term.open。",
        };
      }
    } catch (e) {
      return { ok: false, output: `❌ ${e instanceof Error ? e.message : String(e)}` };
    }

    const preferred = parseCliName(args.cli ?? args.cliName) ?? bot.agentCli;
    const cli = preferred ? await pickInstalledCli(preferred) : await pickInstalledCli();
    if (!cli) {
      return {
        ok: false,
        output:
          "❌ 本机没有就绪的 Coding CLI（需已安装且可派工；Cursor 未登录不算就绪）。终端可以先用 term.open 开 shell；改仓库需要到设置 → 模型刷新探测并登录后再 cli.agent。",
      };
    }
    const fellBack = !!(preferred && preferred !== cli);

    const timeoutMin = Math.min(Math.max(Number(args.timeoutMin ?? 20) || 20, 1), 60);
    const harnessHome = this.deps.workspaceRoot ? join(this.deps.workspaceRoot, "..") : undefined;
    let cwd: string;
    try {
      cwd = resolveAgentCwd(cwdRaw, { harnessHome });
    } catch (e) {
      return { ok: false, output: `❌ ${e instanceof Error ? e.message : String(e)}` };
    }
    const desc =
      `派本机 ${cli} CLI（可写 Agent）改工程\n目录：${cwd}\n任务：${task.slice(0, 500)}${task.length > 500 ? "…" : ""}`;

    let viaPathGrant = false;
    const r = await this.deps.consent.requestCliAgent(bot.id, cwd, desc, {
      reasons: ["将启动外部 Coding CLI，可在该目录读写文件并执行命令", "「总是允许此目录」后，开终端、打字和派工都不再问；普通配置和保险库密钥会进入这个终端的环境"],
      unattended: !!turn.unattended,
    });
    if (!r.granted) {
      this.deps.audit?.append({ botId: bot.id, cap: "cli:agent", action: "cli.agent", args: `${cli} ${cwd}`, granted: false });
      return { ok: false, output: "❌ 用户没有批准派工 Coding CLI，不要换别的 CLI 重试绕过，直接告诉用户" };
    }
    viaPathGrant = !!r.viaPathGrant;

    // 目录信任二次派工：不再弹窗，但仍给模型/用户一条可见摘要（避免完全静默）
    if (viaPathGrant) {
      turn.onToolProgress?.(
        `已信任目录，直接派工 ${cli} → ${cwd}${fellBack ? `（偏好 ${preferred} 未就绪，已换）` : ""}\n${task.slice(0, 200)}`,
      );
    } else if (fellBack) {
      turn.onToolProgress?.(`偏好 ${preferred} 未就绪，改用 ${cli}`);
    }

    const rules = [...this.deps.memory.list("global"), ...this.deps.memory.list(bot.id)]
      .filter((e) => e.kind === "rule")
      .slice(-12)
      .map((e) => e.content.trim())
      .filter(Boolean);
    const constraints = rules.length ? rules.map((r) => `- ${r}`).join("\n").slice(0, 1800) : undefined;
    const thread = this.deps.codingThreads?.get(bot.id, cwd);
    const knownSession = thread?.sessions[cli];
    const resume = shouldResume({ pref: bot.agentResume, task, sessionId: knownSession });
    const promptBase = { task, cwd, botName: bot.name, constraints };
    const freshPrompt = buildAgentPrompt({ ...promptBase, brief: threadBrief(thread) });
    const brief = threadBrief(thread);
    const promptText = this.deps.codingPresence
      ? presenceTaskLine(task, { brief })
      : resume ? buildAgentPrompt({ ...promptBase, resume: true }) : freshPrompt;

    const t0 = Date.now();
    try {
      const agentReq = {
        task,
        cwd,
        cli,
        botName: bot.name,
        constraints,
        promptText,
        fallbackPrompt: resume ? freshPrompt : undefined,
        resumeId: resume ? knownSession : undefined,
        createSessionId: !resume && cli === "claude" ? randomUUID() : undefined,
        timeoutMs: timeoutMin * 60_000,
        signal: turn.signal,
        harnessHome,
        onProgress: turn.onToolProgress,
        env: this.terminalEnv(bot, cwd, !!turn.unattended),
      };
      const result = this.deps.codingPresence
        ? await this.deps.codingPresence.dispatch(bot.id, agentReq)
        : await runCliAgent(bot.id, agentReq);
      this.deps.audit?.append({
        botId: bot.id,
        cap: "cli:agent",
        action: "cli.agent",
        args: `${cli} ${cwd} ${task.slice(0, 120)}`,
        granted: true,
        ok: result.ok,
        latencyMs: Date.now() - t0,
        detail: `${result.cancelled ? "cancelled" : result.timedOut ? "timeout" : `exit ${result.exitCode}`}${viaPathGrant ? ";path-grant" : ""}${resume ? ";resume" : ""}${result.resumedThenFresh ? ";resume-fallback" : ""}${result.reused ? ";resident-reuse" : result.keptAlive ? ";resident" : ""}`,
      });
      if (this.deps.codingThreads && !result.cancelled) {
        this.deps.codingThreads.save(nextCodingThread(thread, {
          botId: bot.id,
          cwd,
          cli,
          task,
          summary: result.output,
          sessionId: result.sessionId,
          keepGoal: !wantsFreshTask(task) && task.trim().length < 16 && !!thread?.goal,
        }));
      }
      if (result.ok && !result.cancelled) {
        const nextBot = { ...bot, ...gazeCodingDir(bot, cwd) };
        if (bot.agentResume === "once") delete nextBot.agentResume;
        if (!nextBot.agentCli) nextBot.agentCli = cli;
        const sameDirs = (bot.agentDirs ?? []).join("\n") === (nextBot.agentDirs ?? []).join("\n");
        if (nextBot.agentCwd !== bot.agentCwd || !sameDirs || nextBot.agentCli !== bot.agentCli || bot.agentResume === "once") {
          this.deps.store.saveBot(nextBot);
          this.deps.onAppChanged?.("bots");
        }
      }
      const head = [
        viaPathGrant ? `（目录已信任，本次未再弹窗 · ${cli}）` : "",
        resume && !this.deps.codingPresence && !result.resumedThenFresh ? `（续 ${cli} 会话）` : "",
        result.reused ? `（打进还开着的 ${cli} 终端，没有重新启动）` : "",
        result.keptAlive && !result.reused ? `（${cli} 终端已打开，屏幕和界面上是同一块）` : "",
      ].filter(Boolean).join("\n");
      const envNote = this.terminalEnvNote(bot, cwd, !!result.reused);
      const output = [head, envNote, result.output].filter(Boolean).join("\n");
      return { ok: result.ok && !result.cancelled && !result.timedOut, output, cwd };
    } catch (e) {
      const msg = e instanceof CliAgentPathError ? e.message : e instanceof Error ? e.message : String(e);
      this.deps.audit?.append({
        botId: bot.id,
        cap: "cli:agent",
        action: "cli.agent",
        args: `${cli} ${cwd}`,
        granted: true,
        ok: false,
        latencyMs: Date.now() - t0,
        detail: msg.slice(0, 200),
      });
      return { ok: false, output: `❌ 派工失败：${msg}` };
    }
  }

  /** 目录已信任，或 bot 为 Auto / Always 时，终端可以拿到保险库密钥。 */
  private terminalSecretsReady(bot: Bot, args: Record<string, unknown>): boolean {
    if (!this.deps.consent) return false;
    if (this.deps.consent.isTrusted(bot.id)) return true;
    const raw = String(args.cwd ?? bot.agentCwd ?? "").trim();
    if (!raw) return false;
    try {
      const harnessHome = this.deps.workspaceRoot ? join(this.deps.workspaceRoot, "..") : undefined;
      return this.deps.consent.hasCodingDir(bot.id, resolveAgentCwd(raw, { harnessHome }));
    } catch {
      return false;
    }
  }

  /** 普通配置始终进入终端。密钥在目录已信任，或这次是例行吩咐时进入。 */
  private terminalEnv(bot: Bot, cwd: string, standingOrder = false): Record<string, string> {
    const env: Record<string, string> = { ...(this.deps.env?.envFor(bot.id) ?? {}) };
    if (standingOrder || this.codingDirReady(bot.id, cwd)) {
      for (const s of this.deps.secrets?.list(bot.id) ?? []) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.name)) continue;
        const v = this.deps.secrets?.get(s.name, bot.id);
        if (v) env[s.name] = v;
      }
    }
    return env;
  }

  private terminalEnvNote(bot: Bot, cwd: string, reused: boolean): string {
    const trusted = this.codingDirReady(bot.id, cwd);
    const hasEnv = Object.keys(this.deps.env?.envFor(bot.id) ?? {}).length > 0;
    if (!trusted && !hasEnv) return "";
    if (trusted && reused) return "（这块终端是之前打开的。若信任是后来才给的，关掉再开一次，$名字 才会是保险库里的值。）";
    if (trusted) return "（普通配置和保险库密钥已在这个终端的环境里，用 $名字。）";
    return "（普通配置已在这个终端的环境里。密钥要等这个目录被信任后重新打开才进入。）";
  }

  /** 目录已「总是允许」，或 bot 为 Auto / Always。无人值守只走这条。 */
  private codingDirReady(botId: string, cwd: string): boolean {
    const consent = this.deps.consent;
    if (!consent) return false;
    return consent.isTrusted(botId) || consent.hasCodingDir(botId, cwd);
  }

  /** 解析终端工具的 cwd：显式 args → PROJECT_ROOT → agentCwd；失败返回可读错误。 */
  private resolveTermCwd(bot: Bot, args: Record<string, unknown>): { cwd: string } | { error: string } {
    const projectRoot = this.deps.env?.visibleTo(bot.id).find((e) => e.key === "PROJECT_ROOT")?.value;
    try {
      const raw = resolveCwdInput(args, { projectRoot, agentCwd: bot.agentCwd });
      if (!raw) return { error: "❌ 缺少工程目录。传 cwd，或先在终端面板选目录，或 env.set PROJECT_ROOT。" };
      const harnessHome = this.deps.workspaceRoot ? join(this.deps.workspaceRoot, "..") : undefined;
      return { cwd: resolveAgentCwd(raw, { harnessHome }) };
    } catch (e) {
      return { error: `❌ ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  private browserSecretsReady(bot: Bot): boolean {
    if (!this.deps.consent) return false;
    if (this.deps.consent.isTrusted(bot.id)) return true;
    return this.deps.consent.has(bot.id, "browser:open");
  }

  private async ensureBrowserConsent(bot: Bot, url: string | undefined, turn: TurnCtx): Promise<{ ok: true } | { ok: false; output: string }> {
    if (!this.deps.consent) return { ok: false, output: "❌ 没有授权中心，拒绝打开浏览器。" };
    const where = url ? `\n地址：${url}` : "";
    const r = await this.deps.consent.requestBrowserOpen(bot.id, `打开 bot 内部浏览器${where}`, {
      reasons: [
        "界面会打开这个 bot 自己的浏览器面板（不是你的 Chrome）",
        "登录态按 bot 隔离，可留作以后例行使用",
        "点「以后不再问」后，开浏览器和导航不再弹卡",
        "验证码等需要本人操作时，在面板里接手即可",
      ],
      unattended: !!turn.unattended,
    });
    if (!r.granted) {
      this.deps.audit?.append({ botId: bot.id, cap: "browser:open", action: "browser.open", args: url ?? "", granted: false });
      return { ok: false, output: "❌ 用户没有批准打开浏览器" };
    }
    if (url) {
      try {
        const host = new URL(url).hostname;
        if (await isPrivateHost(host)) {
          const local = await this.deps.consent.request(bot.id, "net:local", `bot 浏览器打开本机 / 局域网地址 ${url}`, { unattended: !!turn.unattended });
          if (!local.granted) {
            this.deps.audit?.append({ botId: bot.id, cap: "net:local", action: "browser.goto", args: url, granted: false });
            return { ok: false, output: "❌ 用户未允许访问本机 / 局域网地址" };
          }
        }
      } catch { /* 无效 URL 交给宿主报错 */ }
    }
    return { ok: true };
  }

  /** bot 内部浏览器：open / goto / snapshot / click / type / keys / read / stop */
  private async browserTool(bot: Bot, action: string, args: Record<string, unknown>, turn: TurnCtx): Promise<ToolOutcome> {
    const presence = this.deps.browserPresence;
    if (!presence) return { output: "❌ 内部浏览器未启用。" };
    const url = typeof args.url === "string" ? args.url.trim() : undefined;
    if (action === "open" || action === "goto") {
      if (action === "goto" && !url) return { output: "browser.goto 需要 url" };
      const gate = await this.ensureBrowserConsent(bot, url, turn);
      if (!gate.ok) return { output: gate.output };
      const r = action === "open" ? await presence.open(bot.id, url) : await presence.goto(bot.id, url!);
      this.deps.audit?.append({
        botId: bot.id,
        cap: "browser:open",
        action: `browser.${action}`,
        args: (url ?? "").slice(0, 200),
        granted: true,
        ok: r.ok,
        detail: r.ok ? r.output.slice(0, 200) : r.error.slice(0, 200),
      });
      return { output: r.ok ? r.output : `❌ ${r.error}` };
    }
    if (action === "stop") {
      const r = await presence.stop(bot.id);
      return { output: r.output };
    }
    if (action === "snapshot") {
      const r = await presence.takeSnapshot(bot.id);
      return { output: r.ok ? r.output : `❌ ${r.error}` };
    }
    if (action === "read") {
      const r = await presence.read(bot.id);
      return { output: r.ok ? r.output : `❌ ${r.error}` };
    }
    if (action === "click") {
      const r = await presence.click(bot.id, {
        ref: typeof args.ref === "string" ? args.ref : undefined,
        selector: typeof args.selector === "string" ? args.selector : undefined,
      });
      return { output: r.ok ? r.output : `❌ ${r.error}` };
    }
    if (action === "type") {
      const text = String(args.text ?? args.data ?? "");
      if (!text) return { output: "browser.type 需要 text" };
      const r = await presence.type(bot.id, {
        text,
        ref: typeof args.ref === "string" ? args.ref : undefined,
        selector: typeof args.selector === "string" ? args.selector : undefined,
        submit: args.submit === true || args.submit === "true",
      });
      const redacted = text.includes("{{secret:") || /password|secret|token/i.test(String(args.ref ?? args.selector ?? ""));
      return { output: r.ok ? (redacted ? "已填入（内容已打码）" : r.output) : `❌ ${r.error}` };
    }
    if (action === "fillLogin") {
      const logins = this.deps.logins;
      if (!logins) return { output: "❌ 登录保险库未启用" };
      const gate = await this.ensureBrowserConsent(bot, undefined, turn);
      if (!gate.ok) return { output: gate.output };
      const key = String(args.loginId ?? args.id ?? args.website ?? args.login ?? "").trim();
      if (!key) return { output: "browser.fillLogin 需要 loginId 或 website（先 vault.login.list）" };
      const entry = logins.get(key);
      if (!entry) return { output: `❌ 找不到登录项「${key}」。用 vault.login.list 查看。` };
      const pass = logins.passwordOf(entry.id);
      if (!pass) return { output: `❌ 登录项「${entry.website}」没有可用密码（请用户在 Connect → 登录里替换密码）` };
      const userRef = typeof args.userRef === "string" ? args.userRef : typeof args.usernameRef === "string" ? args.usernameRef : undefined;
      const passRef = typeof args.passRef === "string" ? args.passRef : typeof args.passwordRef === "string" ? args.passwordRef : undefined;
      // 未指定 ref 时先 snapshot，按角色猜用户名/密码框
      let uRef = userRef;
      let pRef = passRef;
      if (!uRef || !pRef) {
        const snap = await presence.takeSnapshot(bot.id);
        if (!snap.ok) return { output: `❌ ${snap.error}` };
        const lines = snap.output.split("\n");
        for (const line of lines) {
          const m = line.match(/^(e\d+)\s+/i);
          if (!m) continue;
          const ref = m[1]!;
          const low = line.toLowerCase();
          if (!pRef && (low.includes("[redacted]") || low.includes("password") || low.includes("密码"))) pRef = ref;
          else if (!uRef && (low.includes("user") || low.includes("email") || low.includes("账号") || low.includes("用户") || low.includes("textbox"))) uRef = ref;
        }
      }
      if (!uRef && !pRef) return { output: "❌ 找不到用户名/密码输入框。先 browser.snapshot，再带 userRef / passRef 调用。" };
      if (uRef) {
        const ur = await presence.type(bot.id, { text: entry.username, ref: uRef });
        if (!ur.ok) return { output: `❌ 填用户名失败：${ur.error}` };
      }
      if (pRef) {
        const pr = await presence.type(bot.id, { text: pass, ref: pRef });
        if (!pr.ok) return { output: `❌ 填密码失败：${pr.error}` };
      }
      this.deps.audit?.append({
        botId: bot.id, cap: "browser:open", action: "browser.fillLogin",
        args: entry.id, granted: true, ok: true, detail: entry.website.slice(0, 120),
      });
      return { output: `已填入登录「${entry.website}」的用户名${pRef ? "和密码" : ""}（密码未展示）。若还需验证码，用 browser.takeover。` };
    }
    if (action === "takeover") {
      const reason = String(args.reason ?? args.why ?? "需要你完成验证码 / SSO / passkey 等敏感步骤").trim();
      const id = `takeover-${Date.now().toString(36)}`;
      return {
        output: `请用户接管浏览器：${reason}。完成后点「我做完了，继续」。`,
        blocks: [{ type: "takeover", id, botId: bot.id, reason }],
        halt: true,
      };
    }
    if (action === "keys") {
      const keys = String(args.keys ?? args.data ?? args.text ?? "").trim();
      if (!keys) return { output: "browser.keys 需要 keys（如 enter / tab / escape）" };
      const r = await presence.keys(bot.id, keys);
      return { output: r.ok ? r.output : `❌ ${r.error}` };
    }
    return { output: "browser 支持 open / goto / snapshot / click / type / fillLogin / takeover / keys / read / stop" };
  }

  /** 终端：open / read / write / keys / stop（cli.term 别名也走这里）。可带 cwd 指定目录。 */
  private async termTool(bot: Bot, args: Record<string, unknown>, turn: TurnCtx): Promise<ToolOutcome> {
    const presence = this.deps.codingPresence;
    if (!presence) return { output: "没有终端能力。" };
    const action = String(args.action ?? "read").trim();
    const wantCwd = args.cwd != null && String(args.cwd).trim() !== "";
    if (action === "open") {
      if (!this.deps.consent) return { output: "❌ 没有授权中心，拒绝打开终端。" };
      const resolved = this.resolveTermCwd(bot, args);
      if ("error" in resolved) return { output: resolved.error };
      const { cwd } = resolved;
      const desc = `打开交互终端（shell）\n目录：${cwd}`;
      const r = await this.deps.consent.requestTermOpen(bot.id, cwd, desc, {
        reasons: [
          "界面会打开终端面板，你和 Bot 看同一块屏幕",
          "该目录会进入工程名单，作为终端槽位 / 派工默认目录",
          "点「总是允许此目录」后，开终端、打字和派 Coding CLI 都不再问",
          "你自己点「打开」不需确认；Bot 第一次打开要确认",
        ],
        unattended: !!turn.unattended,
      });
      if (!r.granted) {
        this.deps.audit?.append({ botId: bot.id, cap: "term:open", action: "term.open", args: cwd, granted: false });
        return { output: "❌ 用户没有批准打开终端" };
      }
      const opened = await presence.openShell(bot.id, cwd, { env: this.terminalEnv(bot, cwd, !!turn.unattended) });
      if ("error" in opened) {
        this.deps.audit?.append({ botId: bot.id, cap: "term:open", action: "term.open", args: cwd, granted: true, ok: false, detail: opened.error.slice(0, 200) });
        return { output: `❌ ${opened.error}` };
      }
      this.deps.audit?.append({ botId: bot.id, cap: "term:open", action: "term.open", args: cwd, granted: true, ok: true, detail: r.viaPathGrant ? "path-grant" : r.remembered ? "remembered" : "once" });
      const nextBot = { ...bot, ...gazeCodingDir(bot, cwd) };
      if (nextBot.agentCwd !== bot.agentCwd || (nextBot.agentDirs ?? []).join("\n") !== (bot.agentDirs ?? []).join("\n")) {
        this.deps.store.saveBot(nextBot);
        this.deps.onAppChanged?.("bots");
      }
      const head = r.viaPathGrant ? "（目录已信任，本次未再弹窗）\n" : r.remembered ? "（已记住此目录可开终端）\n" : "";
      const prog = opened.program?.kind === "agent" ? opened.cli : "shell";
      const note = opened.notice ? `\n${opened.notice}` : "";
      const openedWord = opened.notice ? "已切到现有终端" : "已打开";
      const envNote = this.terminalEnvNote(bot, cwd, !!opened.notice);
      return { output: `${head}【终端】${prog} · ${opened.cwd} · ${openedWord}（界面终端面板已亮起）。人机同屏。改仓库再调 cli.agent。${envNote ? `\n${envNote}` : ""}${note}` };
    }
    let cwd: string | undefined;
    if (wantCwd || action === "stop") {
      const resolved = this.resolveTermCwd(bot, args);
      if ("error" in resolved) {
        if (wantCwd) return { output: resolved.error };
      } else {
        cwd = resolved.cwd;
        presence.focus(bot.id, cwd);
      }
    }
    if (action === "stop") {
      presence.stop(bot.id, "bot 结束了终端", cwd);
      return { output: cwd ? `终端已关掉（${cwd}）。` : "终端已关掉。" };
    }
    if (action === "read") {
      if (cwd) presence.focus(bot.id, cwd);
      const view = presence.snapshot(bot.id);
      if (!view || view.phase === "exited") return { output: "看着的这个目录还没有开着的终端。用 term.open 打开 shell，或 cli.agent 派 Coding CLI。" };
      const screen = presence.screenText(bot.id, view.cwd).trim() || "（屏幕还是空的）";
      const pose = postureSentence(view.posture ?? terminalPosture(screen));
      const prog = view.program?.kind === "agent" ? view.cli : "shell";
      return { output: `【终端屏幕 · ${prog} · ${view.cwd}】\n${pose}\n${screen}` };
    }
    if (action !== "write" && action !== "keys") return { output: "终端 action 是 open、read、write、keys 或 stop。可带 cwd 指定工程目录。" };
    const data = String(args.data ?? args.text ?? "");
    if (!data.trim() && action === "write") return { output: "term.write 需要 data（要打进去的内容）。" };
    if (action === "keys") {
      const decoded = decodeTermKeys(data);
      if ("error" in decoded) return { output: decoded.error };
      const result = await presence.tap(bot.id, decoded.data, cwd);
      return { output: result.output };
    }
    const result = await presence.type(bot.id, data, {
      cwd,
      timeoutMs: Math.min(Math.max(Number(args.timeoutMin ?? 3) * 60_000, 5_000), 20 * 60_000),
      signal: turn.signal,
      onProgress: turn.onToolProgress,
    });
    return { output: result.output };
  }

  private async runSkill(bot: Bot, key: string, args: Record<string, unknown>, originalText: string): Promise<{ output: string }> {
    const skill = this.deps.skills.get(key);
    if (!skill || (skill.owner && skill.owner !== bot.id)) return { output: `技能 ${key} 不存在` };
    if (!this.deps.skills.enabledFor(bot, skill)) return { output: `技能 ${key} 已对本 bot 关闭（详情页技能开关可重新启用）` };
    const body = this.deps.skills.loadBody(key);
    if (!body) return { output: `技能 ${key} 无指令正文` };
    if (this.deps.executor) {
      const lines = body
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /^(?:curl|echo|ls|cat|head|tail|grep|rg|find|pwd|date|whoami|node|bun|python3|git|npm|mkdir|touch|cp|mv|wc|sort|uniq|sed|awk|jq|open|osascript|swift|ps|df|du)/.test(l) && !l.startsWith("#"));
      const results: string[] = [];
      for (const line of lines.slice(0, 5)) {
        const r = await this.deps.executor.run("bash.run", { command: line, botId: bot.id });
        results.push(`$ ${line}\n${r.output.slice(0, 600)}`);
        if (!r.ok) break;
      }
      if (results.length) return { output: results.join("\n\n") };
    }
    return { output: `【技能 ${skill.name} 指令】\n${body}\n\n【用户请求】\n${originalText}\n【参数】\n${JSON.stringify(args)}` };
  }

  /**
   * 回合结束后的记忆兜底：bot 自己调了 memory.add 就不再抽取。
   * 用户明说要记 / 定规范时按规则抽取；回复里声称「记下了」却没存时请模型抽取，保证说记住就真的落盘。
   */
  private async extractMemory(bot: Bot, userText: string | null, reply: string, savedByTool: boolean, autoEvent = false): Promise<MemoryEntry[]> {
    const events: MemoryEntry[] = [];
    const add = (d: MemoryDraft) => events.push(this.deps.memory.add(bot.id, { kind: d.kind, content: d.content, source: "user", namespace: d.scope === "all" ? "global" : undefined }));
    if (userText && !savedByTool) {
      const drafts = memoryFromText(userText);
      if (drafts.length) drafts.forEach(add);
      else if (CLAIMS_SAVED.test(reply)) {
        const ai = await this.memoryWithAI(bot, userText).catch(() => null);
        // 模型判断「没什么要记」（[]）就尊重它；只有模型调用失败时才原样记下，免得说了记住却没存
        (ai ?? [{ kind: "rule" as const, scope: "bot" as const, content: userText.trim().slice(0, 200) }]).forEach(add);
      }
    }
    // G11 工作日志：带日期的 event，便于「上周做了什么」检索（蒸馏仍不进 MEMORY.md）
    if (autoEvent && /完成|搞定|做完了|成功|已发送|已保存|已创建|简报/.test(reply)) {
      const day = new Date().toISOString().slice(0, 10);
      const line = reply.replace(/\s+/g, " ").trim().slice(0, 120);
      const content = `${day} 工作：${line}`;
      const recent = this.deps.memory.list(bot.id).filter((e) => e.kind === "event").slice(-8);
      if (!recent.some((e) => e.content === content || e.content.includes(line.slice(0, 40)))) {
        events.push(this.deps.memory.add(bot.id, { kind: "event", content, source: "auto", tags: ["work-log"] }));
      }
    }
    return events;
  }

  private async memoryWithAI(bot: Bot, userText: string): Promise<MemoryDraft[] | null> {
    const p = this.deps.providers.get(bot.providerId) ?? this.deps.providers.getDefault();
    if (!p) return null;
    const r = await this.deps.providers.complete(p, {
      system: `从用户这句话里提取需要长期记住的内容，只输出 JSON 数组，不要其他文字：
[{"kind":"rule|fact","scope":"bot|all","content":"一句可以长期使用的话"}]
rule = 给当前助手的做事要求、规范、角色分工（例：「你是主控，负责拆解和分派」）→ 默认 scope:bot。
fact = 关于用户本人的稳定信息或偏好（写成「用户……」：姓名、时区、称呼、长期习惯）→ 默认 scope:all（全员共享的少量用户事实）。
用户明说「所有 bot / 大家都」时 rule 也用 all。只是这一次的任务要求、临时截止不要记。登录/密钥/地址不进记忆。没有要记的返回 []。`,
      user: userText.slice(0, 2000),
      signal: AbortSignal.timeout(20_000),
    });
    const raw = r.text.match(/\[[\s\S]*\]/)?.[0];
    if (!raw) return null;
    const arr = JSON.parse(raw) as Partial<MemoryDraft>[];
    return arr
      .filter((x) => x && typeof x.content === "string" && x.content.trim())
      .map((x) => ({ kind: x.kind === "fact" ? "fact" : "rule", scope: x.scope === "all" ? "all" : "bot", content: x.content!.trim().slice(0, 300) }));
  }
}

