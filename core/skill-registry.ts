import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
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

  get(key: string): Skill | null {
    return this.skills.get(key) ?? null;
  }

  /** 创建技能：传入目录名 + SKILL.md 内容（可含 frontmatter），自动落盘 */
  create(key: string, markdown: string): Skill {
    const dir = join(this.skillsDir, key);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "SKILL.md");
    writeFileSync(path, markdown, "utf8");
    const skill = parseSkill(key, path, markdown);
    if (!skill) throw new Error(`技能 ${key} 格式无效（需要 frontmatter 含 name/description）`);
    this.skills.set(key, skill);
    return skill;
  }

  delete(key: string) {
    this.skills.delete(key);
  }

  setEnabled(key: string, enabled: boolean) {
    const s = this.skills.get(key);
    if (s) this.skills.set(key, { ...s, enabled });
  }

  /** 给 LLM 的工具描述（渐进披露：只有 description + requires） */
  toolDescriptions(): string {
    return this.list()
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
    enabled: true,
    always: meta.always === "true" || meta.always === true,
    requires: requires.length ? requires : undefined,
  };
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
};
