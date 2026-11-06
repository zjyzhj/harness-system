import { randomUUID } from "node:crypto";
import type { Bot, Provider } from "./types";
import type { Store } from "./store";
import { defaultAvatar } from "./avatar";

export interface ParsedCreateRequest {
  name: string;
  role: string;
  persona: string;
  providerId?: string;
  model?: string;
  systemPrompt?: string;
  petEnabled?: boolean;
}

export interface LLMParser {
  parseCreate(text: string): Promise<ParsedCreateRequest | null>;
}

/**
 * 一句话创建 bot。
 * 优先用 LLMParser（注入），不可用时回退到规则抽取。
 */
export class AgentRegistry {
  constructor(private store: Store, private parser?: LLMParser) {}

  /** 只解析、不落盘——创建页预填用 */
  async draftFromText(text: string): Promise<ParsedCreateRequest> {
    return (this.parser && (await this.parser.parseCreate(text).catch(() => null))) || ruleParse(text);
  }

  async createBotFromText(text: string, opts?: { defaultProviderId?: string; petEnabled?: boolean }): Promise<Bot> {
    const parsed = await this.draftFromText(text);
    const providerId = parsed.providerId || opts?.defaultProviderId || this.store.getDefaultProvider()?.id || "default";
    const bot: Bot = {
      id: randomUUID(),
      name: parsed.name,
      role: parsed.role,
      persona: parsed.persona,
      providerId,
      model: parsed.model,
      systemPrompt: parsed.systemPrompt || buildSystemPrompt(parsed),
      // 默认上台桌宠：定义靠一句话，不必再去开关「打开宠物」
      petEnabled: opts?.petEnabled ?? parsed.petEnabled ?? true,
      createdAt: Date.now(),
    };
    bot.avatar = defaultAvatar(bot.id);
    this.store.saveBot(bot);
    return bot;
  }

  updateBot(id: string, patch: Partial<Bot>): Bot | null {
    const bot = this.store.getBot(id);
    if (!bot) return null;
    const next = { ...bot, ...patch, id };
    this.store.saveBot(next);
    return next;
  }

  listBots(): Bot[] {
    return this.store.listBots();
  }

  getBot(id: string): Bot | null {
    return this.store.getBot(id);
  }

  deleteBot(id: string) {
    this.store.deleteBot(id);
  }

  setPetEnabled(id: string, enabled: boolean): Bot | null {
    return this.updateBot(id, { petEnabled: enabled });
  }
}

export function buildSystemPrompt(p: ParsedCreateRequest): string {
  return [
    `你是 ${p.name}，角色：${p.role}。`,
    `人设：${p.persona}。`,
    `在回答时保持角色一致；如无特别说明，回答使用中文。`,
  ].join("\n");
}

const ROLE_HINTS: Record<string, { role: string; persona: string; systemPrompt: string }> = {
  "翻译": { role: "翻译助手", persona: "专业、准确、保留语气", systemPrompt: "你是专业翻译助手，输出前先确认源语言和目标语言；直译与意译结合，保持原语气。" },
  "代码": { role: "编程助手", persona: "严谨、简洁、注重可维护性", systemPrompt: "你是资深软件工程师，回答含代码时给出可运行示例与关键解释，默认中文。" },
  "写作": { role: "写作助手", persona: "有文采、有结构感", systemPrompt: "你是写作助手，输出有清晰结构、用词精准，默认中文。" },
  "客服": { role: "客服助手", persona: "耐心、礼貌、高效", systemPrompt: "你是客服助手，先安抚再解决，回答简洁友好，默认中文。" },
  "助手": { role: "通用助手", persona: "友好、可靠", systemPrompt: "你是通用助手，回答简洁准确，默认中文。" },
};

export function ruleParse(text: string): ParsedCreateRequest {
  const nameMatch = text.match(/(?:名字|名称|叫|名为)[:：为是]?\s*([^\s，。,!?；;]+)/) || text.match(/^(?:创建|新建|做一个|来一个)\s*(?:bot)?\s*[:：为是]?\s*([^\s，。,!?；;]+)/) || text.match(/bot\s*[:：为是]\s*([^\s，。,!?；;]+)/);
  const name = nameMatch?.[1] || (() => {
    const m = text.match(/(?:叫|名为|名字是)\s*([^\s，。,!?；;]+)/);
    return m?.[1] ?? "助手";
  })();
  const hint = ROLE_HINTS[name] || inferRole(text);
  const noPet = /不要宠物|别出台|不要桌宠|关闭宠物|无宠物/.test(text);
  return {
    name,
    role: hint.role,
    persona: hint.persona,
    model: extractModel(text),
    systemPrompt: hint.systemPrompt,
    petEnabled: noPet ? false : true,
  };
}

function inferRole(text: string): { role: string; persona: string; systemPrompt: string } {
  if (/翻译|translate/i.test(text)) return ROLE_HINTS["翻译"];
  if (/代码|编程|code|写个|函数|bug/i.test(text)) return ROLE_HINTS["代码"];
  if (/写作|文章|文案|小说/i.test(text)) return ROLE_HINTS["写作"];
  if (/客服|服务|support/i.test(text)) return ROLE_HINTS["客服"];
  return ROLE_HINTS["助手"];
}

export function extractModel(text: string): string | undefined {
  const m = text.match(/用\s*([\w.\-]+)\s*(模型|model)?/i) || text.match(/(?:model|模型)\s*[:：为是]\s*([\w.\-]+)/i);
  return m?.[1];
}
