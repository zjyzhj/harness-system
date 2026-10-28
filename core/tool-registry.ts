/**
 * 工具注册表：名称 / 前缀 → 描述 + 执行函数。
 * BotRuntime 只负责循环；加工具 = register，不再改巨型 switch。
 */
import type { Bot, ContentBlock } from "./types";

export type ToolOutcome = { output: string; blocks?: ContentBlock[]; halt?: boolean };

/** 一轮调用的上下文（由 runtime 填好再交给 handler） */
export interface ToolCtx {
  bot: Bot;
  tool: string;
  args: Record<string, unknown>;
  originalText: string;
  depth: number;
  sessionId?: string;
  /** 调用方自定义的本轮状态（如联网来源列表） */
  turn?: unknown;
}

export type ToolHandler = (ctx: ToolCtx) => ToolOutcome | Promise<ToolOutcome>;

interface Entry {
  description: string;
  handle: ToolHandler;
}

export class ToolRegistry {
  private exact = new Map<string, Entry>();
  private prefixes: { prefix: string; entry: Entry }[] = [];

  /** 精确名称，如 web.search */
  register(name: string, description: string, handle: ToolHandler): this {
    this.exact.set(name, { description, handle });
    return this;
  }

  /** 前缀匹配，如 skill: / mcp: / ui. / app.；长前缀优先 */
  registerPrefix(prefix: string, description: string, handle: ToolHandler): this {
    this.prefixes.push({ prefix, entry: { description, handle } });
    this.prefixes.sort((a, b) => b.prefix.length - a.prefix.length);
    return this;
  }

  has(name: string): boolean {
    return !!this.resolve(name);
  }

  private resolve(name: string): Entry | undefined {
    return this.exact.get(name) ?? this.prefixes.find((p) => name.startsWith(p.prefix))?.entry;
  }

  async run(ctx: ToolCtx): Promise<ToolOutcome> {
    const entry = this.resolve(ctx.tool);
    if (!entry) {
      const known = [...this.exact.keys()].slice(0, 24).join("/");
      return { output: `未知工具 ${ctx.tool}（可用: ${known}${this.exact.size > 24 ? "/…" : ""}）` };
    }
    return entry.handle(ctx);
  }

  /** 给模型看的工具清单（精确名 + 前缀族各一行说明） */
  prompt(): string {
    const lines: string[] = [];
    for (const [name, e] of this.exact) lines.push(`- ${name}: ${e.description}`);
    const seen = new Set<string>();
    for (const { prefix, entry } of this.prefixes) {
      if (seen.has(prefix)) continue;
      seen.add(prefix);
      lines.push(`- ${prefix}*: ${entry.description}`);
    }
    return lines.join("\n");
  }

  names(): string[] {
    return [...this.exact.keys()];
  }
}
