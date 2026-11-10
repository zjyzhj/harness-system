import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, rmSync } from "node:fs";
import { writeFileAtomic } from "./atomic-fs";
import { join } from "node:path";
import type { Skill } from "./types";
import { ensureGrokSkillBody, GROK_SKILL_BODY_GUIDE } from "./skill-norm";

/**
 * 技能注册表 — 对标 CowAgent agent/skills/ 与 DeepSeek-Harness .agents/skills/
 * 规范：
 *   skills/<key>/SKILL.md
 *   frontmatter: ---\nname, description, always?, requires?\n---
 *   body: Grok 六段说明书（何时使用 / 输入与权限 / 工作步骤 / 如何验收 / 交回什么 / 需要批准）
 *         渐进披露：默认只注入 description，调用时才注入 body
 */
export class SkillRegistry {
  private skills = new Map<string, Skill>();

  constructor(private skillsDir: string) {
    this.loadAll();
  }

  /** 扫描 skillsDir 下所有 <key>/SKILL.md */
  loadAll() {
    this.skills.clear();
    if (!existsSync(this.skillsDir)) return;
    for (const entry of readdirSync(this.skillsDir)) {
      const dir = join(this.skillsDir, entry);
      if (!statSync(dir).isDirectory()) continue;
      const skillPath = join(dir, "SKILL.md");
      if (!existsSync(skillPath)) continue;
      const raw = readFileSync(skillPath, "utf8");
      const skill = parseSkill(entry, skillPath, raw);
      if (skill) this.skills.set(entry, skill);
    }
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }

  /** 某个 bot 能用的技能：共享技能 + 它自己的私有技能（不论是否对该 bot 关闭） */
  visibleTo(botId?: string): Skill[] {
    return this.list().filter((s) => !s.owner || s.owner === botId);
  }

  /** 对该 bot 实际可用：全局 enabled，且不在 bot.disabledSkills */
  enabledFor(bot: { id: string; disabledSkills?: string[] }, skill: Skill): boolean {
    if (!skill.enabled) return false;
    if (skill.owner && skill.owner !== bot.id) return false;
    if (!skill.owner && (bot.disabledSkills ?? []).includes(skill.key)) return false;
    return true;
  }

  /** 新建或更新技能（表单式）：key 不给则按名称生成；正文自动补齐 Grok 六段 */
  save(input: { key?: string; name: string; description: string; body: string; owner?: string; enabled?: boolean }): Skill {
    const name = input.name.trim();
    const description = input.description.replace(/\s*\n\s*/g, " ").trim();
    if (!name || !description) throw new Error("技能需要名称和描述（description = 何时使用，bot 靠它决定何时调用）");
    const key = input.key && this.skills.has(input.key) ? input.key : this.uniqueKey(input.key || name);
    const prev = this.skills.get(key);
    const body = ensureGrokSkillBody(name, input.body || prev?.body || "", { description });
    const skill: Skill = {
      key, name, description, body, path: join(this.skillsDir, key, "SKILL.md"),
      enabled: input.enabled ?? prev?.enabled ?? true, always: prev?.always, requires: prev?.requires,
      owner: input.owner || undefined,
    };
    this.write(skill);
    return skill;
  }

  get(key: string): Skill | null {
    return this.skills.get(key) ?? null;
  }

  /** 创建技能：传入目录名 + SKILL.md 内容（可含 frontmatter），自动落盘并补齐 Grok 六段 */
  create(key: string, markdown: string): Skill {
    const dir = join(this.skillsDir, key);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "SKILL.md");
    const parsed = parseSkill(key, path, markdown);
    if (!parsed) throw new Error(`技能 ${key} 格式无效（需要 frontmatter 含 name/description）`);
    const skill: Skill = {
      ...parsed,
      body: ensureGrokSkillBody(parsed.name, parsed.body, { description: parsed.description }),
    };
    this.write(skill);
    return skill;
  }

  delete(key: string) {
    this.skills.delete(key);
    rmSync(join(this.skillsDir, key), { recursive: true, force: true });
  }

  setEnabled(key: string, enabled: boolean) {
    const s = this.skills.get(key);
    if (s) this.write({ ...s, enabled });
  }

  private write(skill: Skill) {
    writeFileAtomic(skill.path, serializeSkill(skill));
    this.skills.set(skill.key, skill);
  }

  private uniqueKey(seed: string): string {
    const base = seed.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "skill";
    let key = base;
    for (let i = 2; this.skills.has(key) || existsSync(join(this.skillsDir, key)); i++) key = `${base}-${i}`;
    return key;
  }

  /** 给 LLM 的工具描述（渐进披露：只有 description + requires）；传 bot 时尊重 disabledSkills */
  toolDescriptions(botId?: string, bot?: { id: string; disabledSkills?: string[] }): string {
    const list = botId === undefined ? this.list() : this.visibleTo(botId);
    return list
      .filter((s) => (bot ? this.enabledFor(bot, s) : s.enabled))
      .map((s) => `- ${s.key}: ${s.description}${s.requires?.length ? `（依赖: ${s.requires.join(", ")}）` : ""}`)
      .join("\n");
  }

  /** 实际调用技能：返回完整 body 指令 */
  loadBody(key: string): string | null {
    return this.skills.get(key)?.body ?? null;
  }
}

/** 解析 SKILL.md：frontmatter + body */
export function parseSkill(key: string, path: string, raw: string): Skill | null {
  const fm = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  const body = fm ? raw.slice(fm[0].length) : raw;
  const meta: Record<string, unknown> = {};
  if (fm) {
    for (const line of fm[1].split("\n")) {
      const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
      if (m) meta[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  const name = String(meta.name ?? key);
  const description = String(meta.description ?? "");
  if (!description) return null;
  const requiresRaw = typeof meta.requires === "string" ? meta.requires : "";
  const requires = requiresRaw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return {
    key,
    name,
    description,
    path,
    body,
    enabled: meta.enabled !== "false",
    always: meta.always === "true" || meta.always === true,
    requires: requires.length ? requires : undefined,
    owner: meta.owner ? String(meta.owner) : undefined,
  };
}

/** Skill → SKILL.md（frontmatter 单行值，描述里的换行折成空格） */
export function serializeSkill(s: Skill): string {
  const fm = [
    `name: ${s.name}`,
    `description: ${s.description}`,
    s.owner ? `owner: ${s.owner}` : "",
    s.enabled === false ? "enabled: false" : "",
    s.always ? "always: true" : "",
    s.requires?.length ? `requires: [${s.requires.join(", ")}]` : "",
  ].filter(Boolean).join("\n");
  return `---\n${fm}\n---\n${s.body.startsWith("\n") ? s.body.slice(1) : s.body}`;
}

export interface SkillDraft {
  name: string;
  description: string;
  body: string;
}

/** 一句话 → 用模型写完整技能（Grok 六段）；模型输出不可用时返回 null */
export async function draftSkillWithAI(
  text: string,
  complete: (req: { system: string; user: string }) => Promise<{ text: string }>,
  tools?: string,
): Promise<SkillDraft | null> {
  const r = await complete({
    system: `你是 bot 技能设计师。用户用一句话描述想要的技能，你把它写成一份 bot 能直接照做的技能说明书（对齐 Grok Bot）。只输出 JSON，不要其他文字：
{"name":"技能名（2-8 个字）","description":"一句话说明这个技能做什么、在什么情况下使用（bot 靠它决定何时调用，要写清触发场景）","body":"Markdown 指令正文"}
${GROK_SKILL_BODY_GUIDE}
不要照抄用户原话，要补全成可执行的流程。${tools ? `\nbot 可用的工具：\n${tools}` : ""}`,
    user: text,
  });
  const raw = r.text.match(/\{[\s\S]*\}/)?.[0];
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Partial<SkillDraft>;
    const name = String(j.name ?? "").trim();
    const description = String(j.description ?? "").replace(/\s*\n\s*/g, " ").trim();
    const body = String(j.body ?? "").trim();
    if (!name || !description || !body) return null;
    return { name, description, body: ensureGrokSkillBody(name, body, { description }) };
  } catch {
    return null;
  }
}

/** 内置技能模板（Grok 六段骨架） */
export const BUILTIN_SKILL_TEMPLATES: Record<string, string> = {
  "web-search": `---
name: 网页搜索
description: 搜索网页获取最新信息。当用户问新闻、最新数据或需要查资料时使用。
requires: [curl]
---
# 网页搜索

## 何时使用
- 用户问新闻、最新数据，或需要查公开网页资料时。

## 所需输入与权限
- 搜索关键词或问题表述。
- 工具：curl / web.search / web.fetch；无需登录态。

## 工作步骤
1. 用 curl 或 web.search 请求可用的搜索接口（如 DuckDuckGo HTML）。
2. 从返回中提取标题与摘要；必要时 web.fetch 打开关键来源。
3. 用中文总结，附来源链接。

## 如何验收
- 至少有一条带来源的要点；链接可打开；没有结果时明确说没搜到，不要编造。

## 交回什么
- 中文摘要 + 来源列表（标题与 URL）；需要落盘时再写入用户指定路径。

## 需要批准
- 只读公开网页无需批准。
- 不要在搜索词或落盘路径里写入密钥；对外发送摘要前先征得用户同意。
`,
  "file-ops": `---
name: 文件操作
description: 读写本机文件。当用户要求保存笔记、读取文件或整理文档时使用。
requires: []
---
# 文件操作

## 何时使用
- 用户要求保存笔记、读取文件或整理本机文档时。

## 所需输入与权限
- 目标路径与操作意图（读 / 写 / 整理）。
- 路径必须在已授权/白名单目录内。

## 工作步骤
1. 确认路径在授权目录内。
2. 保存：把文本写入指定路径；读取：读出并总结；整理：按用户规则归类后回报变更。
3. 写操作前若会覆盖已有文件，先说明再继续。

## 如何验收
- 读：能复述关键内容要点；写：文件存在且内容符合约定；路径越界则拒绝并说明。

## 交回什么
- 操作结果摘要；写入时给出可点击的文件引用。

## 需要批准
- 只操作授权目录；删除或覆盖重要文件前先征得用户同意。
- 不要把密钥写进文件或技能正文。
`,
  "daily-report": `---
name: 日报模板
description: 整理或撰写工作日报。用户说「写日报 / 今日总结」时使用。
always: false
---
# 日报模板

## 何时使用
- 用户说「写日报 / 今日总结」或例行到点整理当日工作时。

## 所需输入与权限
- 今日完成、进行中、风险/阻塞、明日计划；不全时用 ui.form 收集。
- 可选：落盘路径、是否 notify。

## 工作步骤
1. 信息不全则 ui.form 收集四项。
2. 按固定结构写 Markdown：完成 / 进行中 / 风险 / 明日。
3. 需要落盘则写入指定路径；需要通知则 notify。

## 如何验收
- 四段齐全；没有编造未确认事项；缺信息已标出「待确认」。

## 交回什么
- 日报 Markdown；若落盘则附文件引用；若通知则说明已发。

## 需要批准
- 对外发送日报（邮件 / 群 / webhook）前先征得用户同意。
- 不要编造业绩或未发生的事项。
`,
  "triage": `---
name: 分诊模板
description: 把用户需求分到合适的 bot 或阶段。用户说「分诊 / 谁来处理」时使用。
---
# 分诊模板

## 何时使用
- 用户说「分诊 / 谁来处理」，或需求需要分配负责人时。

## 所需输入与权限
- 需求原文与约束；可选团队成员列表。
- 工具：ui.ask / bot.ask / 群聊 @。

## 工作步骤
1. 用一句话复述需求与约束。
2. 列出候选负责人及理由；必要时 ui.ask 让用户选。
3. 简单任务 bot.ask；需要多人同场则群聊 @ / 交接。

## 如何验收
- 有明确负责人、下一步、更新时间；用户可反对改派。

## 交回什么
- 回执：谁负责、下一步是什么、何时更新。

## 需要批准
- 对外升级（找客户 / 发公告）前先征得用户同意。
- 不要在未确认时假装已交接完成。
`,
  "research-write": `---
name: 调研→写作
description: 先调研再成文。用户说「调研后写报告 / 竞品分析成文」时使用。
---
# 调研→写作

## 何时使用
- 用户说「调研后写报告 / 竞品分析成文」或需要先查再写时。

## 所需输入与权限
- 主题、受众、篇幅；缺信息用 ui.form。
- 工具：web.search / web.fetch；可选委派调研 bot。

## 工作步骤
1. 明确主题、受众、篇幅。
2. 收集要点与来源。
3. 列提纲，确认后写成完整文稿；引用用 [n] 并附来源。
4. 可 bot.ask 调研 → 写作接力，或群里 @ 交接；不要假装云端并行屏幕。

## 如何验收
- 文稿有提纲对应结构；关键断言有来源；无来源处标「待核实」。

## 交回什么
- 完整文稿 + 来源列表；需要落盘则写入指定路径。

## 需要批准
- 对外发布或发给客户前先征得用户同意。
- 不要把付费墙后的原文整页粘贴进公开交付物。
`,
  "morning-briefing": `---
name: 晨间简报
description: 主控汇总各 bot 例行成败、待批准与今日要点。用户说「早报 / 大家怎样了 / 晨间简报」或例行到点时使用。
---
# 晨间简报

## 何时使用
- 用户要早报、问「大家怎样了」，或主控例行到点汇总时。

## 所需输入与权限
- task.list / bot.list / memory.search；可选 bot.ask 各专责 bot。
- 主控角色；不要冒充其他 bot 发外部消息。

## 工作步骤
1. task.list 看启用中的例行：失败、暂停（含离开暂停）、待跑。
2. 若有待批准/停在批准点的事项，列清单。
3. 必要时 bot.ask 关键 bot 要一句状态（短问）。
4. 写成短简报：今日重点 / 风险 / 待你拍板。

## 如何验收
- 有来源（例行名或 bot 名）；失败写明原因；没有新数据就说没有，不编造。

## 交回什么
- 一段中文简报（可用条目）；需要落盘再写文件。

## 需要批准
- 简报只写给用户对话；对外发送或替别人发消息前先征得同意。
`,
};
