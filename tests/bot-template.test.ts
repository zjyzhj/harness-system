import { describe, expect, test } from "bun:test";
import { normalizeTemplate, parseTemplate, templateLink, templateOf, uniqueBotName } from "../core/bot-template";
import type { Bot } from "../core/types";

const bot: Bot = {
  id: "b1", name: "商店图专家", role: "出商店截图", persona: "严谨、讲规范", providerId: "p-secret", model: "deepseek-chat",
  systemPrompt: "你是商店图专家", petEnabled: true, createdAt: 1, isMaster: true,
};
const skills = [{ name: "截图规范", description: "生成商店截图时使用", body: "# 规范\n- 1320×2868" }];

describe("bot 模板分享", () => {
  test("链接往返：设定和技能都在，模型 / 主控 / 宠物开关不带出去", () => {
    const link = templateLink(templateOf(bot, skills, "data:image/jpeg;base64,AAAA"));
    expect(link).toStartWith("harnessbot://bot/");
    const t = parseTemplate(link);
    expect(t).toMatchObject({ name: "商店图专家", role: "出商店截图", persona: "严谨、讲规范", systemPrompt: "你是商店图专家", skills, avatar: "data:image/jpeg;base64,AAAA" });
    expect(JSON.stringify(t)).not.toContain("p-secret");
    expect(JSON.stringify(t)).not.toContain("isMaster");
  });

  test("裸 code、带换行的链接、模板 JSON 文件内容都能认", () => {
    const link = templateLink(templateOf(bot, []));
    const code = link.replace("harnessbot://bot/", "");
    expect(parseTemplate(code).name).toBe("商店图专家");
    expect(parseTemplate(`${link.slice(0, 30)}\n${link.slice(30)}`).name).toBe("商店图专家");
    expect(parseTemplate(JSON.stringify(templateOf(bot, skills))).skills).toHaveLength(1);
  });

  test("坏链接 / 别的 JSON / 可疑字段给出可读的错误或被丢掉", () => {
    expect(() => parseTemplate("harnessbot://bot/abc$%")).toThrow("链接格式不对");
    expect(() => parseTemplate("harnessbot://bot/AAAAAAAA")).toThrow("链接不完整");
    expect(() => parseTemplate('{"hello":1}')).toThrow("不是 Harness Bot");
    const t = normalizeTemplate({ v: 1, name: "x", avatar: "javascript:alert(1)", providerId: "evil", skills: [{ name: "", description: "d" }, { name: "k", description: "d", body: 3 }] });
    expect(t.avatar).toBeUndefined();
    expect((t as any).providerId).toBeUndefined();
    expect(t.skills).toEqual([{ name: "k", description: "d", body: "" }]);
  });

  test("重名自动加编号", () => {
    expect(uniqueBotName("A", ["B"])).toBe("A");
    expect(uniqueBotName("A", ["A", "A 2"])).toBe("A 3");
    expect(uniqueBotName("A 2", ["A", "A 2"])).toBe("A 3");
  });
});
