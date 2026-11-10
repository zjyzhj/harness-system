import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureGrokSkillBody,
  hasGrokSkillShape,
  missingSkillSections,
  presentSkillSections,
  grokSkillSkeleton,
} from "../core/skill-norm";
import { SkillRegistry, BUILTIN_SKILL_TEMPLATES, parseSkill } from "../core/skill-registry";
import { SKILL_RULES_HEADING } from "../core/runtime/rules-text";

describe("Grok skill 六段规范", () => {
  test("空正文 → 六段骨架", () => {
    const body = grokSkillSkeleton("周报", "每周五整理本周工作");
    expect(hasGrokSkillShape(body)).toBe(true);
    expect(body).toContain("## 何时使用");
    expect(body).toContain("每周五整理本周工作");
    expect(missingSkillSections(body)).toEqual([]);
  });

  test("无结构旧稿迁入工作步骤并补齐其余段", () => {
    const body = ensureGrokSkillBody("截图规范", "# 截图规范\n\n- 尺寸 1320×2868\n- 不要加框\n", {
      description: "生成商店截图时使用",
    });
    expect(hasGrokSkillShape(body)).toBe(true);
    expect(body).toContain("## 工作步骤");
    expect(body).toContain("1320×2868");
    expect(body).toContain("## 需要批准");
    expect(presentSkillSections(body)).toHaveLength(6);
  });

  test("已有部分小节只补缺段，保留原文", () => {
    const body = ensureGrokSkillBody(
      "分诊",
      `# 分诊\n\n## 工作步骤\n1. 复述需求\n\n## 需要批准\n- 对外升级先问我\n`,
      { description: "分诊谁来处理" },
    );
    expect(body).toContain("1. 复述需求");
    expect(body).toContain("对外升级先问我");
    expect(body).toContain("## 如何验收");
    expect(hasGrokSkillShape(body)).toBe(true);
  });

  test("用户补充的规范留在文末", () => {
    const body = ensureGrokSkillBody(
      "日报",
      `# 日报\n\n随便写两句\n\n${SKILL_RULES_HEADING}\n- 用中文（2026-01-01）\n`,
      { description: "写日报" },
    );
    expect(hasGrokSkillShape(body)).toBe(true);
    const rulesAt = body.indexOf(SKILL_RULES_HEADING);
    const approvalAt = body.indexOf("## 需要批准");
    expect(rulesAt).toBeGreaterThan(approvalAt);
    expect(body).toContain("用中文");
  });

  test("save / create 自动补齐六段", () => {
    const home = mkdtempSync(join(tmpdir(), "harness-skill-norm-"));
    const skills = new SkillRegistry(join(home, "skills"));
    const sk = skills.save({
      name: "商店图",
      description: "生成商店截图时使用",
      body: "# 商店图\n\n- 1320×2868\n",
      owner: "b1",
    });
    expect(hasGrokSkillShape(sk.body)).toBe(true);
    expect(sk.body).toContain("1320×2868");

    const created = skills.create(
      "loose-skill",
      "---\nname: 松散\ndescription: 测 create\n---\n# 松散\n\n做点事\n",
    );
    expect(hasGrokSkillShape(created.body)).toBe(true);
  });

  test("内置模板均已是六段", () => {
    for (const [key, md] of Object.entries(BUILTIN_SKILL_TEMPLATES)) {
      const s = parseSkill(key, key, md);
      expect(s).toBeTruthy();
      expect(missingSkillSections(s!.body), key).toEqual([]);
    }
  });
});
