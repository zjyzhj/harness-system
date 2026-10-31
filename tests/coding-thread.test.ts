import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentCliArgs } from "../core/cli-agent";
import {
  CodingThreadStore,
  nextCodingThread,
  parseAgentOutput,
  shouldResume,
  threadBrief,
  threadStub,
} from "../core/coding-thread";

describe("编码工作线", () => {
  test("同 CLI 有会话号才续；once 新开；重新做在 auto 下新开", () => {
    expect(shouldResume({ task: "继续改按钮", sessionId: "s1" })).toBe(true);
    expect(shouldResume({ task: "继续", sessionId: undefined })).toBe(false);
    expect(shouldResume({ pref: "once", task: "继续", sessionId: "s1" })).toBe(false);
    expect(shouldResume({ pref: "auto", task: "这个功能重新做", sessionId: "s1" })).toBe(false);
    expect(shouldResume({ pref: "always", task: "重新做", sessionId: "s1" })).toBe(true);
  });

  test("聊天摘要不超过 400 字，工作线全文不超过 4KB", () => {
    const thread = nextCodingThread(undefined, {
      botId: "b",
      cwd: "/repo",
      cli: "cursor",
      task: "做导出",
      summary: "x".repeat(8000),
      sessionId: "c1",
    });
    expect(threadStub(thread).length).toBeLessThanOrEqual(400);
    expect(threadBrief(thread).length).toBeLessThanOrEqual(4096);
    expect(thread.sessions.cursor).toBe("c1");
    const kept = nextCodingThread(thread, {
      botId: "b",
      cwd: "/repo",
      cli: "claude",
      task: "继续",
      summary: "改了 a.ts",
      sessionId: "cl1",
      keepGoal: true,
    });
    expect(kept.goal).toBe("做导出");
    expect(kept.sessions.cursor).toBe("c1");
    expect(kept.sessions.claude).toBe("cl1");
  });

  test("从 json / jsonl 抽出正文和会话号；失败才算续不上", () => {
    const cursor = parseAgentOutput(JSON.stringify({ session_id: "chat-9", result: "改了按钮" }), 0);
    expect(cursor.sessionId).toBe("chat-9");
    expect(cursor.text).toBe("改了按钮");
    expect(cursor.resumeMissing).toBe(false);

    const codex = parseAgentOutput(
      ['{"type":"thread.started","thread_id":"th-1"}', '{"type":"item.completed","item":{"type":"agent_message","text":"完成"}}'].join("\n"),
      0,
    );
    expect(codex.sessionId).toBe("th-1");
    expect(codex.text).toContain("完成");

    const missing = parseAgentOutput("No conversation found for chat-9", 1);
    expect(missing.resumeMissing).toBe(true);
    expect(parseAgentOutput("No conversation found", 0).resumeMissing).toBe(false);
  });

  test("工作线按 bot+目录落盘", () => {
    const home = mkdtempSync(join(tmpdir(), "coding-thread-"));
    const store = new CodingThreadStore(home);
    store.save(nextCodingThread(undefined, { botId: "b", cwd: "/repo", cli: "cursor", task: "做导出", summary: "ok", sessionId: "c1" }));
    const again = new CodingThreadStore(home);
    expect(again.get("b", "/repo")?.sessions.cursor).toBe("c1");
    expect(again.get("b", "/other")).toBeUndefined();
  });

  test("续会话参数带自己的 id，不用 --continue / --last", () => {
    const cursor = agentCliArgs("cursor", "继续", "/repo", { resumeId: "chat-1" });
    expect(cursor).toContain("--resume");
    expect(cursor).toContain("chat-1");
    expect(cursor.join(" ")).not.toContain("--continue");

    const claude = agentCliArgs("claude", "继续", "/repo", { resumeId: "11111111-1111-1111-1111-111111111111" });
    expect(claude).toContain("--resume");
    expect(claude.join(" ")).not.toContain("--session-id");

    const fresh = agentCliArgs("claude", "新任务", "/repo", { createSessionId: "22222222-2222-2222-2222-222222222222" });
    expect(fresh).toContain("--session-id");
    expect(fresh.join(" ")).not.toContain("--resume");

    const codex = agentCliArgs("codex", "继续", "/repo", { resumeId: "th-1" });
    expect(codex.slice(0, 3)).toEqual(["exec", "resume", "th-1"]);
    expect(codex.join(" ")).not.toContain("--last");
  });
});
