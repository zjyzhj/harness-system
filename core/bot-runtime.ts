import { contentText, type Bot, type ChatMessage, type ContentBlock, type MemoryEntry, type MessageMeta, type Provider, type RuntimeResult, type ToolCall, type ToolInvocation } from "./types";
import { fetchPage, PrivateAddressError, webSearch } from "./web-search";
import { editImage, generateImages } from "./image-tool";
import { textTokens } from "./store";
import { ToolRegistry } from "./tool-registry";
import { trimHistoryToBudget } from "./context-budget";
import { OfflinePersona } from "./offline-persona";
import { supportsNativeTools, type CompletionResult, type WireTurn } from "./adapters/openai-compat";
import { looksSecret, normalizeEnvKey } from "./env-store";
import { defaultAvatar } from "./avatar";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { RuntimeDeps, ToolOutcome, RuntimeOptions, TurnCtx } from "./runtime/types";
import { addSource, QUIET_TOOLS, CONTINUE_HINT, THINK_PROMPT, stripToolBlocks, toolBlockCutoff, BOT_ASK_CONCURRENCY, abortable, mapPool, untrusted, thinkingModelOf, needsReasoning, contextWindowOf, historyBudgetOf, turnBudgetOf, shrinkToolResults, looksLikeRule, claimsGroupSend, claimsSkillWrite, parseVerdict, CALL_TOOL, toolRoundEcho, parseToolBlocks } from "./runtime/turn-helpers";
import { memoryLink, appendSkillRules, isDuplicateRule, type MemoryDraft, CLAIMS_SAVED, memoryFromText } from "./runtime/rules-text";
import { runTaskTool, sendFiles, uiTool, ownHistoryText, isSensitivePath } from "./runtime/tool-helpers";
import { PromptBuilder } from "./runtime/prompt";
export * from "./runtime/types";
export * from "./runtime/turn-helpers";
export * from "./runtime/rules-text";
export * from "./runtime/tool-helpers";

/**
 * Bot 运行时 — 真正的智能体循环：
 * 1. 组装上下文：角色 systemPrompt + 持久记忆 + 技能清单
 * 2. 调用 provider（模型生成）
 * 3. 若回复含 ```tool``` 块 → 解析为工具调用 → 执行技能/内置工具 → 回填结果 → 回到步骤 2
 * 4. 生成最终回复，抽取记忆事件（fact/event），返回 RuntimeResult
 *
 * 工具调用用「文本块约定」而不是 model function-calling：
 * 对 OpenAI 兼容 API 和 CLI 适配器都通用，兼容性最好（成熟 CLI bot 常用方案）。
 */
export class BotRuntime {
  private tools = new ToolRegistry();
  private prompt: PromptBuilder;
  constructor(private deps: RuntimeDeps) {
    this.prompt = new PromptBuilder(deps, () => this.tools.prompt());
    this.installTools();
  }

  /**
   * 非流式入口：内部走同一套 handleStream（工具循环 / 记忆 / 富内容），丢弃增量。
   * 定时任务、编排器、旧调用方用这个；面板走 handleStream。
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
      const blocks = turn.sources.length ? [...body, { type: "sources" as const, items: turn.sources }] : body;
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

    const stopped = () => {
      const partial = stripToolBlocks(roundText());
      return finish([...timeline, { type: "text", text: `${partial}${partial ? "\n\n" : ""}（已停止生成）` }, ...attachments], partial);
    };

    const exchange: { role: string; content: string }[] = [];
    /** 同一段工具往来的原生形式（assistant tool_calls + tool 结果），端点支持原生工具时用它 */
    const tail: WireTurn[] = [];
    const failedCalls = new Map<string, string>();
    const canAsk = !!this.deps.askBot && (opts?.depth ?? 0) === 0;
    const mentioned = canAsk && !sessionId.startsWith("group-") ? this.prompt.mentionedBots(bot, text) : [];
    const note = this.prompt.stateNote(bot, mentioned, turnContext);
    let nudgedAsk = false, nudgedGroup = false, nudgedSkill = false;
    let verified = false;
    /** 最近一轮工具往来在 exchange / tail 里的起点：这之后的不截短 */
    let exKeep = 0, tailKeep = 0;
    const turnBudget = turnBudgetOf(window);
    const userForModel: string | ContentBlock[] = typeof userContent === "string" ? `${note}\n\n${userContent}` : [{ type: "text", text: note }, ...userContent];
    for (let round = 0; round < maxRounds; round++) {
      if (opts.signal?.aborted) return stopped();
      roundStart = acc.length;
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
      if (opts.signal?.aborted) return stopped();
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
      if (!tools.length) {
        const faked = !nudgedAsk && canAsk ? this.prompt.fakedDelegation(bot, textReply, toolCalls, mentioned) : null;
        if (faked) {
          nudgedAsk = true;
          retractRoundText();
          const how = native ? "调用 call_tool（tool 填 bot.ask）" : "输出 ```tool 工具块调用 bot.ask";
          const nudge = `[系统检查] 你在回复里说去问了 / 转述了「${faked}」的话，但这一轮没有调用 bot.ask，${faked} 根本没收到消息，界面上那段不实回复已撤回。现在直接用一句话说明你要去问 ${faked}（不要道歉，不要提这次检查），然后${how}，拿到真实回复后再回答用户。`;
          exchange.push({ role: "assistant", content: textReply }, { role: "user", content: nudge });
          tail.push({ role: "assistant", content: textReply }, { role: "user", content: nudge });
          continue;
        }
        if (!nudgedGroup && this.deps.groupPost && claimsGroupSend(textReply) && !toolCalls.some((c) => c.tool === "group.send")) {
          nudgedGroup = true;
          retractRoundText();
          const how = native ? "调用 call_tool（tool 填 group.send）" : "输出 ```tool 工具块调用 group.send";
          const nudge = `[系统检查] 你在回复里说消息已经发到群里了，但这一轮没有调用 group.send，群里根本没有这条消息，界面上那段不实回复已撤回。现在直接${how}（参数 group 填群名，message 填要发的话），拿到工具结果后再告诉用户（不要道歉，不要提这次检查）。`;
          exchange.push({ role: "assistant", content: textReply }, { role: "user", content: nudge });
          tail.push({ role: "assistant", content: textReply }, { role: "user", content: nudge });
          continue;
        }
        const skillSaved = toolCalls.some((c) => c.tool === "skill.save" || c.tool === "skill.update" || c.tool === "skill.delete");
        if (!nudgedSkill && claimsSkillWrite(textReply) && !skillSaved) {
          nudgedSkill = true;
          retractRoundText();
          const how = native ? "调用 call_tool（tool 填 skill.save）" : "输出 ```tool 工具块调用 skill.save";
          const nudge = `[系统检查] 你在回复里说技能已经建好 / 写好了，还可能附了 app:skill/… 链接，但这一轮没有调用 skill.save / skill.update，技能根本没落盘，点开链接会「找不到技能」，界面上那段不实回复已撤回。现在直接${how}（参数 name、description、instructions；私有技能不要加 shared），只用工具结果里的链接告诉用户（不要道歉，不要提这次检查，不要再编造链接）。`;
          exchange.push({ role: "assistant", content: textReply }, { role: "user", content: nudge });
          tail.push({ role: "assistant", content: textReply }, { role: "user", content: nudge });
          continue;
        }
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
        const finalBlocks = r.content?.length ? r.content.filter((b) => b.type !== "tool_call") : [{ type: "text" as const, text: textReply }];
        const meta: MessageMeta = { providerId: provider.id, model: model ?? provider.model, latencyMs: Date.now() - started, tokensUsed: r.usage ? (r.usage.inputTokens ?? 0) + (r.usage.outputTokens ?? 0) : undefined, streamed: true };
        const memCards = await saveTurnMemory(textReply);
        return finish([...timeline, ...finalBlocks, ...memCards, ...attachments], textReply, meta);
      }

      const thought = (r.content ?? []).find((b) => b.type === "thinking");
      if (thought) timeline.push(thought);
      const say = stripToolBlocks(textReply);
      if (say) timeline.push({ type: "text", text: say });

      // 执行工具并回填
      // 同一轮里的多个 bot.ask 并行分派（总耗时取最慢的成员），其余工具按顺序执行
      const results: string[] = [];
      const runOne = async (t: ToolInvocation) => {
        const sig = `${t.tool} ${JSON.stringify(t.args)}`;
        if (failedCalls.has(sig)) {
          return { t, r2: { output: `❌ 这个调用刚才已经失败过（${failedCalls.get(sig)}），重试结果不会变。不要再调用它，换别的办法，或者直接告诉用户做不到以及原因。` } as ToolOutcome };
        }
        if (!QUIET_TOOLS.has(t.tool)) opts.onBlock({ type: "tool_call", tool: t.tool, callId: t.callId, args: t.args, status: "running" });
        const r2 = await this.executeTool(bot, t, text, opts?.depth ?? 0, sessionId, turn);
        if (r2.output.startsWith("❌")) failedCalls.set(sig, r2.output.slice(0, 120));
        return { t, r2 };
      };
      const outcomes = tools.every((t) => t.tool === "bot.ask")
        ? await mapPool(tools, BOT_ASK_CONCURRENCY, runOne)
        : await tools.reduce(async (prev, t) => {
          if (opts.signal?.aborted) return prev;
          return [...(await prev), await runOne(t)];
        }, Promise.resolve([] as { t: ToolInvocation; r2: ToolOutcome }[]));
      if (opts.signal?.aborted) return stopped();
      let halt = false;
      for (const { t, r2 } of outcomes) {
        if (r2.blocks) attachments.push(...r2.blocks);
        if (r2.halt) halt = true;
        results.push(`工具 ${t.tool} 结果：${r2.output}`);
        toolCalls.push({ id: t.callId, tool: t.tool, args: t.args });
        if (t.tool.startsWith("skill:")) usedSkills.push(t.tool.slice(6));
        if (QUIET_TOOLS.has(t.tool)) continue;
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

  /** 记录富消息（用户 + 助手内容块数组 + meta） */
  private recordRich(botId: string, sessionId: string, userText: string | ContentBlock[], blocks: ContentBlock[], meta?: MessageMeta, from = "user", skipUser = false) {
    const kind = from === "user" ? "chat" as const : "bot-to-bot" as const;
    if (!skipUser) this.deps.store.addMessage({ sessionId, from, to: botId, role: "user", content: userText, kind, createdAt: Date.now() });
    this.deps.store.addMessage({ sessionId, from: botId, to: from, role: "assistant", content: blocks, kind, createdAt: Date.now(), meta });
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

  /** 自检：回复发出前用快模型核对完整性和依据，只挑实质问题 */
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
    if (name === CALL_TOOL.name) {
      const tool = String(args.tool ?? args.name ?? "").trim();
      const inner = args.args && typeof args.args === "object" && !Array.isArray(args.args)
        ? args.args as Record<string, unknown>
        : typeof args.args === "string" ? (() => { try { return JSON.parse(args.args as string); } catch { return {}; } })()
        : Object.fromEntries(Object.entries(args).filter(([k]) => k !== "tool" && k !== "name"));
      return { tool, args: inner };
    }
    if (this.tools.has(name)) return { tool: name, args };
    const dotted = name.replace(/__/g, ":").replace(/_/g, ".");
    return { tool: this.tools.has(dotted) ? dotted : name, args };
  }

  /** bot 自己的工作目录（不存在就建） */
  workspaceOf(bot: Bot): string | null {
    return this.prompt.workspaceOf(bot);
  }

  /** 执行工具：先填 {{secret:}}，再交给注册表 */
  private async executeTool(bot: Bot, t: ToolInvocation, originalText: string, depth = 0, sessionId?: string, turn: TurnCtx = { sources: [] }): Promise<ToolOutcome> {
    let used: string[] = [];
    const raw = t.args ?? {};
    let args = raw;
    if (turn.signal?.aborted) return { output: "❌ 用户已停止，这一步没有执行" };
    if (turn.unattended && t.tool.startsWith("ui.")) {
      return { output: "❌ 现在是无人值守的自动执行，没有用户能回答或确认。不要再提问，信息不全就自己做合理假设（在产出开头写明假设），直接完成任务。" };
    }
    // ui.* 需要看到未替换的密钥占位，所以不预填；其它工具执行前替换
    if (!t.tool.startsWith("ui.") && this.deps.secrets && JSON.stringify(args).includes("{{")) {
      // 网址会被对方服务器记录：密钥不能拼进联网请求
      if (t.tool === "web.search" || t.tool === "web.fetch") return { output: "❌ 联网搜索 / 打开网页不能带 {{secret:}} 密钥。需要用密钥调接口时用 bash.run（会请用户确认）" };
      const filled = this.deps.secrets.fill(args, bot.id);
      if (filled.missing.length) return { output: `❌ 密钥未设置或不归你用：${filled.missing.join("、")}。先用 ui.secret 请用户填写` };
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
    return used.length && this.deps.secrets ? { ...out, output: this.deps.secrets.redact(out.output, used) } : out;
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

    R.registerPrefix("ui.", "交互卡片 ui.ask / ui.confirm / ui.secret", (ctx) => ctx.depth > 0
      ? { output: "❌ 你是被别的 bot 转问的，对方不是用户，看不到也点不了卡片。直接做能做的；需要用户选择或确认的事写在回复里，由发起方去问用户。" }
      : uiTool(ctx.tool, ctx.args, this.deps.secrets, ctx.bot.id));
    if (this.deps.groupPost) {
      R.register("group.send", "以你的身份在软件里的群聊发言：消息出现在群聊界面里，群成员会看到并回应（@ 了谁就谁先回，没 @ 就大家都回），工具结果里带回他们的回复。软件内部的群聊不算外部，不需要 ui.confirm。参数: group（群名）, message", async (ctx) => {
        const group = String(ctx.args.group ?? ctx.args.name ?? "").trim();
        const message = String(ctx.args.message ?? ctx.args.text ?? "").trim();
        if (!group || !message) return { output: "❌ 需要 group（群名）和 message" };
        const r = await this.deps.groupPost!(ctx.bot, group, message, turn(ctx).signal);
        if (!r.ok) return { output: `❌ ${r.error}` };
        const link = `[${r.group}](app:group/${encodeURIComponent(r.group)})`;
        const replies = r.replies.length
          ? r.replies.map((x) => `- ${x.name}：${x.text.replace(/```tool[\s\S]*?```/g, "").trim().slice(0, 1500)}`).join("\n")
          : "（没有成员回应）";
        return { output: `已发到群聊 ${link}：${message}\n群成员的回复（${r.reason}）：\n${replies}\n把大家的回复如实转告用户，不要编造没出现的内容。` };
      });
    }
    R.registerPrefix("app.", "查看软件现状 app.state（bot、群聊、定时任务、编排、项目、技能、模型的完整清单）；改自己资料、切模型、建 bot/群", (ctx) => this.appTool(ctx.bot, ctx.tool, ctx.args));
    R.registerPrefix("pet.", "桌宠娱乐工具（status/list/mind/activity/skin/act/say/fx/search/install/generate/show/hide/disable/prefs/evolve/visits/remind/visit/create）。桌宠不代替干活；用户谈桌宠时附手册", (ctx) => this.petTool(ctx.bot, ctx.tool, ctx.args));
    R.registerPrefix("plan.", "编排计划 plan.start（让几个 bot 按阶段接力）/ plan.list / plan.cancel", (ctx) => this.planTool(ctx.bot, ctx.tool, ctx.args, ctx.depth, ctx.sessionId, turn(ctx)));
    R.registerPrefix("skill.", "技能管理 skill.list / skill.get(key) / skill.save(name, description, instructions, key?) / skill.update(key, append?: 新规范数组, replace?: [{find, with}] 改掉冲突的旧规则) / skill.delete(key)", (ctx) => this.appTool(ctx.bot, ctx.tool, ctx.args));

    const builtin = (name: string, desc: string) =>
      R.register(name, desc, (ctx) => this.executeBuiltin(ctx.bot, { callId: "", tool: name, args: ctx.args }, ctx.originalText, ctx.depth, ctx.sessionId, turn(ctx)));

    builtin("fs.read", "读白名单文件。参数: path, offset?");
    builtin("fs.write", "写白名单文件。参数: path, content");
    builtin("fs.list", "列目录。参数: path");
    builtin("bash.run", "在用户电脑上执行 shell 命令；没被允许过的命令会先弹卡片请用户批准，被拒绝就别换写法重试。参数: command");
    builtin("notify", "系统通知。参数: title, body");
    builtin("memory.add", "长期记住一件事（重启后还在，每次对话都会带上）。用户让你记住、给你定规范 / 规矩 / 分工、说「以后都…」「从现在起…」、纠正你的做法、告诉你他的偏好或个人信息时调用。参数: content（写成以后能直接用的一句话）, kind（rule = 对你做事方式的要求；fact = 关于用户的信息或偏好）, bot?（写给哪个 bot，默认你自己；用户说「给飞书机器人也设…」时填对方名字）, scope?（all = 用户要所有 bot 都遵守）。没调用它就不要说「记下了」");
    R.register("env.set", "保存一项普通配置 / 环境变量（接口地址、账号名、项目 ID、区域等，重启后还在，bash.run 自动注入）。密码 / Token 不要用它，用 ui.secret。参数: key（英文大写，如 FEISHU_APP_ID）, value, label?（中文名称）, note?（用途）, scope?（all = 所有 bot 共用，默认只给你）", (ctx) => this.envTool(ctx.bot, "env.set", ctx.args));
    R.register("env.delete", "删除一项配置。参数: key, scope?（all = 共用的那项）", (ctx) => this.envTool(ctx.bot, "env.delete", ctx.args));
    builtin("memory.list", "列出某个 bot 的规范/记忆。参数: bot?（bot 名，默认你自己）, kind?（rule=规范 / fact=事实，默认全部）");
    builtin("memory.search", "按意思检索记忆和过往对话（如「上次聊的那个方案」）。参数: query");
    builtin("memory.update", "改一条已存的记忆 / 规范（用户纠正、规范要改时用，不要再 add 一条相反的）。参数: match（原文里的几个字，用来定位）, content（改成什么）, bot?（改哪个 bot 的，默认你自己）, scope?（all = 全局共享的）");
    builtin("memory.forget", "删掉一条已存的记忆 / 规范（用户说不用再遵守、记错了时用）。参数: match（原文里的几个字）, bot?（删哪个 bot 的，默认你自己）, scope?（all = 全局共享的）");
    builtin("remember", "同 memory.add");
    builtin("bot.list", "列出团队其他 bot");
    builtin("bot.ask", "问另一个 bot。参数: to, message");
    builtin("task.create", "建定时任务。参数: name, prompt, cron|at|in；一次性可设 runPrompt:false 仅宠物闹钟、notifyPet:false 不推宠物");
    builtin("task.list", "列出定时任务");
    builtin("task.delete", "删定时任务。参数: id 或 name");
    for (const n of ["apple.openApp", "apple.activate", "apple.type", "apple.click", "apple.hotkey", "apple.tellApp"]) {
      builtin(n, "控制本机应用（需授权）");
    }
    builtin("screen.screenshot", "截屏（需授权）。参数: rect?");

    if (this.deps.mcpManage) {
      builtin("mcp.list", "列出本软件已接入的 MCP server（名称、工具数、启动命令）。会自动把磁盘 config 与运行时对齐（手改过 config.json 也能补上，不必让用户重启软件）。不要去翻 Claude Desktop 或其他软件的配置路径；也不要说「需要重启」——先调本工具。");
      builtin("mcp.add", "给本软件接入一个 MCP server 并立即热加载（写入配置 + 重连，侧栏 🔌 MCP 会更新，用户不用重启）。禁止用 bash/node 直接改 config.json 的 mcpServers。参数: name（显示名）, command（完整启动命令，如 npx -y mcp-git；或分开填 command+args）, url?（HTTP 端点，与 command 二选一）, id?（英文 id，默认从 name 生成）");
      builtin("mcp.remove", "移除一个已接入的 MCP server（立即热卸载）。参数: id 或 name");
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

  /** bot 改软件本身：自己的人设 / 模型、建 bot、建群、技能增删改 */
  private envTool(bot: Bot, tool: string, args: Record<string, unknown>): ToolOutcome {
    if (!this.deps.env) return { output: "❌ 环境配置未启用" };
    const key = normalizeEnvKey(String(args.key ?? args.name ?? ""));
    if (!key) return { output: `❌ ${tool} 需要 key` };
    const shared = args.scope === "all" || args.scope === "global";
    const link = "[环境配置](app:settings/env)";
    if (tool === "env.delete") {
      const ok = this.deps.env.remove(key, shared ? undefined : bot.id);
      if (ok) this.deps.audit?.append({ botId: bot.id, cap: "config", action: "env.delete", args: key, granted: true, ok: true, detail: shared ? "共用" : "私有" });
      return { output: ok ? `已删除配置 ${key}\n查看：${link}` : `❌ 没有${shared ? "共用的" : "你的"}配置 ${key}` };
    }
    const value = String(args.value ?? "").trim();
    if (!value) return { output: "❌ env.set 需要 value" };
    if (looksSecret(key, value)) return { output: `❌ ${key} 看起来是密码 / Token，不能明文保存。改用 ui.secret（name: ${key}）让用户在加密输入框里填写` };
    const e = this.deps.env.set({ key, value, label: args.label ? String(args.label) : undefined, note: args.note ? String(args.note) : undefined, botId: shared ? undefined : bot.id, updatedBy: bot.id });
    this.deps.audit?.append({ botId: bot.id, cap: "config", action: "env.set", args: `${e.key}=${e.value}`, granted: true, ok: true, detail: shared ? "共用" : "私有" });
    return { output: `已保存配置 ${e.key}=${e.value}${shared ? "（所有 bot 共用）" : ""}，之后 bash.run 里可以直接用 $${e.key}\n查看 / 修改：${link}` };
  }

  /** 共享技能会影响所有 bot，写之前请用户确认（没有授权中心时，如测试环境，直接放行） */
  private async sharedSkillConsent(bot: Bot, desc: string): Promise<boolean> {
    if (!this.deps.consent) return true;
    return (await this.deps.consent.request(bot.id, "skill:shared", desc)).granted;
  }

  private async planTool(bot: Bot, tool: string, args: Record<string, unknown>, depth: number, sessionId: string | undefined, turn: TurnCtx): Promise<ToolOutcome> {
    const plans = this.deps.plans;
    if (!plans) return { output: "编排未启用" };
    const link = "[编排](app:settings/plans)";
    if (tool === "plan.list") {
      const all = plans.list();
      return { output: all.length ? all.slice(0, 15).map((p) => `- ${p.title}（${({ done: "已完成", error: "失败", running: "进行中", pending: "未开始" } as Record<string, string>)[p.status] ?? p.status}）${p.result ? `：${p.result.slice(0, 80)}` : ""}`).join("\n") + `\n完整记录：${link}` : `还没有编排计划。查看：${link}` };
    }
    if (tool === "plan.cancel") {
      const hit = plans.cancel(String(args.plan ?? args.title ?? args.id ?? "").trim());
      this.deps.onAppChanged?.("plans");
      return { output: hit ? `已停止编排「${hit}」` : "❌ 没有找到正在运行的这个编排" };
    }
    if (tool !== "plan.start") return { output: `未知工具 ${tool}` };
    if (depth > 0 || turn.unattended) return { output: "❌ 自动执行或被其他 bot 调用时不能再发起编排，直接完成你这一步。" };
    const stages = Array.isArray(args.stages) ? (args.stages as Array<Record<string, unknown>>).map((x) => ({ bot: String(x.bot ?? x.to ?? "").trim(), prompt: String(x.prompt ?? x.task ?? "").trim(), mode: x.mode === "fan" ? "fan" : "seq" })) : undefined;
    const task = String(args.task ?? args.text ?? "").trim();
    if (!stages?.length && !task) return { output: "plan.start 需要 task（一句话：谁做什么，按顺序）或 stages（[{bot, prompt, mode?}]）" };
    try {
      const r = await plans.start({ requester: bot, sessionId, task: task || undefined, title: [args.title, args.goal, args.name].find((x) => typeof x === "string" && x.trim()) as string | undefined, stages });
      this.deps.onAppChanged?.("plans");
      return { output: `已开始编排「${r.title}」，在后台运行：\n${r.steps.map((x, i) => `${i + 1}. ${x}`).join("\n")}\n跑完会把结果发回这个会话；进度在 ${link} 里实时可见。告诉用户已经开始了，不要等结果，也不要编造结果。` };
    } catch (e) {
      return { output: `❌ 发起编排失败：${e instanceof Error ? e.message : String(e)}` };
    }
  }

  private async petTool(bot: Bot, tool: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const host = this.deps.petHost;
    if (!host) return { output: "❌ 桌宠宿主未就绪" };
    const store = this.deps.store;
    const str = (k: string) => (args[k] === undefined || args[k] === null ? undefined : String(args[k]).trim());
    const find = (q: string) => {
      const all = store.listBots();
      return all.find((b) => b.name === q) ?? all.find((b) => b.id === q) ?? all.find((b) => b.name.includes(q) || q.includes(b.name));
    };
    const isSelfQuery = (q?: string) => !q || q === "me" || q === "自己" || q === bot.name || q === bot.id;
    const describe = (b: Bot) => {
      const skin = host.skinLabel(b.id);
      const shown = host.isShown?.(b.id);
      const xp = host.xp?.(b.id) ?? 0;
      const level = Math.floor(Math.sqrt(xp / 100)) + 1;
      const stage = !b.petEnabled ? "未上台" : shown === false ? "已上台但藏着" : shown === true ? "桌面可见" : (b.petEnabled ? "已上台" : "未上台");
      return `${b.name}：${stage}；形象「${skin}」；Lv.${level}（${xp} XP）`;
    };
    switch (tool) {
      case "pet.list": {
        // 全员桌宠一览（含未上台）；all=true 时列出全部 bot，否则默认只列已上台 + 自己
        const all = args.all === true || args.all === 1 || String(args.all ?? "") === "true";
        const bots = store.listBots();
        const rows = all
          ? bots
          : bots.filter((b) => b.petEnabled || b.id === bot.id);
        if (!rows.length) return { output: "还没有桌宠。用户可在 bot 详情打开「桌面宠物」，或对我说「出来」。" };
        const on = rows.filter((b) => b.petEnabled).length;
        return {
          output: [
            `【桌宠 ${on}/${bots.length} 上台】` + (all ? "（含未上台）" : "（仅上台+自己；要全员加 all:true）"),
            ...rows.map((b) => `- ${describe(b)}${b.id === bot.id ? "（你）" : ""}`),
          ].join("\n"),
        };
      }
      case "pet.status": {
        const q = str("name") ?? str("bot");
        if (q && !isSelfQuery(q)) {
          const target = find(q);
          if (!target) return { output: `找不到「${q}」` };
          return { output: describe(target) };
        }
        const peers = store.listBots().filter((b) => b.id !== bot.id && b.petEnabled);
        const lines = [describe(store.getBot(bot.id) || bot)];
        if (peers.length) lines.push(`其他上台：${peers.map((p) => p.name).join("、")}`);
        else lines.push("其他上台：无");
        const prefs = host.prefs?.(bot.id);
        if (prefs) {
          const on = (k: string, label: string) => prefs[k] ? label : null;
          const flags = [
            on("companionChat", "空闲搭话"), on("proactiveFollowup", "主动跟进"),
            on("idleWork", "空闲做事"), on("autoAppearance", "自动换装"),
            on("agentMaySpawn", "可召唤伙伴"), on("selfEvolve", "自进化"),
            on("petVisit", "互访"),
          ].filter(Boolean);
          lines.push(`智能开关：${flags.length ? flags.join("、") : "全关（仅基础桌宠）"}`);
        }
        const pending = host.evolveList?.(bot.id, "pending") ?? [];
        if (pending.length) lines.push(`待确认进化 ${pending.length} 条（pet.evolve action=list）`);
        lines.push("完整名单用 pet.list；只要上台伙伴用 pet.peers。");
        return { output: lines.join("\n") };
      }
      case "pet.peers": {
        const peers = store.listBots().filter((b) => b.id !== bot.id && b.petEnabled);
        if (!peers.length) return { output: "还没有其他上台的桌宠。" };
        return { output: peers.map((p) => describe(p)).join("\n") };
      }
      case "pet.skin": {
        const want = str("skin") ?? str("name") ?? str("id");
        const skins = host.listSkins?.() ?? [];
        if (want === "prev" || want === "revert" || want === "换回去" || want === "上一套" || args.revert === true) {
          if (!host.revertSkin) return { output: "❌ 换回未就绪" };
          const r = host.revertSkin(bot.id);
          if (!r.ok) return { output: `❌ ${r.error}` };
          this.deps.onAppChanged?.("bots");
          return { output: `已换回「${r.label}」` };
        }
        if (!want || want === "list" || want === "列表") {
          if (!skins.length) return { output: "本地还没有形象。用 pet.search 搜社区库，再 pet.install 下载。" };
          const cur = host.skinLabel(bot.id);
          return { output: `当前「${cur}」。本地已装：\n${skins.map((s) => `- ${s.name}（${s.id}）`).join("\n")}\n没有想要的可用 pet.search / pet.install 从 petdex 下载；换回去用 skin=prev。` };
        }
        if (!host.setSkin) return { output: "❌ 换装未就绪" };
        const hit = skins.find((s) => s.id === want || s.name === want)
          ?? skins.find((s) => s.name.includes(want) || want.includes(s.name));
        if (!hit) {
          // 本地没有 → 引导搜库 / 直接尝试安装
          if (host.installCatalog) {
            const inst = await host.installCatalog(want, { wearBotId: bot.id });
            if (inst.ok) {
              this.deps.onAppChanged?.("bots");
              return { output: `本地没有「${want}」，已从 petdex 下载「${inst.label}」并换上（已加入形象列表）。` };
            }
            return { output: `本地没有「${want}」。${inst.error} 可先 pet.search query="${want}" 看看有没有近似的。` };
          }
          return { output: `找不到形象「${want}」。先 pet.skin 看本地列表，或 pet.search / pet.install 从社区下载。` };
        }
        // 默认只给自己换；给别人换装等同「操作他人桌宠」，需召唤开关
        const whoQ = str("bot") ?? str("to");
        let target = bot;
        if (whoQ && !isSelfQuery(whoQ)) {
          if (!host.maySpawn()) return { output: "❌ 给其他桌宠换装需要打开「允许召唤/创建桌宠」" };
          const t = find(whoQ);
          if (!t) return { output: `找不到「${whoQ}」` };
          target = t;
        }
        const r = host.setSkin(target.id, hit.id);
        if (!r.ok) return { output: `❌ ${r.error}` };
        this.deps.onAppChanged?.("bots");
        return { output: `已为 ${target.name} 换上「${r.label}」` };
      }
      case "pet.search": {
        if (!host.searchCatalog) return { output: "❌ 形象库搜索未就绪" };
        const q = str("query") ?? str("q") ?? str("name") ?? str("skin") ?? "";
        const rows = await host.searchCatalog(q);
        if (!rows.length) return { output: q ? `没搜到「${q}」。换个关键词，或去 petdex.dev 看看。` : "推荐列表为空。" };
        const head = q ? `搜「${q}」：` : "推荐形象：";
        return {
          output: [
            head,
            ...rows.map((r) => `- ${r.name}（slug: ${r.slug}${r.installed ? "，已安装" : ""}）`),
            "下载并加入列表：pet.install slug=…（默认换到自己身上；只要入库设 wear:false）",
          ].join("\n"),
        };
      }
      case "pet.install": {
        if (!host.installCatalog) return { output: "❌ 形象下载未就绪" };
        const slug = str("slug") ?? str("skin") ?? str("name") ?? str("query") ?? "";
        if (!slug) return { output: "pet.install 需要 slug 或 name（可先 pet.search）" };
        const wearRaw = args.wear;
        const wear = wearRaw === false || wearRaw === "false" || wearRaw === 0 ? false : true;
        const r = await host.installCatalog(slug, { name: str("label") ?? str("displayName"), wearBotId: wear ? bot.id : undefined });
        if (!r.ok) return { output: `❌ ${r.error}` };
        this.deps.onAppChanged?.("bots");
        return {
          output: r.worn
            ? `已下载「${r.label}」加入形象列表，并换到自己身上。`
            : `已下载「${r.label}」加入形象列表（未换装；要穿上用 pet.skin skin="${r.label}"）。`,
        };
      }
      case "pet.show": {
        const q = str("name") ?? str("bot");
        // 自己出台 = 基础能力，不需要「允许召唤」
        if (isSelfQuery(q)) {
          const me = store.getBot(bot.id) || bot;
          store.saveBot({ ...me, petEnabled: true });
          host.show(me.id);
          this.deps.onAppChanged?.("bots");
          return { output: "我已出台到桌面。" };
        }
        if (!host.maySpawn()) return { output: "❌ 用户已关闭「允许召唤/创建桌宠」；我只能操作自己的桌宠。" };
        const target = find(q!);
        if (!target) return { output: `找不到「${q}」。现有：${store.listBots().map((b) => b.name).join("、")}` };
        store.saveBot({ ...target, petEnabled: true });
        host.show(target.id);
        this.deps.onAppChanged?.("bots");
        return { output: `已让 [${target.name}](app:bot/${encodeURIComponent(target.name)}) 出台桌宠` };
      }
      case "pet.hide": {
        const q = str("name") ?? str("bot");
        if (isSelfQuery(q)) {
          host.hide(bot.id);
          return { output: "已暂时藏起自己（没有关掉桌宠，托盘「全部显示」可回来）" };
        }
        if (!host.maySpawn()) return { output: "❌ 藏起其他桌宠需要打开「允许召唤/创建桌宠」" };
        const target = find(q!);
        if (!target) return { output: `找不到「${q}」` };
        host.hide(target.id);
        return { output: `已暂时藏起 ${target.name}` };
      }
      case "pet.disable": {
        if (!host.disable) return { output: "❌ 下台未就绪" };
        const q = str("name") ?? str("bot");
        if (!isSelfQuery(q)) {
          if (!host.maySpawn()) return { output: "❌ 关掉其他桌宠需要打开「允许召唤/创建桌宠」" };
          const target = find(q!);
          if (!target) return { output: `找不到「${q}」` };
          host.disable(target.id);
          this.deps.onAppChanged?.("bots");
          return { output: `已关闭 ${target.name} 的桌宠（彻底下台，不是藏起来）` };
        }
        host.disable(bot.id);
        this.deps.onAppChanged?.("bots");
        return { output: "已关闭自己的桌宠（彻底下台）。要再出台用 pet.show。" };
      }
      case "pet.generate": {
        if (!host.generatePersona) return { output: "❌ 形象生成未就绪" };
        const desc = str("desc") ?? str("prompt") ?? str("text") ?? "";
        if (!desc) return { output: "pet.generate 需要 desc（一句话描述，如「戴耳机的橘猫」）" };
        const r = await host.generatePersona(bot.id, desc, str("style") ?? undefined);
        if (!r.ok) return { output: `❌ ${r.error}` };
        this.deps.onAppChanged?.("bots");
        // 诚实回报：有图 / 换了皮 / 只改了卡；绝不假装「画出来了」
        const extra = r.suggestions?.length
          ? `\n其它可选项：${r.suggestions.map((s) => `${s.name}(${s.kind})`).join("、")}`
          : "";
        return { output: `${r.message}${extra}` };
      }
      case "pet.prefs": {
        const action = (str("action") ?? str("op") ?? "get").toLowerCase();
        if (action === "get" || action === "list" || action === "read") {
          const p = host.prefs?.(bot.id);
          if (!p) return { output: "❌ 偏好未就绪" };
          const line = (k: string, label: string) => `- ${label}：${p[k] ? "开" : "关"}`;
          return {
            output: [
              "【对本宠生效的智能偏好】（全局默认 ⊕ 单宠覆盖）",
              line("companionChat", "空闲搭话"),
              line("proactiveFollowup", "主动跟进"),
              line("idleWork", "空闲做事"),
              line("autoAppearance", "自动换装"),
              line("agentMaySpawn", "允许召唤伙伴"),
              line("selfEvolve", "自进化提议"),
              line("autoEvolve", "自动接受进化"),
              line("petVisit", "多宠互访"),
              `节奏：空闲 ${p.idleMinutes} 分钟才开口；每天最多搭话 ${p.maxChatPerDay} / 做事 ${p.maxWorkPerDay}；每周自动换装 ${p.maxAppearPerWeek}`,
              "改自己节奏：pet.prefs action=set companionChat=false（只影响你）；进阶总开关请用户去设置页开。",
            ].join("\n"),
          };
        }
        if (action === "set" || action === "patch") {
          if (!host.setPrefs) return { output: "❌ 偏好写入未就绪" };
          const patch: Record<string, unknown> = {};
          const boolKeys = ["companionChat", "proactiveFollowup", "idleWork", "autoAppearance", "agentMaySpawn", "selfEvolve", "autoEvolve", "petVisit"] as const;
          for (const k of boolKeys) {
            if (args[k] === undefined) continue;
            patch[k] = args[k] === true || args[k] === "true" || args[k] === 1;
          }
          for (const k of ["idleMinutes", "maxChatPerDay", "maxWorkPerDay", "maxAppearPerWeek"] as const) {
            if (args[k] === undefined) continue;
            const n = Number(args[k]);
            if (Number.isFinite(n)) patch[k] = n;
          }
          if (!Object.keys(patch).length) return { output: "没有可写的字段。例：companionChat=false 或 idleMinutes=60" };
          // 进阶总闸门：bot 只允许改节奏类；开关类里 companion/idle/appear 可以，spawn/visit/evolve 建议用户去设置
          const locked = ["agentMaySpawn", "selfEvolve", "autoEvolve", "petVisit"].filter((k) => k in patch);
          for (const k of locked) delete patch[k];
          if (!Object.keys(patch).length) {
            return { output: "召唤/互访/自进化请用户在「桌面宠物智能」里开；我只能改自己的搭话/做事/换装节奏。" };
          }
          host.setPrefs(bot.id, patch);
          return { output: `已更新本宠偏好：${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join("、")}` };
        }
        return { output: "pet.prefs action 用 get 或 set" };
      }
      case "pet.evolve": {
        if (!host.evolveList || !host.evolveDecide) return { output: "❌ 进化未就绪" };
        const action = (str("action") ?? str("op") ?? "list").toLowerCase();
        if (action === "list" || action === "pending") {
          const rows = host.evolveList(bot.id, "pending");
          if (!rows.length) return { output: "没有待确认的进化提议。" };
          return {
            output: [
              "【待确认进化】",
              ...rows.map((r) => `- ${r.title}（${r.kind}，id=${r.id.slice(0, 8)}）\n  ${r.detail.slice(0, 100)}`),
              "接受：pet.evolve action=accept；拒绝：action=reject（可带 id）",
            ].join("\n"),
          };
        }
        if (action === "history" || action === "log") {
          const rows = host.evolveList(bot.id, "history");
          if (!rows.length) return { output: "还没有进化记录。" };
          const label: Record<string, string> = { pending: "待确认", accepted: "已接受", rejected: "已拒绝" };
          return {
            output: [
              "【进化历史】",
              ...rows.slice(0, 15).map((r) => `- [${label[r.status] || r.status}] ${r.title}`),
            ].join("\n"),
          };
        }
        if (action === "accept" || action === "reject") {
          const r = host.evolveDecide(bot.id, action, str("id") ?? undefined);
          if (!r.ok) return { output: `❌ ${r.error}` };
          this.deps.onAppChanged?.("bots");
          return { output: action === "accept" ? `已接受：${r.title}` : `已拒绝：${r.title}` };
        }
        return { output: "pet.evolve action 用 list / history / accept / reject" };
      }
      case "pet.visits": {
        if (!host.visitHistory) return { output: "❌ 拜访记录未就绪" };
        const rows = host.visitHistory(bot.id, 15);
        if (!rows.length) return { output: "还没有拜访记录。" };
        return {
          output: rows.map((r) => {
            const mine = r.fromId === bot.id;
            const when = new Date(r.at).toLocaleString();
            return `- ${mine ? "去找" : "来访"} ${mine ? r.toName : r.fromName}（${when}）：${mine ? r.lineFrom : r.lineTo}`;
          }).join("\n"),
        };
      }
      case "pet.remind": {
        if (!host.remind) return { output: "❌ 提醒未就绪" };
        const text = str("text") ?? str("message") ?? str("prompt") ?? "提醒";
        let delayMs = Number(args.delayMs ?? args.ms ?? 0);
        if (!delayMs) {
          const inn = str("in");
          if (inn) {
            const m = inn.match(/^(\d+)\s*(m|min|分钟|h|小时|s|秒)?$/i);
            if (m) {
              const n = Number(m[1]);
              const u = (m[2] || "m").toLowerCase();
              delayMs = /h|小时/.test(u) ? n * 3600_000 : /s|秒/.test(u) ? n * 1000 : n * 60_000;
            }
          }
        }
        if (!delayMs && args.minutes != null) delayMs = Number(args.minutes) * 60_000;
        if (!delayMs || delayMs < 5000) return { output: "pet.remind 需要 in（如 30m）或 minutes / delayMs，且至少 5 秒" };
        const r = host.remind(bot.id, delayMs, text);
        if (!r.ok) return { output: `❌ ${r.error}` };
        const mins = Math.round(delayMs / 60_000);
        return { output: `好，大约 ${mins < 1 ? "不到 1 分钟" : mins + " 分钟"}后我会在桌面提醒你：${text}` };
      }
      case "pet.create": {
        if (!host.maySpawn()) return { output: "❌ 用户已关闭「允许召唤/创建桌宠」" };
        const name = str("name");
        if (!name) return { output: "pet.create 需要 name" };
        if (store.listBots().some((b) => b.name === name)) {
          const existing = store.listBots().find((b) => b.name === name)!;
          store.saveBot({ ...existing, petEnabled: true });
          host.show(existing.id);
          this.deps.onAppChanged?.("bots");
          return { output: `已有叫「${name}」的 bot，已帮它出台` };
        }
        const id = `bot-${Date.now().toString(36)}`;
        const nb: Bot = {
          id, name,
          role: str("role") ?? "桌宠伙伴",
          persona: str("persona") ?? "友好、会陪伴用户",
          providerId: bot.providerId || "",
          petEnabled: true,
          avatar: defaultAvatar(id),
          createdAt: Date.now(),
        };
        store.saveBot(nb);
        host.show(id);
        this.deps.onAppChanged?.("bots");
        return { output: `已创建桌宠 [${name}](app:bot/${encodeURIComponent(name)}) 并出台` };
      }
      case "pet.visit": {
        if (host.mayVisit && !host.mayVisit()) return { output: "❌ 用户已关闭「多宠互访」" };
        if (!host.visit) return { output: "❌ 互访未就绪" };
        const q = str("name") ?? str("to") ?? str("bot") ?? "";
        if (!q) return { output: "pet.visit 需要 name（要去拜访的伙伴）" };
        const target = find(q);
        if (!target) return { output: `找不到「${q}」` };
        if (!target.petEnabled) {
          if (!host.maySpawn()) return { output: `「${target.name}」还没上台，且不允许自动召唤` };
          store.saveBot({ ...target, petEnabled: true });
          host.show(target.id);
        }
        // 自己也要上台才能串门
        const me = store.getBot(bot.id) || bot;
        if (!me.petEnabled) {
          store.saveBot({ ...me, petEnabled: true });
          host.show(me.id);
          this.deps.onAppChanged?.("bots");
        }
        const r = await host.visit(bot.id, target.id);
        return { output: r.ok ? r.line : `❌ ${r.error}` };
      }
      case "pet.mind": {
        if (!host.mind) return { output: "❌ 心智投影未就绪" };
        const q = str("name") ?? str("bot");
        const target = q && !isSelfQuery(q) ? find(q) : bot;
        if (!target) return { output: `找不到「${q}」` };
        const r = host.mind(target.id);
        if (!r.ok) return { output: `❌ ${r.error}` };
        return { output: `【桌宠心智 · 娱乐只读】\n${r.prompt}` };
      }
      case "pet.activity": {
        if (!host.activity) return { output: "❌ 活动日志未就绪" };
        const q = str("name") ?? str("bot");
        const targetId = q && !isSelfQuery(q) ? find(q)?.id : bot.id;
        const rows = host.activity(targetId, args.limit != null ? Number(args.limit) : 12);
        if (!rows.length) return { output: "还没有桌宠自主行动记录（娱乐向；开智能开关后才会有）。" };
        return {
          output: [
            "【桌宠活动 · 娱乐】",
            ...rows.map((a) => `- ${new Date(a.at).toLocaleString()} · ${a.via} · ${a.kind}${a.blocked ? "（未执行）" : ""}：${a.note}`),
          ].join("\n"),
        };
      }
      case "pet.act": {
        if (!host.act) return { output: "❌ 动作未就绪" };
        const action = (str("action") ?? str("act") ?? str("motion") ?? "").toLowerCase();
        if (!action) return { output: "pet.act 需要 action（idle/walk/jump/sleep/celebrate/work/think）；这是娱乐表演，不代替真正干活" };
        const hold = args.hold != null ? Number(args.hold) : args.seconds != null ? Number(args.seconds) : undefined;
        const r = host.act(bot.id, action, Number.isFinite(hold) ? hold : undefined);
        return { output: r.ok ? `已做娱乐动作：${r.action}` : `❌ ${r.error}` };
      }
      case "pet.say": {
        if (!host.say) return { output: "❌ 气泡说话未就绪" };
        const text = str("text") ?? str("message") ?? str("line") ?? "";
        if (!text) return { output: "pet.say 需要 text" };
        const r = host.say(bot.id, text, {
          title: str("title"),
          action: str("action") ?? undefined,
          holdSec: args.hold != null ? Number(args.hold) : undefined,
        });
        return { output: r.ok ? `已冒泡：${text.slice(0, 40)}` : `❌ ${r.error}` };
      }
      case "pet.fx": {
        if (!host.fx) return { output: "❌ 特效未就绪" };
        const action = (str("action") ?? str("op") ?? "play").toLowerCase();
        const r = await host.fx(bot.id, {
          action,
          phrase: str("phrase") ?? str("text") ?? str("fx") ?? undefined,
          name: str("name") ?? undefined,
          sticky: args.sticky === true || args.sticky === "true",
        });
        if (!r.ok) return { output: `❌ ${r.error}` };
        if (r.list?.length) {
          return {
            output: [
              r.message,
              ...r.list.slice(0, 20).map((e) => `- ${e.name}（${e.kind}${e.sticky ? ",钉住" : ""} · 用过${e.useCount}次）`),
            ].join("\n"),
          };
        }
        return { output: r.message };
      }
      default:
        return { output: `未知工具 ${tool}` };
    }
  }

  private async appTool(bot: Bot, tool: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const store = this.deps.store;
    const str = (k: string) => (args[k] === undefined || args[k] === null ? undefined : String(args[k]).trim());
    const changed = (what: string, output: string) => { this.deps.onAppChanged?.(what); return { output }; };
    switch (tool) {
      case "app.updateSelf": {
        const patch: Partial<Bot> = {};
        for (const k of ["name", "role", "persona", "systemPrompt"] as const) if (str(k)) patch[k] = str(k)!;
        if (!Object.keys(patch).length) return { output: "app.updateSelf 需要 name / role / persona / systemPrompt 之一" };
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
        const wantPet = args.pet === true || args.asPet === true || /^(1|true|yes|上台|桌宠)$/i.test(String(args.pet ?? ""));
        if (wantPet && this.deps.petHost && !this.deps.petHost.maySpawn()) {
          return { output: "❌ 用户已关闭「允许召唤/创建桌宠」。可先建 bot（不要带 pet），让用户自己在详情里打开桌宠。" };
        }
        const id = `bot-${Date.now().toString(36)}`;
        const nb: Bot = {
          id, name,
          role: str("role") ?? "通用助手",
          persona: str("persona") ?? "",
          providerId: "",
          petEnabled: wantPet,
          avatar: defaultAvatar(id),
          createdAt: Date.now(),
        };
        store.saveBot(nb);
        if (wantPet) this.deps.petHost?.show(id);
        return changed("bots", `已创建 bot [${name}](app:bot/${encodeURIComponent(name)})${wantPet ? "，并已出台为桌宠" : ""}`);
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
        this.deps.groups.create(name, bot.id, [...new Set(ids)]);
        return changed("groups", `已创建群聊「${name}」，成员：${[...new Set(ids)].map((id) => bots.find((b) => b.id === id)?.name).join("、")}`);
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
        groups.update(g.id, { members, ...(rename ? { name: rename } : {}) });
        const label = rename || g.name;
        return changed("groups", `已更新群聊 [${label}](app:group/${encodeURIComponent(label)})，现在的成员：${members.map((id) => bots.find((b) => b.id === id)?.name ?? id).join("、")}`);
      }
      case "skill.list":
        return { output: this.deps.skills.visibleTo(bot.id).map((x) => `- ${x.key}：${x.name}（${x.owner ? "私有" : "共享"}${x.enabled ? "" : "，已停用"}）${x.description}`).join("\n") || "（还没有技能）" };
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
      const r = await this.deps.mcpManage.add({ id: idHint || undefined, name, command, args: cmdArgs, url: url || undefined });
      this.deps.onAppChanged?.("mcp");
      if (r.error) return { output: `已写入配置，但连接失败：${r.error}\nid=${r.id}。检查命令后可用 mcp.remove 删掉重装。查看：[MCP 工具](app:settings/mcp)` };
      return { output: `已接入 MCP「${r.name}」（id=${r.id}），发现 ${r.tools} 个工具，立刻可用。调用示例：mcp:${r.id}/<工具名>。查看：[MCP 工具](app:settings/mcp)` };
    }
    if (t.tool === "task.create" || t.tool === "task.list" || t.tool === "task.delete") {
      if (!this.deps.tasks) return { output: "定时任务未启用" };
      // 增删走 Scheduler.onChange → app:changed，右栏定时任务列表会跟着刷
      const output = runTaskTool(this.deps.tasks, bot, t.tool, args, sessionId);
      if (t.tool !== "task.create" || !output.startsWith("已创建") || !this.deps.notifyCheck) return { output };
      const ok = await this.deps.notifyCheck("⏰ 提醒已设好", output.replace(/^已创建(一次性|周期)任务/, "").slice(0, 80));
      return { output: ok ? output : `${output}\n⚠️ 系统通知现在弹不出来（macOS 没给本软件通知权限）。到点时提醒会发到这个聊天里。告诉用户这一点，并原样附上这个可点的链接让用户一键去开启：[去开启通知](app:settings/notifications)` };
    }
    if (t.tool === "bot.list") {
      return { output: this.prompt.teamRoster(bot) || "（暂无其他 bot）" };
    }
    if (t.tool === "bot.ask") {
      if (!this.deps.askBot) return { output: "bot 间通信未启用" };
      if (depth >= 1) return { output: "你正在代答其他 bot 的提问，不能再转问别的 bot，请直接回答。" };
      const target = String(args.to ?? args.bot ?? args.name ?? "");
      const message = String(args.message ?? args.text ?? args.question ?? "");
      if (!target || !message) return { output: "bot.ask 需要 to（bot 名）和 message" };
      try {
        return { output: await this.deps.askBot(bot, target, message, depth + 1, sessionId, turn?.signal) };
      } catch (e) {
        return { output: `❌ 询问 ${target} 失败：${e instanceof Error ? e.message : String(e)}` };
      }
    }
    if (["fs.read", "fs.write", "fs.list", "bash.run", "web.fetch", "notify"].includes(t.tool)) {
      if (!this.deps.executor) return { output: `工具 ${t.tool} 未启用（executor 未注入）` };
      const r = await this.deps.executor.run(t.tool, {
        ...args, botId: bot.id,
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
    return { output: `未知工具 ${t.tool}` };
  }

  private async runSkill(bot: Bot, key: string, args: Record<string, unknown>, originalText: string): Promise<{ output: string }> {
    const skill = this.deps.skills.get(key);
    if (!skill || (skill.owner && skill.owner !== bot.id)) return { output: `技能 ${key} 不存在` };
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
    if (autoEvent && /完成|搞定|做完了|成功/.test(reply)) {
      events.push(this.deps.memory.add(bot.id, { kind: "event", content: `${new Date().toISOString()} ${reply.slice(0, 80)}`, source: "auto" }));
    }
    return events;
  }

  private async memoryWithAI(bot: Bot, userText: string): Promise<MemoryDraft[] | null> {
    const p = this.deps.providers.get(bot.providerId) ?? this.deps.providers.getDefault();
    if (!p) return null;
    const r = await this.deps.providers.complete(p, {
      system: `从用户这句话里提取需要长期记住的内容，只输出 JSON 数组，不要其他文字：
[{"kind":"rule|fact","scope":"bot|all","content":"一句可以长期使用的话"}]
rule = 用户给助手定的做事要求、规范、角色分工（例如「你是主控，负责拆解和分派任务」）；fact = 关于用户本人的信息或偏好（写成「用户……」）。
scope：用户说让所有助手 / 大家都遵守时为 all，否则为 bot。只是这一次的任务要求不要记。没有要记的返回 []。`,
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

