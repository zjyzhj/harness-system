import { describe, expect, test, afterEach } from "bun:test";
import {
  buildCodingAgentArgs,
  cliAgentToolDescription,
  formatCodingAgentsPromptLine,
  invalidateCodingAgentsCache,
  listCodingAgentBackends,
  parseCodingAgentId,
  registerCodingAgent,
  resetCodingAgentExtrasForTests,
} from "../core/coding-agents";
import { agentCliArgs } from "../core/cli-agent";

afterEach(() => {
  resetCodingAgentExtrasForTests();
  invalidateCodingAgentsCache();
});

describe("coding-agents 注册表", () => {
  test("内置含可派工三家，参数与 cli-agent 一致", () => {
    const ids = listCodingAgentBackends().filter((b) => b.agent).map((b) => b.id);
    expect(ids).toContain("cursor");
    expect(ids).toContain("claude");
    expect(ids).toContain("codex");
    const c = buildCodingAgentArgs("cursor", "fix", "/repo");
    expect(c).toEqual(agentCliArgs("cursor", "fix", "/repo"));
    expect(c).toContain("--force");
  });

  test("registerCodingAgent 扩展后 parse / 工具说明跟上", () => {
    registerCodingAgent({
      id: "demo-agent",
      bin: "demo-agent-bin",
      label: "Demo",
      chat: false,
      agent: true,
      order: 5,
      buildAgentArgs: (p, cwd) => ["--cwd", cwd, p],
    });
    expect(parseCodingAgentId("demo-agent")).toBe("demo-agent");
    expect(buildCodingAgentArgs("demo-agent", "hi", "/x")).toEqual(["--cwd", "/x", "hi"]);
    const desc = cliAgentToolDescription([]);
    expect(desc).toContain("demo-agent");
  });

  test("提示词在无快照时不背死名单", () => {
    const line = formatCodingAgentsPromptLine([]);
    expect(line).toMatch(/尚未探测|实时探测/);
  });
});
