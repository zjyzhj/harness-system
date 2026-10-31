import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, rmSync } from "node:fs";
import { writeFileAtomic } from "./atomic-fs";
import { join, basename } from "node:path";
import type { Skill } from "./types";

/**
 * 技能注册表 — 对标 CowAgent agent/skills/ 与 DeepSeek-Harness .agents/skills/
 * 规范：
 *   skills/<key>/SKILL.md
 *   frontmatter: ---\nname, description, always?, requires?\n---
 *   body: 指令正文（渐进披露：默认只注入 description，调用时才注入 body）
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

  /** 某个 bot 能用的技能：共享技能 + 它自己的私有技能 */
  visibleTo(botId?: string): Skill[] {
    return this.list().filter((s) => !s.owner || s.owner === botId);
  }

  /** 新建或更新技能（表单式）：key 不给则按名称生成 */
  save(input: { key?: string; name: string; description: string; body: string; owner?: string; enabled?: boolean }): Skill {
    const name = input.name.trim();
    const description = input.description.replace(/\s*\n\s*/g, " ").trim();
    if (!name || !description) throw new Error("技能需要名称和描述");
    const key = input.key && this.skills.has(input.key) ? input.key : this.uniqueKey(input.key || name);
    const prev = this.skills.get(key);
    const skill: Skill = {
      key, name, description, body: input.body, path: join(this.skillsDir, key, "SKILL.md"),
      enabled: input.enabled ?? prev?.enabled ?? true, always: prev?.always, requires: prev?.requires,
      owner: input.owner || undefined,
    };
    this.write(skill);
    return skill;
  }

  get(key: string): Skill | null {
    return this.skills.get(key) ?? null;
  }

  /** 创建技能：传入目录名 + SKILL.md 内容（可含 frontmatter），自动落盘 */
  create(key: string, markdown: string): Skill {
    const dir = join(this.skillsDir, key);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "SKILL.md");
    writeFileAtomic(path, markdown);
    const skill = parseSkill(key, path, markdown);
    if (!skill) throw new Error(`技能 ${key} 格式无效（需要 frontmatter 含 name/description）`);
    this.skills.set(key, skill);
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

  /** 给 LLM 的工具描述（渐进披露：只有 description + requires）；传 botId 时只列它能用的 */
  toolDescriptions(botId?: string): string {
    return (botId === undefined ? this.list() : this.visibleTo(botId))
      .filter((s) => s.enabled)
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

/** 一句话 → 用模型写完整技能（名称 / 触发描述 / 分步指令）；模型输出不可用时返回 null */
export async function draftSkillWithAI(
  text: string,
  complete: (req: { system: string; user: string }) => Promise<{ text: string }>,
  tools?: string,
): Promise<SkillDraft | null> {
  const r = await complete({
    system: `你是 bot 技能设计师。用户用一句话描述想要的技能，你把它写成一份 bot 能直接照做的技能说明书。只输出 JSON，不要其他文字：
{"name":"技能名（2-8 个字）","description":"一句话说明这个技能做什么、在什么情况下使用（bot 靠它决定何时调用，要写清触发场景）","body":"Markdown 指令正文"}
body 要求：以「# 技能名」开头；写清目标、分步骤做法、输出格式、注意事项；需要时说明用哪些工具；不要照抄用户原话，要补全成可执行的流程。${tools ? `\nbot 可用的工具：\n${tools}` : ""}`,
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
    return { name, description, body: `${body}\n` };
  } catch {
    return null;
  }
}

/** 内置技能模板：一句话创建技能时用的几个兜底 */
export const BUILTIN_SKILL_TEMPLATES: Record<string, string> = {
  "web-search": `---
name: 网页搜索
description: 搜索网页获取最新信息。当用户问新闻、最新数据或需要查资料时使用。
requires: [curl]
---
# 网页搜索技能

当被要求搜索时，按以下步骤执行：
1. 用 curl 请求一个可用的搜索接口（如 DuckDuckGo HTML）。
2. 从返回的 HTML 中提取标题与摘要。
3. 用中文总结结果，附来源链接。
`,
  "file-ops": `---
name: 文件操作
description: 读写本机文件。当用户要求保存笔记、读取文件或整理文档时使用。
requires: []
---
# 文件操作技能

- 保存内容：把文本写入用户指定的路径（需在白名单目录内）。
- 读取内容：读取指定文件并总结。
- 注意路径安全，只操作授权目录。
`,
  "daily-report": `---
name: 日报模板
description: 整理或撰写工作日报。用户说「写日报 / 今日总结」时使用。
always: false
---
# 日报流程

1. 若信息不全，用 ui.form 收集：今日完成、进行中、风险/阻塞、明日计划。
2. 按固定结构输出 Markdown：完成 / 进行中 / 风险 / 明日。
3. 需要落盘时写入用户指定路径；需要通知时用 notify。
4. 不要编造未确认的事项。
`,
  "triage": `---
name: 分诊模板
description: 把用户需求分到合适的 bot 或阶段。用户说「分诊 / 谁来处理」时使用。
---
# 分诊流程

1. 用一句话复述需求与约束。
2. 列出候选负责人（团队成员）及理由；必要时 ui.ask 让用户选。
3. 简单任务用 bot.ask；3 步以上或要后台跑用 plan.start。
4. 回执：谁负责、下一步是什么、何时更新。
`,
  "research-write": `---
name: 调研→写作
description: 先调研再成文。用户说「调研后写报告 / 竞品分析成文」时使用。
---
# 调研→写作流程

1. 明确主题、受众、篇幅；缺信息用 ui.form。
2. 用 web.search / web.fetch（或委派调研 bot）收集要点与来源。
3. 列出提纲，确认后写成完整文稿，引用用 [n] 并附来源。
4. 可用 plan.start：调研 bot → 写作 bot 接力；不要假装云端并行屏幕。
`,
};
