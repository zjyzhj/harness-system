import { describe, expect, test } from "bun:test";
import { buildActionGroundingFacts, parseVerdict, ACTION_GROUNDING_SYSTEM, shouldActionGround } from "../core/runtime/turn-helpers";

describe("actionGrounding facts（模型判断，无词表）", () => {
  test("shouldActionGround：闲聊跳过，高风险工具或长收尾才跑", () => {
    expect(shouldActionGround("好的", [], [])).toBe(false);
    expect(shouldActionGround("已经在 Cursor 里把登录逻辑改好了，你刷新看看。", [], [])).toBe(true);
    expect(shouldActionGround("我去改", ["cli.agent"], [])).toBe(true);
    expect(shouldActionGround("先列目录", ["fs.list"], [])).toBe(false);
  });

  test("未开终端 + 无工具时事实写清楚", () => {
    const facts = buildActionGroundingFacts({ toolsThisRound: [], priorTools: [], terminal: null });
    expect(facts).toContain("本轮即将调用的工具：（无）");
    expect(facts).toContain("终端现状：未打开或已退出");
    expect(facts).toContain("点「打开」或 term.open 只起 shell");
  });

  test("shell 开着 ≠ Coding CLI", () => {
    const facts = buildActionGroundingFacts({
      toolsThisRound: ["term.open"],
      priorTools: [],
      terminal: { phase: "idle", program: "shell", cli: "shell", cwd: "/tmp/demo" },
    });
    expect(facts).toContain("shell 开着");
    expect(facts).toContain("/tmp/demo");
    expect(facts).not.toContain("Coding CLI 开着");
  });

  test("agent 活着时标明 CLI", () => {
    const facts = buildActionGroundingFacts({
      toolsThisRound: [],
      priorTools: ["cli.agent"],
      terminal: { phase: "busy", program: "agent", cli: "cursor", cwd: "/repo" },
    });
    expect(facts).toContain("Coding CLI 开着（cursor）");
    expect(facts).toContain("cli.agent");
  });

  test("系统提示要求只出 JSON 判决", () => {
    expect(ACTION_GROUNDING_SYSTEM).toContain("{\"ok\":true}");
    expect(ACTION_GROUNDING_SYSTEM).toContain("提议、询问、计划、假设不算违规");
  });

  test("parseVerdict 与 selfCheck 同格式", () => {
    expect(parseVerdict('{"ok":true}')).toEqual({ ok: true, issues: [] });
    expect(parseVerdict('废话 {"ok":false,"issues":["空口说进了 Cursor"]} 尾')).toEqual({
      ok: false,
      issues: ["空口说进了 Cursor"],
    });
  });

  test("parseVerdict 解析失败：默认放行，failClosed 拒", () => {
    expect(parseVerdict("不是 json")).toEqual({ ok: true, issues: [] });
    expect(parseVerdict("不是 json", { failClosed: true })).toEqual({
      ok: false,
      issues: ["核对结果无法解析"],
    });
  });
});
