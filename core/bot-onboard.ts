import type { Bot } from "./types";
import type { Store } from "./store";

/** 首启漏斗：配模型 → 建 bot → 开聊 */
export type FirstRunStep = "provider" | "bot" | "chat";

export function firstRunStep(input: { providerCount: number; botCount: number }): FirstRunStep {
  if ((input.providerCount ?? 0) <= 0) return "provider";
  if ((input.botCount ?? 0) <= 0) return "bot";
  return "chat";
}

export function firstRunEmptyCopy(step: FirstRunStep): {
  title: string;
  sub: string;
  primary: string;
  secondary?: string;
} {
  if (step === "provider") {
    return {
      title: "先接上一个模型",
      sub: "OpenAI 兼容 API，或本机 Claude / Codex / Cursor CLI。接好后不到十秒就能建好第一个 bot。",
      primary: "配置模型",
      secondary: "稍后再说，先建 bot",
    };
  }
  if (step === "bot") {
    return {
      title: "创建第一个 bot",
      sub: "起个名字，或一句话描述它是干什么的。创建后会带着欢迎语和起步建议。",
      primary: "新建 bot",
      secondary: "用一句话创建",
    };
  }
  return {
    title: "选一个 bot 开始聊",
    sub: "也可以点侧栏右上角 ＋ 再建一个。",
    primary: "新建 bot",
  };
}

/** 新建 bot 的首句问候（对标 Grok 刚建好就能聊） */
export function welcomeGreeting(bot: Pick<Bot, "name" | "role" | "persona">): string {
  const role = (bot.role || "助手").trim();
  const vibe = (bot.persona || "").trim();
  const who = vibe ? `${role}，风格偏「${vibe}」` : role;
  return `你好，我是「${bot.name}」——${who}。很高兴见到你。想先聊手头的事，还是定个我会反复帮你做的习惯？直接打字，或点下面的建议都行。`;
}

export function welcomeSuggestions(
  bot: Pick<Bot, "name" | "role">,
  opts?: { hasProvider?: boolean },
): string[] {
  const role = (bot.role || "").toLowerCase();
  const tips: string[] = [];
  if (opts?.hasProvider === false) {
    tips.push("提醒我去配置一个模型");
  }
  tips.push("先介绍一下你能帮我做什么");
  if (/代码|编程|改包|工程|开发|cli/.test(role) || /代码|编程|改包/.test(bot.name)) {
    tips.push("帮我选一个工程目录");
  } else {
    tips.push("帮我设一个定时提醒");
  }
  tips.push("我们先定几条协作规矩");
  return tips.slice(0, 3);
}

/** 写入欢迎会话；返回 sessionId。已有用户会话则不重复种。 */
export function seedBotWelcome(store: Store, bot: Bot): string {
  const existing = store.listSessionsPage({ botId: bot.id, limit: 5 }).sessions
    .find((s) => !/^(plan|sched|b2b)-/.test(s.id));
  if (existing && (existing.messageCount ?? 0) > 0) return existing.id;

  const hasProvider = store.listProviders().length > 0;
  const sid = `s-${Date.now()}`;
  store.ensureSession(sid, bot.id, "新对话");
  store.addMessage({
    sessionId: sid,
    from: bot.id,
    to: "user",
    role: "assistant",
    content: welcomeGreeting(bot),
    kind: "chat",
    createdAt: Date.now(),
    meta: { suggestions: welcomeSuggestions(bot, { hasProvider }) },
  });
  return sid;
}
