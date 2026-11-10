// 规范 / 记忆的文本处理：存放位置说明、技能里的规范小节、从用户原话识别规范
import type { Bot } from "../types";

export const SKILL_RULES_HEADING = "## 用户补充的规范（与上文冲突时以这里为准）";

export function memoryLink(bot: Bot, kind: string, shared = false): string {
  const label = kind === "rule" ? "规范" : "记忆";
  return shared ? `[全局共享的${label}](app:memory/global/${kind})` : `[${bot.name} 的${label}](app:memory/${bot.id}/${kind})`;
}

/** 告诉模型用户定的规范存在哪里、怎么给用户链接，用户问「当前规范」时照这里如实回答 */
export function rulesWhereabouts(
  bot: Bot,
  skills: { key: string; name: string; owner?: string; enabled?: boolean; body: string }[],
  rules: { own: string[]; shared: string[]; teammates?: { name: string; id: string; rules: string[] }[] } = { own: [], shared: [] },
): string {
  const ruleSkills = skills.filter((k) => k.enabled !== false && (k.owner === bot.id || (!k.owner && k.body.includes(SKILL_RULES_HEADING))));
  const listOf = (xs: string[]) => (xs.length ? xs.map((x, i) => `    ${i + 1}. ${x}`).join("\n") : "    （没有）");
  const teammates = (rules.teammates ?? []).filter((t) => t.id !== bot.id);
  const teamLines = teammates.length
    ? `- 其他 bot 各自的私有规范（问「某某有没有规范 / 飞书机器人的规范」时以这里为准，不要拿你自己的条数去推断）：\n` +
      teammates.map((t) => {
        const link = `[${t.name} 的规范](app:memory/${t.id}/rule)`;
        if (!t.rules.length) return `  · ${link}：0 条`;
        return `  · ${link}，共 ${t.rules.length} 条：\n${listOf(t.rules)}`;
      }).join("\n")
    : "";
  return [
    "【必须遵守的规范】用户定下的，长期有效，与人设冲突时以这里为准；每处按时间从旧到新排列，互相矛盾时以靠后的为准。链接是存放位置，不是规范本身。",
    `- 存在 ${memoryLink(bot, "rule")}，共 ${rules.own.length} 条：\n${listOf(rules.own)}`,
    `- 存在 ${memoryLink(bot, "rule", true)}（所有 bot 都遵守），共 ${rules.shared.length} 条：\n${listOf(rules.shared)}`,
    teamLines,
    ruleSkills.length ? `- 写在技能里的规范（做这类任务时照做）：\n${ruleSkills.map((k) => `  · [${k.name}](app:skill/${k.key})：\n${skillRuleLines(k.body).map((x) => `    ${x}`).join("\n")}`).join("\n")}` : "- 技能里暂时没有用户写进去的规范",
    "用户问「当前规范 / 有哪些规则 / 打开看看」时：照上面逐条列出真实存着的规范，每处附上它的存放链接，让用户点开查看和修改；条数为 0 的位置不用列；系统默认设定不是用户定的规范，不要混进去；没有存下来的就如实说没有，并立刻用 memory.add 或 skill.update 补存。用户问某个 bot 的规范时，只看「其他 bot 各自的私有规范」里那一项（或用 memory.list 指定 bot），有就逐条列，没有才说没有——不要用你自己的规范去代替或推断。用户要改或取消某条规范时用 memory.update / memory.forget 改原来那条，不要再加一条相反的。",
  ].filter(Boolean).join("\n");
}

/** 技能里用户定的规范：有「用户补充的规范」小节就取那一节，否则取正文开头几条要点 */
export function skillRuleLines(body: string): string[] {
  const at = body.indexOf(SKILL_RULES_HEADING);
  const src = at >= 0 ? body.slice(at + SKILL_RULES_HEADING.length) : body;
  const lines = src.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("```"));
  const picked = (at >= 0 ? lines.filter((l) => /^[-*•\d]/.test(l)) : lines).slice(0, 8).map((l) => l.slice(0, 160));
  return picked.length ? picked : ["（点开技能查看）"];
}

/** 把新规范追加到技能正文末尾的固定小节里（没有这个小节就新建） */
export function appendSkillRules(body: string, rules: string[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const lines = rules.map((r) => `- ${r.replace(/^[-*•]\s*/, "")}（${date}）`).join("\n");
  const trimmed = body.replace(/\s+$/, "");
  return trimmed.includes(SKILL_RULES_HEADING) ? `${trimmed}\n${lines}\n` : `${trimmed}\n\n${SKILL_RULES_HEADING}\n${lines}\n`;
}

export function ruleBigrams(s: string): Set<string> {
  const t = s.replace(/（\d{4}-\d{2}-\d{2}）/g, "").replace(/[\s\p{P}\p{S}]/gu, "");
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

export const NEGATION = /不要|不能|不用|不许|不准|禁止|别|勿|不得|无需|不必/;

/** 追加的规范已经在正文里（或同一次 replace 已经写过同义的一条）就不再重复追加；一条带否定一条不带的是相反要求，不算重复 */
export function isDuplicateRule(rule: string, body: string, replaced: string[] = []): boolean {
  const a = ruleBigrams(rule);
  if (!a.size) return true;
  const neg = NEGATION.test(rule);
  const candidates = [...body.split("\n").filter((l) => /^\s*[-*•]/.test(l)), ...replaced];
  return candidates.some((c) => {
    if (NEGATION.test(c) !== neg) return false;
    const b = ruleBigrams(c);
    let hit = 0;
    for (const x of a) if (b.has(x)) hit++;
    return hit / Math.min(a.size, b.size || 1) >= 0.7;
  });
}

export interface MemoryDraft {
  kind: "rule" | "fact";
  /** bot = 只记给当前 bot；all = 所有 bot 共享（global） */
  scope: "bot" | "all";
  content: string;
}

/** 回复里声称已经记下 */
export const CLAIMS_SAVED = /记下了|记住了|已记录|记好了|已经记下|会记住|我记下|牢记|写进(了)?(规范|技能)|已保存.*(规范|偏好|设定)|(规范|规则|规矩|要求)[^。\n]{0,6}(已|已经)?(加上|添加|加入|更新|生效|设好|定好)|(已|已经)(加上|添加|加入|更新)[^。\n]{0,6}(规范|规则)/;

/** 用户明确要求记住 / 定规范的说法 → 记忆条目（提问、太长的话不记） */
export function memoryFromText(text: string): MemoryDraft[] {
  const t = text.trim();
  if (!t || t.length > 300) return [];
  const isQuestion = (s: string) => /[?？]\s*$|什么|吗[。！!]?$|谁|哪/.test(s);
  const scopeOf = (s: string): MemoryDraft["scope"] => (/(所有|全部|每个)\s*(bot|助手|成员|人)|大家都/.test(s) ? "all" : "bot");
  const person = (s: string) => s.replace(/^我/, "用户");
  /** 关于用户本人的稳定事实 → 默认全局共享（对齐 Grok shared user facts） */
  const userFact = (c: string) => /^(我|用户)|时区|称呼|叫我|名字|姓|喜欢|不喜欢|习惯|偏好/.test(c);

  const explicit = t.match(/^[^。！？!?\n]{0,8}?(?:记住这个|记住|记一下|记下|以后记得|别忘了)\s*[:：,，]?\s*(.+)$/s);
  if (explicit && !isQuestion(explicit[1])) {
    const c = explicit[1].trim();
    const fact = /^我/.test(c) || userFact(c);
    return [{ kind: fact ? "fact" : "rule", scope: fact ? "all" : scopeOf(t), content: person(c) }];
  }
  const rule = t.match(/^(?:(?:定下?|加|新增|添加|补充)?(?:一?(?:个|条))?新?(?:规范|规矩|规则|要求))\s*[:：]\s*(.+)$/s)
    ?? t.match(/^(?:定下?(?:个)?(?:规范|规矩|规则)|约定|规定)\s*[:：,，]?\s*(.+)$/s)
    ?? t.match(/^((?:每次|所有)(?:回复|回答|输出).+)$/s);
  if (rule && !isQuestion(rule[1])) return [{ kind: "rule", scope: scopeOf(t), content: `用户定下的规范：${rule[1].trim()}` }];
  // 「以后 / 从现在开始」也常用在一次性的话里（以后再说、从现在开始帮我查…），要带上明确的要求才算规范
  const later = t.match(/^(?:从现在(?:起|开始)|从今以后|今后|以后)\s*[:：,，]?\s*(.+)$/s);
  if (later) {
    const c = later[1].trim();
    const oneOff = /^(?:再|先|帮我|给我|替我|查|搜|找|发|打开|看看|告诉我|说吧|聊|有空|有机会)/.test(c);
    const normative = /都|要|不要|别|必须|只|一律|每次|总是|统一|禁止|不准|不能|不许|应该|记得|改成|改用|叫我|称呼|用中文|用英文/.test(c);
    if (c.length >= 4 && !oneOff && normative && !isQuestion(c)) return [{ kind: "rule", scope: scopeOf(t), content: `用户定下的规范：${t}` }];
  }
  const self = t.match(/^(我叫|我喜欢|我偏好|我习惯)\s*[:：]?\s*(.+)$/s);
  if (self && !isQuestion(self[2])) return [{ kind: "fact", scope: "all", content: `用户${self[1].slice(1)}${self[2].trim()}` }];
  return [];
}

/** 一句话"创建技能"：从自然语言生成 SKILL.md（规则兜底，LLM 可增强；正文走 Grok 六段） */
export function skillFromText(text: string): { key: string; markdown: string } | null {
  const m = text.match(/(?:创建|新增|加一个|做一个)\s*(?:技能|skill)\s*[:：为是]?\s*([^\s，。,!?]+)/);
  if (!m) return null;
  const key = m[1].replace(/[^\w\u4e00-\u9fa5-]/g, "");
  const description = text.replace(/(?:创建|新增|加一个|做一个)\s*(?:技能|skill)\s*[:：为是]?\s*/, "").slice(0, 80) || `技能 ${key}`;
  // 松散正文交给 SkillRegistry.create → ensureGrokSkillBody 收成六段
  return {
    key,
    markdown: `---\nname: ${key}\ndescription: ${description}\n---\n# ${key}\n\n${text}\n`,
  };
}
