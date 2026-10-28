import type { Bot, MemoryEntry, PersonaCard } from "./types";

/**
 * 离线人格引擎 — 无模型 key 时，基于角色卡 + 记忆用规则/模板生成
 * 有性格的回应与主动搭话。让宠物「没网也能说话」。
 *
 * 设计目标：不是替代 LLM，而是保证「零配置也有完整体验」；
 * 一旦配置了 provider，BotRuntime 优先走模型。
 */
export class OfflinePersona {
  constructor() {}

  /** 是否有办法生成回复（总是 true：离线也有一套规则回复） */
  available(): boolean {
    return true;
  }

  /** 基于角色卡与记忆，生成对一条消息的离线回复 */
  reply(bot: Bot, text: string, memory: MemoryEntry[]): string {
    const card = bot.personaCard;
    const greeting = /^(嗨|hi|hello|你好|在吗|早安|晚安|早|哈喽|hey)/i.test(text.trim());
    const question = /[?？]$|什么|怎么|为什么|如何|多少|吗|能不能|可以/.test(text);
    const thanks = /(谢谢|感谢|thx|thanks)/i.test(text);
    const bye = /(再见|拜拜|bye|晚安)/i.test(text);

    if (greeting) {
      return this.pick([
        `${card?.catchphrase ?? "我在呢"} 我是${bot.name}，${card?.traits?.join("、") ?? bot.persona ?? "你的小助手"}～有什么事尽管说。`,
        `你好呀！我是${bot.name}。${this.recallMemory(bot, memory) || "今天想让我帮你做点什么呢？"}`,
      ]);
    }
    if (thanks) {
      return this.pick([
        `不客气～${card?.catchphrase ?? "能帮上忙就好。"}`,
        `小事一桩，随时喊我！${bot.name}在呢。`,
      ]);
    }
    if (bye) {
      return this.pick([
        `拜拜～有需要再叫我 ${bot.name} 呀 👋`,
        `晚安，明天见！常来找我玩～`,
      ]);
    }
    if (question) {
      const mem = this.recallMemory(bot, memory);
      if (mem) {
        return `我记得：${mem} 不过我现在是离线状态，配置模型后我能回答得更全面。要我帮你记住更多吗？`;
      }
      return this.pick([
        `好问题！不过我现在是离线模式，回答有限。你可以在主控面板给我配一个模型（如 OpenAI 兼容 API 或 claude CLI），我就能认真回答了。`,
        `这个我想好好想想～可惜现在是离线状态。去设置里给我加个模型 key，我就能火力全开啦！`,
      ]);
    }
    // 默认
    return this.pick([
      `${card?.catchphrase ?? "嗯嗯"} 我听到了：「${text.slice(0, 40)}」。离线状态下我只能先记住它，配好模型后就能真正帮你啦。`,
      `收到！我先把它${this.rememberMemory(bot, text, memory) ? "记进长期记忆" : "放着"}，等有了模型我们再深入聊。`,
    ]);
  }

  /** 主动搭话：随机问候 / 基于记忆的关怀 / 提醒 */
  proactive(bot: Bot, memory: MemoryEntry[]): { text: string; title?: string } | null {
    const hour = new Date().getHours();
    const timeGreet = hour < 6 ? "夜深了" : hour < 12 ? "早上好" : hour < 18 ? "下午好" : "晚上好";
    const facts = memory.filter((m) => m.kind === "fact");
    const r = Math.random();

    if (r < 0.35 && facts.length) {
      const f = facts[Math.floor(Math.random() * facts.length)];
      return { text: `对了，我记得你之前说「${f.content.slice(0, 30)}」。这件事进展还顺利吗？` };
    }
    if (r < 0.6) {
      return { text: `${timeGreet}！我是${bot.name} ${bot.personaCard?.catchphrase ?? "～今天想让我做点什么？"}`, title: "打招呼" };
    }
    if (r < 0.8) {
      return { text: `我一直在桌面上陪着你呢～需要灵感、翻译还是写代码，喊我就行。${bot.personaCard?.traits?.join("") ?? ""}`, title: "陪伴" };
    }
    return { text: `想让我更了解你吗？跟我说一句「记住：我喜欢…」就行，我会一直记得。想让我做事的话，去主控面板给我配个模型吧～`, title: "了解我" };
  }

  private recallMemory(bot: Bot, memory: MemoryEntry[]): string {
    const facts = memory.filter((m) => m.kind === "fact");
    return facts.length ? facts[facts.length - 1].content.slice(0, 50) : "";
  }

  private rememberMemory(bot: Bot, text: string, memory: MemoryEntry[]): boolean {
    return /记住|我喜欢|我叫|我偏好/.test(text);
  }

  private pick(arr: string[]): string {
    return arr[Math.floor(Math.random() * arr.length)];
  }
}

/** 生成一句「离线人格」自我介绍（用于宠物首次出现） */
export function offlineIntro(bot: Bot): string {
  const card = bot.personaCard;
  return `${card?.catchphrase ?? "你好"} 我是${bot.name}${card?.traits?.length ? "，性格：" + card.traits.join("、") : ""}。${card?.background ?? ""}`;
}
