import { contentText, type Bot, type ChatMessage, type ContentBlock, type MemoryEntry, type MessageMeta, type RuntimeResult, type ToolCall, type ToolInvocation } from "./types";
import type { Store } from "./store";
import type { ProviderCenter } from "./provider-center";
import type { MemorySystem } from "./memory-system";
import type { SkillRegistry } from "./skill-registry";
import type { SystemKit } from "./system-kit";
import { ToolExecutor, BUILTIN_TOOL_DESCRIPTIONS } from "./tool-executor";
import { trimHistoryToBudget } from "./context-budget";
import { OfflinePersona } from "./offline-persona";
import type { McpClient } from "./mcp-client";

export interface RuntimeDeps {
  store: Store;
  providers: ProviderCenter;
  memory: MemorySystem;
  skills: SkillRegistry;
  system?: SystemKit;
  executor?: ToolExecutor;
  offline?: OfflinePersona;
  mcp?: McpClient;
}

export interface RuntimeOptions {
  maxToolRounds?: number;        // 最多工具调用轮数
  injectMemory?: boolean;        // 是否注入记忆
  injectSkills?: boolean;        // 是否注入技能描述
  budgetTokens?: number;         // G1：上下文 token 预算（默认 8000）
}

const TOOL_BLOCK_RE = /```tool\s*\n([\s\S]*?)\n```/g;

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
  constructor(private deps: RuntimeDeps) {}

  /** 主入口：处理一条用户/bot 消息，返回最终回复文本（兼记录消息） */
  async handle(
    input: { bot: Bot; from: string; text: string; sessionId: string; history?: ChatMessage[] },
    opts?: RuntimeOptions,
  ): Promise<RuntimeResult> {
    const { bot, text, sessionId } = input;
    const maxRounds = opts?.maxToolRounds ?? 3;
    const provider = this.deps.providers.get(bot.providerId) || this.deps.providers.getDefault();
    if (!provider) {
      // 离线人格降级：无模型 key 时也能用角色卡+记忆回应
      const offline = this.deps.offline ?? new OfflinePersona();
      const reply = offline.reply(bot, text, this.deps.memory.list(bot.id));
      this.record(bot.id, sessionId, text, reply, []);
      return { text: reply, toolCalls: [], usedSkills: [] };
    }

    let context = this.buildContext(bot, text, opts);
    const conversation: { role: string; content: string }[] = this.buildHistory(bot, text, input.history, opts);
    const toolCalls: ToolCall[] = [];
    const usedSkills: string[] = [];
    const memoryEvents: MemoryEntry[] = [];

    for (let round = 0; round < maxRounds; round++) {
      const { text: reply } = await this.deps.providers.complete(provider, {
        model: bot.model,
        system: context,
        history: conversation.map((m) => ({ sessionId, from: m.role === "assistant" ? bot.id : "user", to: bot.id, role: m.role as any, content: m.content, kind: "chat" as const, createdAt: Date.now() })),
        user: text,
      });

      // 尝试解析工具调用
      const tools = parseToolBlocks(reply);
      if (tools.length === 0) {
        // 最终回复
        this.record(bot.id, sessionId, text, reply, conversation);
        const events = this.extractMemory(bot.id, text, reply);
        memoryEvents.push(...events);
        return { text: reply, toolCalls, memoryEvents, usedSkills };
      }

      // 执行工具并回填
      let results: string[] = [];
      for (const t of tools) {
        const r = await this.executeTool(bot, t, text);
        results.push(`工具 ${t.tool} 结果：${r.output}`);
        toolCalls.push({ id: t.callId, tool: t.tool, args: t.args });
        if (t.tool.startsWith("skill:")) usedSkills.push(t.tool.slice(6));
      }
      // 回填工具结果，让模型基于结果生成下一步
      conversation.push({ role: "user", content: `[工具执行返回]\n${results.join("\n")}` });
      context = this.buildContext(bot, text, opts) + "\n\n[继续：根据上面工具执行结果生成最终回复或再次调用工具]";
    }
    const fallback = "（工具调用轮数已达上限，请简化任务或减少调用）";
    this.record(bot.id, sessionId, text, fallback, conversation);
    return { text: fallback, toolCalls, memoryEvents, usedSkills };
  }

  /**
   * 流式主入口：处理一条用户/bot 消息，工具循环 + 增量块回推。
   * onBlock(chunk) 实时收到 text/tool_call 增量；结束时记录完整富消息并返回。
   */
  async handleStream(
    input: { bot: Bot; from: string; text: string; content?: string | ContentBlock[]; sessionId: string; history?: ChatMessage[] },
    opts: RuntimeOptions & { onBlock: (b: ContentBlock) => void },
  ): Promise<RuntimeResult> {
    const { bot, text, sessionId } = input;
    const userContent: string | ContentBlock[] = input.content ?? text;
    const maxRounds = opts?.maxToolRounds ?? 3;
    const provider = this.deps.providers.get(bot.providerId) || this.deps.providers.getDefault();
    const started = Date.now();
    if (!provider) {
      const offline = this.deps.offline ?? new OfflinePersona();
      const reply = offline.reply(bot, text, this.deps.memory.list(bot.id));
      opts.onBlock({ type: "text", text: reply });
      this.recordRich(bot.id, sessionId, userContent, [{ type: "text", text: reply }], { latencyMs: Date.now() - started });
      return { text: reply, toolCalls: [], usedSkills: [] };
    }

    let context = this.buildContext(bot, text, opts);
    // G1：预算裁剪历史（超预算压缩最旧段为 summary，lastSeq 去重）
    const session = this.deps.store.listSessionsPage({ limit: 1 }).sessions.find((s) => s.id === sessionId)
      ?? { lastSeq: 0 } as any;
    const trimmed = await trimHistoryToBudget(input.history ?? [], session.lastSeq ?? 0, async (msgs) => {
      try {
        const p = this.deps.providers.getDefault();
        if (!p) return "（摘要生成失败：无 provider）";
        const r = await this.deps.providers.complete(p, {
          system: "把以下对话压缩为 3-5 条要点摘要（中文），不要多余内容。",
          user: msgs.map((m) => `${m.role}: ${m.content}`).join("\n"),
        });
        return r.text;
      } catch {
        return "（摘要生成失败）";
      }
    }, { budgetTokens: opts?.budgetTokens ?? 8000 });
    if (trimmed.compressed) this.deps.store.markCompacted(sessionId, trimmed.compactedUpToSeq);
    const conversation: { role: string; content: string }[] = trimmed.messages;
    const toolCalls: ToolCall[] = [];
    const usedSkills: string[] = [];
    const memoryEvents: MemoryEntry[] = [];
    const acc: ContentBlock[] = [];
    const push = (b: ContentBlock) => { opts.onBlock(b); acc.push(b); };

    for (let round = 0; round < maxRounds; round++) {
      const r = await this.deps.providers.streamComplete(provider, {
        model: bot.model,
        system: context,
        history: conversation.map((m) => ({ sessionId, from: m.role === "assistant" ? bot.id : "user", to: bot.id, role: m.role as any, content: m.content, kind: "chat" as const, createdAt: Date.now() })),
        user: userContent,
        stream: true,
        _onChunk: (b: ContentBlock) => push(b),
      });

      // 结构化 tool_call 块（适配器返回）优先；否则解析 ```tool``` 文本块
      const structCalls = (r.content ?? []).filter((b: ContentBlock): b is ContentBlock & { type: "tool_call" } => b.type === "tool_call");
      const textReply = r.text || acc.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
      let tools: ToolInvocation[] = [];
      if (structCalls.length) {
        tools = structCalls.map((b) => ({ callId: b.callId ?? `c${Date.now()}-${toolCalls.length}`, tool: b.tool, args: b.args ?? {} }));
      } else {
        tools = parseToolBlocks(textReply);
      }
      if (!tools.length) {
        const blocks = r.content?.length ? r.content : [{ type: "text" as const, text: textReply }];
        const meta: MessageMeta = { providerId: provider.id, model: bot.model ?? provider.model, latencyMs: Date.now() - started, tokensUsed: r.usage ? (r.usage.inputTokens ?? 0) + (r.usage.outputTokens ?? 0) : undefined, streamed: true };
        this.recordRich(bot.id, sessionId, userContent, blocks, meta);
        const events = this.extractMemory(bot.id, text, textReply);
        memoryEvents.push(...events);
        return { text: textReply, toolCalls, memoryEvents, usedSkills };
      }

      // 执行工具并回填
      let results: string[] = [];
      for (const t of tools) {
        const r2 = await this.executeTool(bot, t, text);
        results.push(`工具 ${t.tool} 结果：${r2.output}`);
        toolCalls.push({ id: t.callId, tool: t.tool, args: t.args });
        if (t.tool.startsWith("skill:")) usedSkills.push(t.tool.slice(6));
        push({ type: "tool_call", tool: t.tool, callId: t.callId, args: t.args, result: r2.output.slice(0, 500), status: "ok" });
      }
      conversation.push({ role: "user", content: `[工具执行返回]\n${results.join("\n")}` });
      context = this.buildContext(bot, text, opts) + "\n\n[继续：根据上面工具执行结果生成最终回复或再次调用工具]";
    }
    const fallback = "（工具调用轮数已达上限，请简化任务或减少调用）";
    const blocks: ContentBlock[] = [{ type: "text", text: fallback }];
    this.recordRich(bot.id, sessionId, userContent, blocks, { latencyMs: Date.now() - started, streamed: true });
    return { text: fallback, toolCalls, memoryEvents, usedSkills };
  }

  /** 记录富消息（用户 + 助手内容块数组 + meta） */
  private recordRich(botId: string, sessionId: string, userText: string | ContentBlock[], blocks: ContentBlock[], meta?: MessageMeta) {
    this.deps.store.addMessage({ sessionId, from: "user", to: botId, role: "user", content: userText, kind: "chat", createdAt: Date.now() });
    this.deps.store.addMessage({ sessionId, from: botId, to: "user", role: "assistant", content: blocks, kind: "chat", createdAt: Date.now(), meta });
  }

  /** 组装系统上下文：角色 + 记忆 + 技能 */
  private buildContext(bot: Bot, query: string, opts?: RuntimeOptions): string {
    const parts: string[] = [];
    parts.push(bot.systemPrompt || `${bot.name}（${bot.role}）：${bot.persona}`);
    parts.push(`你是 ${bot.name}，角色：${bot.role}。人设：${bot.persona}`);

    if (opts?.injectMemory !== false) {
      const mem = this.deps.memory.buildContext(bot.id, query);
      if (mem) parts.push(mem);
    }
    if (opts?.injectSkills !== false) {
      const skills = this.deps.skills.toolDescriptions();
      const mcpTools = this.deps.mcp?.listTools().map((t) => `- mcp:${t.serverId}/${t.name}: ${t.description ?? t.name}`).join("\n") ?? "";
      const tools = [
        BUILTIN_TOOL_DESCRIPTIONS,
        skills ? `【技能】\n${skills}` : "",
        mcpTools ? `【MCP 工具】\n${mcpTools}` : "",
      ].filter(Boolean).join("\n\n");
      if (tools) {
        parts.push(`【可用工具与技能】当需要以下能力时，在回复中输出工具块调用。\n${tools}\n工具块格式：\n\`\`\`tool\n{"tool":"<工具或技能key>","args":{...}}\n\`\`\``);
      }
    }
    parts.push(`回复要求：除非用户要求，用中文回答；需要调用技能时先输出工具块，工具结果返回后再给最终回复。`);
    return parts.join("\n\n");
  }

  private buildHistory(bot: Bot, text: string, history?: ChatMessage[], opts?: RuntimeOptions): { role: string; content: string }[] {
    const msgs: { role: string; content: string }[] = [];
    const recent = (history ?? []).slice(-10);
    for (const m of recent) {
      if (m.from === bot.id) msgs.push({ role: "assistant", content: contentText(m.content) });
      else if (m.from !== "user") msgs.push({ role: "user", content: `[${m.from}] ${contentText(m.content)}` });
      else msgs.push({ role: "user", content: contentText(m.content) });
    }
    msgs.push({ role: "user", content: text });
    return msgs;
  }

  /** 执行一个工具：内置工具（executor）或 skill:<key>（真执行技能指令） */
  private async executeTool(bot: Bot, t: ToolInvocation, originalText: string): Promise<{ output: string }> {
    const args = t.args ?? {};
    if (["fs.read", "fs.write", "fs.list", "bash.run", "web.fetch", "notify", "memory.add", "memory.search"].includes(t.tool)) {
      if (!this.deps.executor) return { output: `工具 ${t.tool} 未启用（executor 未注入）` };
      const r = await this.deps.executor.run(t.tool, { ...args, botId: bot.id });
      return { output: r.output };
    }
    if (t.tool === "remember" || t.tool === "memory.add") {
      const entry = this.deps.memory.add(bot.id, {
        kind: (args.kind as any) || "fact",
        content: String(args.content ?? args.text ?? ""),
        tags: args.tags ? String(args.tags).split(",").map((s) => s.trim()) : undefined,
        source: "bot-runtime",
      });
      return { output: `已记住：${entry.content}` };
    }
    if (t.tool === "recall" || t.tool === "memory.search") {
      const hits = this.deps.memory.search(bot.id, String(args.query ?? args.q ?? ""), 6);
      return { output: hits.length ? hits.map((h) => `- ${h.content}`).join("\n") : "（暂无相关记忆）" };
    }
    if (t.tool === "notify") {
      if (this.deps.system) await this.deps.system.notify(String(args.title ?? bot.name), String(args.body ?? ""));
      return { output: `已发送通知：${args.title ?? bot.name}` };
    }
    if (t.tool.startsWith("mcp:")) {
      if (!this.deps.mcp) return { output: "MCP 未启用" };
      const [serverId, ...rest] = t.tool.slice(4).split("/");
      const toolName = rest.join("/");
      try {
        const out = await this.deps.mcp.callTool(serverId, toolName, args);
        return { output: out.slice(0, 4000) };
      } catch (e) {
        return { output: `MCP 调用失败: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    if (t.tool === "skill" || t.tool.startsWith("skill:")) {
      const key = t.tool === "skill" ? String(args.key ?? args.name ?? "") : t.tool.slice(6);
      return this.runSkill(bot, key, args, originalText);
    }
    return { output: `未知工具 ${t.tool}（可用: fs.read/fs.write/fs.list/bash.run/web.fetch/notify/memory.add/memory.search/skill:<key>）` };
  }

  private async runSkill(bot: Bot, key: string, args: Record<string, unknown>, originalText: string): Promise<{ output: string }> {
    const skill = this.deps.skills.get(key);
    if (!skill) return { output: `技能 ${key} 不存在` };
    const body = this.deps.skills.loadBody(key);
    if (!body) return { output: `技能 ${key} 无指令正文` };
    if (this.deps.executor) {
      const lines = body
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /^(?:curl|echo|ls|cat|head|tail|grep|rg|find|pwd|date|whoami|node|bun|python3|git|npm|mkdir|touch|cp|mv|wc|sort|uniq|sed|awk|jq|open|osascript|swift|ps|df|du)/.test(l) && !l.startsWith("#"));
      const results: string[] = [];
      for (const line of lines.slice(0, 5)) {
        const r = await this.deps.executor.run("bash.run", { command: line });
        results.push(`$ ${line}\n${r.output.slice(0, 600)}`);
        if (!r.ok) break;
      }
      if (results.length) return { output: results.join("\n\n") };
    }
    return { output: `【技能 ${skill.name} 指令】\n${body}\n\n【用户请求】\n${originalText}\n【参数】\n${JSON.stringify(args)}` };
  }

  private record(botId: string, sessionId: string, userText: string, reply: string, conv: { role: string; content: string }[]) {
    this.deps.store.addMessage({
      sessionId, from: "user", to: botId, role: "user", content: userText, kind: "chat", createdAt: Date.now(),
    });
    this.deps.store.addMessage({
      sessionId, from: botId, to: "user", role: "assistant", content: reply, kind: "chat", createdAt: Date.now(),
    });
    // 异步自动摘要（会话 > 8 条且无 summary 时）
    if (conv.length > 8 && !this.deps.memory.list(botId).some((m) => m.kind === "summary")) {
      void this.deps.memory.summarizeConversation(botId, conv.slice(-8), async (msgs) => {
        const p = this.deps.providers.getDefault();
        if (!p) return "（摘要生成失败：无 provider）";
        const r = await this.deps.providers.complete(p, {
          system: "把以下对话压缩为 3-5 条要点摘要（中文），不要多余内容。",
          user: msgs.map((m) => `${m.role}: ${m.content}`).join("\n"),
        });
        return r.text;
      });
    }
  }

  /** 从对话中抽取记忆事件（简单启发式，后续可接 LLM 抽取） */
  private extractMemory(botId: string, userText: string, reply: string): MemoryEntry[] {
    const events: MemoryEntry[] = [];
    const m = userText.match(/(?:记住|记住这个|以后记得|我喜欢|我偏好|我叫)\s*[:：]?\s*(.+)/);
    if (m && userText.length < 120) {
      events.push(this.deps.memory.add(botId, { kind: "fact", content: m[1].trim(), source: "user" }));
    }
    if (/完成|搞定|做完了|成功/.test(reply)) {
      events.push(this.deps.memory.add(botId, { kind: "event", content: `${new Date().toISOString()} ${reply.slice(0, 80)}`, source: "auto" }));
    }
    return events;
  }
}

/** 解析回复中的 ```tool``` 块 */
export function parseToolBlocks(reply: string): ToolInvocation[] {
  const out: ToolInvocation[] = [];
  for (const m of reply.matchAll(TOOL_BLOCK_RE)) {
    try {
      const data = JSON.parse(m[1]);
      out.push({ callId: data.callId ?? `c${Date.now()}-${out.length}`, tool: String(data.tool), args: (data.args ?? {}) as Record<string, unknown> });
    } catch {
      // 忽略无法解析的工具块
    }
  }
  return out;
}

/** 一句话"创建技能"：从自然语言生成 SKILL.md（规则兜底，LLM 可增强） */
export function skillFromText(text: string): { key: string; markdown: string } | null {
  const m = text.match(/(?:创建|新增|加一个|做一个)\s*(?:技能|skill)\s*[:：为是]?\s*([^\s，。,!?]+)/);
  if (!m) return null;
  const key = m[1].replace(/[^\w\u4e00-\u9fa5-]/g, "");
  return {
    key,
    markdown: `---\nname: ${key}\ndescription: ${text.replace(/(?:创建|新增|加一个|做一个)\s*(?:技能|skill)\s*[:：为是]?\s*/, "").slice(0, 80) || `技能 ${key}`}\n---\n# ${key}\n\n${text}\n`,
  };
}
