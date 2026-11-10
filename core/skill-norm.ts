/**
 * Grok Bot 技能正文规范：一条有用的技能须写清 6 件事
 * https://docs.x.ai/grok-bot/skills-routines-and-automations
 *
 * 1. When to use it
 * 2. Required inputs and access
 * 3. The sequence of work
 * 4. How to validate the result
 * 5. What to return
 * 6. What requires approval
 */
import { SKILL_RULES_HEADING } from "./runtime/rules-text";

export interface SkillSectionDef {
  id: "when" | "inputs" | "steps" | "validate" | "return" | "approval";
  /** 正文里的标准二级标题 */
  title: string;
  /** 识别旧稿 / 别名时也算已有 */
  aliases: string[];
  placeholder: string;
}

export const GROK_SKILL_SECTIONS: SkillSectionDef[] = [
  {
    id: "when",
    title: "何时使用",
    aliases: ["何时使用", "when to use", "触发场景", "适用场景"],
    placeholder: "- 与 frontmatter 的 description 一致：只在该场景调用本技能。",
  },
  {
    id: "inputs",
    title: "所需输入与权限",
    aliases: ["所需输入与权限", "所需输入", "输入与权限", "required inputs", "前置条件"],
    placeholder: "- （待补充）列出必需输入、账号/登录、工具与目录权限；缺什么就先问清或停住。",
  },
  {
    id: "steps",
    title: "工作步骤",
    aliases: ["工作步骤", "步骤", "流程", "sequence", "执行步骤"],
    placeholder: "- （待补充）按顺序写出可执行步骤；需要工具时写明工具名。",
  },
  {
    id: "validate",
    title: "如何验收",
    aliases: ["如何验收", "验收", "校验", "validate", "验证结果"],
    placeholder: "- （待补充）列出可检查的结果标准；不达标则修正或报告失败，不要拿旧数据凑。",
  },
  {
    id: "return",
    title: "交回什么",
    aliases: ["交回什么", "输出", "交付", "what to return", "输出格式"],
    placeholder: "- （待补充）说明交付物格式、落点（对话 / 文件 / 通知）与必要链接。",
  },
  {
    id: "approval",
    title: "需要批准",
    aliases: ["需要批准", "批准", "审批边界", "approval", "安全边界"],
    placeholder:
      "- 发送、删除、对外联系、付款、改生产或发布前必须先征得用户同意（例行里停在批准点）。\n- 密钥用 `{{secret:名字}}` 或保险库，不要写进技能正文。",
  },
];

const SECTION_HEAD = /^#{2,3}\s+(.+?)\s*$/;

export function skillSectionHeading(title: string): string {
  return `## ${title}`;
}

/** 正文里已出现哪些 Grok 小节（按标准 title 返回） */
export function presentSkillSections(body: string): string[] {
  const found = new Set<string>();
  for (const line of String(body || "").split("\n")) {
    const m = line.match(SECTION_HEAD);
    if (!m) continue;
    const h = m[1].trim().toLowerCase();
    for (const s of GROK_SKILL_SECTIONS) {
      if (s.aliases.some((a) => h === a.toLowerCase() || h.includes(a.toLowerCase()))) {
        found.add(s.title);
      }
    }
  }
  return GROK_SKILL_SECTIONS.map((s) => s.title).filter((t) => found.has(t));
}

export function missingSkillSections(body: string): string[] {
  const present = new Set(presentSkillSections(body));
  return GROK_SKILL_SECTIONS.map((s) => s.title).filter((t) => !present.has(t));
}

export function hasGrokSkillShape(body: string): boolean {
  return missingSkillSections(body).length === 0;
}

/** 空技能 / 手动新建时的六段骨架 */
export function grokSkillSkeleton(name: string, description?: string): string {
  const when =
    description?.trim()
      ? `- ${description.trim()}`
      : GROK_SKILL_SECTIONS[0].placeholder;
  const parts = [
    `# ${name.trim() || "未命名技能"}`,
    "",
    skillSectionHeading("何时使用"),
    when,
    "",
  ];
  for (const s of GROK_SKILL_SECTIONS.slice(1)) {
    parts.push(skillSectionHeading(s.title), s.placeholder, "");
  }
  return `${parts.join("\n").replace(/\s+$/, "")}\n`;
}

/**
 * 把任意正文收成 Grok 六段。
 * - 已有标准小节：保留原内容，只补缺段
 * - 无结构旧稿：原正文迁入「工作步骤」，再补其余段
 * - 「用户补充的规范」小节始终留在文末
 */
export function ensureGrokSkillBody(
  name: string,
  body: string,
  opts?: { description?: string },
): string {
  const raw = String(body || "").replace(/\s+$/, "");
  const title = name.trim() || "未命名技能";
  const description = opts?.description?.replace(/\s*\n\s*/g, " ").trim();

  let rulesTail = "";
  let main = raw;
  const rulesAt = main.indexOf(SKILL_RULES_HEADING);
  if (rulesAt >= 0) {
    rulesTail = main.slice(rulesAt).replace(/^\s+/, "");
    main = main.slice(0, rulesAt).replace(/\s+$/, "");
  }

  if (!main.trim()) {
    const sk = grokSkillSkeleton(title, description);
    return rulesTail ? `${sk.trimEnd()}\n\n${rulesTail}\n` : sk;
  }

  const present = new Set(presentSkillSections(main));
  if (present.size === GROK_SKILL_SECTIONS.length) {
    const withTitle = ensureTitle(main, title);
    return rulesTail ? `${withTitle.trimEnd()}\n\n${rulesTail}\n` : `${withTitle.trimEnd()}\n`;
  }

  // 已有部分小节：按出现顺序抽出，缺的补占位
  if (present.size > 0) {
    const rebuilt = rebuildPartial(main, title, description, present);
    return rulesTail ? `${rebuilt.trimEnd()}\n\n${rulesTail}\n` : `${rebuilt.trimEnd()}\n`;
  }

  // 完全无结构：整段迁入工作步骤
  const loose = stripLeadingTitle(main).trim() || GROK_SKILL_SECTIONS[2].placeholder;
  const parts = [
    `# ${title}`,
    "",
    skillSectionHeading("何时使用"),
    description ? `- ${description}` : GROK_SKILL_SECTIONS[0].placeholder,
    "",
    skillSectionHeading("所需输入与权限"),
    GROK_SKILL_SECTIONS[1].placeholder,
    "",
    skillSectionHeading("工作步骤"),
    loose,
    "",
    skillSectionHeading("如何验收"),
    GROK_SKILL_SECTIONS[3].placeholder,
    "",
    skillSectionHeading("交回什么"),
    GROK_SKILL_SECTIONS[4].placeholder,
    "",
    skillSectionHeading("需要批准"),
    GROK_SKILL_SECTIONS[5].placeholder,
    "",
  ];
  const out = parts.join("\n").replace(/\s+$/, "");
  return rulesTail ? `${out}\n\n${rulesTail}\n` : `${out}\n`;
}

function ensureTitle(body: string, title: string): string {
  const t = body.trimStart();
  if (/^#\s+\S/.test(t)) return t;
  return `# ${title}\n\n${t}`;
}

function stripLeadingTitle(body: string): string {
  // 去掉开头的一级标题（可无尾随空行；save 时会先 trim 掉末尾换行）
  return body.replace(/^#\s+[^\n]+(?:\n+|$)/, "").replace(/^\s+/, "");
}

function rebuildPartial(
  main: string,
  title: string,
  description: string | undefined,
  present: Set<string>,
): string {
  // 按行切成「当前小节」块
  const lines = main.split("\n");
  const blocks = new Map<string, string[]>();
  let current: string | null = null;
  const preamble: string[] = [];

  for (const line of lines) {
    const m = line.match(SECTION_HEAD);
    if (m) {
      const h = m[1].trim().toLowerCase();
      const hit = GROK_SKILL_SECTIONS.find((s) =>
        s.aliases.some((a) => h === a.toLowerCase() || h.includes(a.toLowerCase())),
      );
      if (hit) {
        current = hit.title;
        if (!blocks.has(current)) blocks.set(current, []);
        continue;
      }
    }
    if (current) blocks.get(current)!.push(line);
    else preamble.push(line);
  }

  // 前言里非标题正文并入工作步骤
  const preLoose = stripLeadingTitle(preamble.join("\n")).trim();
  if (preLoose && !present.has("工作步骤")) {
    blocks.set("工作步骤", [preLoose]);
    present.add("工作步骤");
  } else if (preLoose && present.has("工作步骤")) {
    const cur = blocks.get("工作步骤") ?? [];
    blocks.set("工作步骤", [preLoose, "", ...cur]);
  }

  const parts: string[] = [`# ${title}`, ""];
  for (const s of GROK_SKILL_SECTIONS) {
    parts.push(skillSectionHeading(s.title));
    const content = (blocks.get(s.title) ?? []).join("\n").trim();
    if (content) {
      parts.push(content);
    } else if (s.id === "when" && description) {
      parts.push(`- ${description}`);
    } else {
      parts.push(s.placeholder);
    }
    parts.push("");
  }
  return parts.join("\n").replace(/\s+$/, "");
}

/** 给模型的六段写作说明（draft / prompt） */
export const GROK_SKILL_BODY_GUIDE = `body 必须是 Markdown，以「# 技能名」开头，并按顺序包含这 6 个二级标题（Grok 规范，缺一不可）：
## 何时使用
## 所需输入与权限
## 工作步骤
## 如何验收
## 交回什么
## 需要批准
每一节写具体可执行内容，不要只抄标题；「需要批准」须写明发送/删除/对外联系/改生产等哪些动作必须先征得用户同意。`;
