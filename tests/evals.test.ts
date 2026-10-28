import { describe, test, expect } from "bun:test";
import { checkReply, defaultScenarios, parseJudge, runEvals, reportMarkdown } from "../core/evals";

const facts = { bots: ["灵感助手", "写作助手", "翻译助手", "代码助手"], master: "灵感助手", groups: [{ name: "测试", members: ["灵感助手", "写作助手"] }] };

describe("评测集", () => {
  test("场景按真实数据生成期望", () => {
    const sc = defaultScenarios(facts);
    expect(sc.find((s) => s.id === "state-groups")!.checks[0]).toMatchObject({ kind: "text", any: ["测试"] });
    expect(sc.find((s) => s.id === "delegate-real")!.prompt).toContain("翻译助手");
  });

  test("规则检查：工具参数、占位消息、复述密钥", async () => {
    const sc = defaultScenarios(facts);
    const relay = sc.find((s) => s.id === "relay-sequential")!;
    const bad = await checkReply(relay, { text: "好了", latencyMs: 1, toolCalls: [
      { id: "1", tool: "bot.ask", args: { to: "写作助手", message: "写口号" } },
      { id: "2", tool: "bot.ask", args: { to: "翻译助手", message: "稍等，拿到后发你" } },
    ] });
    expect(bad.map((c) => c.pass)).toEqual([true, false]);
    const secret = sc.find((s) => s.id === "secret-safe")!;
    const leak = await checkReply(secret, { text: "已保存 sk-test-1234567890abcdef", latencyMs: 1, toolCalls: [] });
    expect(leak.find((c) => c.label.includes("复述"))!.pass).toBe(false);
  });

  test("评审输出解析和报告汇总", async () => {
    expect(parseJudge('好的 {"pass": true, "reason": "ok"}')).toEqual({ pass: true, reason: "ok" });
    expect(parseJudge("乱码").pass).toBe(false);
    const sc = defaultScenarios(facts).filter((s) => s.id === "state-team" || s.id === "web-fresh");
    const report = await runEvals(sc, async (_p, o) => o.sessionKey.startsWith("state-team")
      ? { text: "有写作助手、翻译助手", toolCalls: [], latencyMs: 1000 }
      : { text: "不知道", toolCalls: [], latencyMs: 3000 }, { model: "m" });
    expect(report.passed).toBe(1);
    expect(report.avgLatencyMs).toBe(2000);
    expect(reportMarkdown(report)).toContain("| 联网 | 0/1 |");
  });
});
