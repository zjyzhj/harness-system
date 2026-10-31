import { describe, expect, test } from "bun:test";
import {
  collectNeeds,
  diffNeeds,
  extractFromSkills,
  hasHardGaps,
  hasNeeds,
  onboardGreeting,
  onboardPromptSection,
} from "../core/bot-share-needs";
import { normalizeTemplate, parseTemplate, templateLink, templateOf } from "../core/bot-template";
import type { Bot } from "../core/types";

const bot: Bot = {
  id: "b1",
  name: "飞书助手",
  role: "发消息",
  persona: "靠谱",
  providerId: "p-secret",
  systemPrompt: "你是飞书助手",
  petEnabled: false,
  createdAt: 1,
};

describe("bot-share-needs 抽取", () => {
  test("从技能正文抽出 secret / $ENV / requires / mcp / skill 引用", () => {
    const r = extractFromSkills([
      {
        name: "发飞书",
        description: "发消息",
        body: "用 {{secret:FEISHU_TOKEN}} 调 $FEISHU_APP_ID，也可 mcp:feishu/send。规范见 [共享](app:skill/shared-style)",
        requires: ["curl"],
      },
    ]);
    expect(r.secretNames).toEqual(["FEISHU_TOKEN"]);
    expect(r.envKeys).toContain("FEISHU_APP_ID");
    expect(r.commands).toEqual(["curl"]);
    expect(r.mcpIds).toContain("feishu");
    expect(r.skillRefs).toContain("shared-style");
  });

  test("collectNeeds 合并 Vault 元数据且不带 value", () => {
    const needs = collectNeeds({
      privateSkills: [
        {
          name: "发飞书",
          description: "发",
          body: "token={{secret:FEISHU_TOKEN}} base=$BASE_URL",
          requires: ["curl"],
        },
      ],
      sharedSkills: [{ key: "shared-style", name: "共享文风", description: "统一语气", body: "#" }],
      vault: {
        secrets: [{ name: "FEISHU_TOKEN", label: "飞书 Token", note: "机器人" }],
        env: [{ key: "BASE_URL", label: "接口根" }],
        mcp: [{ id: "feishu", name: "飞书 MCP" }],
      },
      ownedSecrets: [{ name: "EXTRA_KEY", label: "额外" }],
    });
    expect(needs.secrets).toEqual([
      { name: "FEISHU_TOKEN", label: "飞书 Token", note: "机器人" },
      { name: "EXTRA_KEY", label: "额外" },
    ]);
    expect(needs.env[0]).toMatchObject({ key: "BASE_URL", label: "接口根" });
    expect(needs.commands).toEqual(["curl"]);
    expect(JSON.stringify(needs)).not.toContain("sk-");
    expect(JSON.stringify(needs)).not.toContain("value");
  });

  test("diffNeeds：本机已有则进 present，缺的进 missing", () => {
    const needs = collectNeeds({
      privateSkills: [{ name: "x", description: "d", body: "{{secret:API_A}} $BASE_URL {{secret:API_C}}" }],
    });
    const diff = diffNeeds(needs, { secretNames: ["API_A"], envKeys: [] });
    expect(diff.present.secrets.map((s) => s.name)).toEqual(["API_A"]);
    expect(diff.missing.secrets.map((s) => s.name)).toEqual(["API_C"]);
    expect(diff.missing.env.map((e) => e.key)).toEqual(["BASE_URL"]);
    expect(hasHardGaps(diff)).toBe(true);
  });

  test("开箱文案与 prompt 含缺口、不含密钥值", () => {
    const needs = { secrets: [{ name: "TOK", label: "令牌" }], env: [{ key: "URL" }] };
    const diff = diffNeeds(needs, { secretNames: [], envKeys: ["URL"] });
    const greet = onboardGreeting("助手", needs, diff);
    expect(greet).toContain("TOK");
    expect(greet).toContain("还缺这些");
    expect(greet).toContain("已有");
    const section = onboardPromptSection(diff);
    expect(section).toContain("ui.secret");
    expect(section).toContain("TOK");
    expect(section).not.toContain("sk-live");
  });
});

describe("BotTemplate v2 needs 往返", () => {
  test("v2 链接含 needs，无 provider / 密钥值", () => {
    const needs = collectNeeds({
      privateSkills: [{ name: "k", description: "d", body: "用 {{secret:API_KEY}} 和 $HOST" }],
      vault: { secrets: [{ name: "API_KEY", label: "Key" }], env: [{ key: "HOST", note: "主机" }] },
    });
    const t = templateOf(bot, [{ name: "k", description: "d", body: "用 {{secret:API_KEY}} 和 $HOST" }], undefined, needs);
    expect(t.v).toBe(2);
    expect(hasNeeds(t.needs)).toBe(true);
    const link = templateLink(t);
    const back = parseTemplate(link);
    expect(back.v).toBe(2);
    expect(back.needs?.secrets).toEqual([{ name: "API_KEY", label: "Key" }]);
    expect(back.needs?.env?.[0]).toMatchObject({ key: "HOST", note: "主机" });
    expect(JSON.stringify(back)).not.toContain("p-secret");
    expect(JSON.stringify(back)).not.toMatch(/sk-|password|apiKey/i);
  });

  test("v1 旧模板仍可导入，needs 为空", () => {
    const raw = {
      v: 1 as const,
      name: "老模板",
      role: "r",
      persona: "p",
      skills: [{ name: "k", description: "d", body: "{{secret:X}}" }],
    };
    const t = normalizeTemplate(raw);
    expect(t.v).toBe(1);
    expect(t.needs).toBeUndefined();
    expect(t.skills[0].body).toContain("{{secret:X}}");
  });

  test("normalize 丢掉 needs 里的可疑字段与非法名", () => {
    const t = normalizeTemplate({
      v: 2,
      name: "x",
      role: "r",
      persona: "p",
      skills: [],
      needs: {
        secrets: [
          { name: "OK_KEY", label: "好", value: "secret-value" },
          { name: "bad name", label: "坏" },
        ],
        env: [{ key: "HOST", value: "https://evil", hint: "填接口" }],
      },
    });
    expect(t.needs?.secrets).toEqual([{ name: "OK_KEY", label: "好" }]);
    expect(t.needs?.env).toEqual([{ key: "HOST", hint: "填接口" }]);
    expect(JSON.stringify(t.needs)).not.toContain("secret-value");
    expect(JSON.stringify(t.needs)).not.toContain("https://evil");
  });
});
