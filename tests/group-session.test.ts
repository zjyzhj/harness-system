/**
 * GroupSessionRunner：编排下沉后的薄集成测试（不调真实模型）
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import { GroupRegistry } from "../core/group-registry";
import { ProviderCenter } from "../core/provider-center";
import { GroupSessionRunner } from "../core/group-session";
import type { Bot, ContentBlock } from "../core/types";

function bot(id: string, name: string, extra: Partial<Bot> = {}): Bot {
  return { id, name, systemPrompt: "", providerId: "p", createdAt: 0, ...extra } as Bot;
}

describe("GroupSessionRunner", () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-"));
  const store = new Store(dir);
  const groups = new GroupRegistry(dir);
  const providers = new ProviderCenter(store);
  store.saveBot(bot("m", "主控", { isMaster: true }));
  store.saveBot(bot("w", "写作助手"));
  const g = groups.create("测试群", "user", ["m", "w"]);
  groups.update(g.id, { settings: { moderator: "m", maxTurns: 4, relay: true } });

  const spoken: string[] = [];
  const runtime = {
    handleStream: async (req: { bot: Bot; text: string }, opts: { onBlock: (b: ContentBlock) => void }) => {
      spoken.push(`${req.bot.id}:${req.text.slice(0, 40)}`);
      const text = req.bot.id === "m" && !req.text.includes("主持")
        ? "先定方向，@写作助手 你来写大纲 【讨论结束】"
        : "大纲好了";
      opts.onBlock({ type: "text", text });
      return { text, content: [{ type: "text", text }] };
    },
  };

  const runner = new GroupSessionRunner({ store, groups, runtime: runtime as any, providers });

  test("chat：接力发言 + 进度回调，IPC 无关", async () => {
    const progress: string[] = [];
    const streams: string[] = [];
    const r = await runner.chat(g.id, "一起写一篇文章", undefined, {
      onProgress: (p) => progress.push(p.state),
      onStream: (ev) => streams.push(`${ev.botId}:${ev.turn}`),
      setRunning: () => {},
      setIdle: () => {},
    });
    expect(r.ok).toBe(true);
    expect(r.turns).toBeGreaterThanOrEqual(2);
    expect(spoken.some((s) => s.startsWith("m:"))).toBe(true);
    expect(spoken.some((s) => s.startsWith("w:"))).toBe(true);
    expect(progress).toContain("running");
    expect(progress).toContain("done");
    expect(streams.length).toBeGreaterThan(0);
    // 用户消息落盘一次
    expect(store.listMessages(r.sessionId).some((m) => m.role === "user")).toBe(true);
  });

  test("interject：无进行中会话时拒绝", () => {
    expect(runner.interject(g.id, "no-such", "插一句")).toEqual({ ok: false });
  });

  test("dispatch：结论卡片任务依次执行", async () => {
    const sid = `group-${g.id}-d`;
    store.addMessage({
      sessionId: sid, from: "m", to: "user", role: "assistant", kind: "chat", createdAt: Date.now(),
      content: [{ type: "conclusion", summary: "定了", decisions: [], tasks: [{ owner: "写作助手", ownerId: "w", task: "写大纲" }], open: [] }],
      meta: { tag: "conclusion" },
    });
    const msgId = store.listMessages(sid).at(-1)!.id!;
    spoken.length = 0;
    const r = await runner.dispatch(g.id, sid, msgId, [0], {
      onProgress: () => {},
      onStream: () => {},
      setRunning: () => {},
      setIdle: () => {},
    });
    expect(r.ok).toBe(true);
    expect(r.count).toBe(1);
    expect(spoken.some((s) => s.startsWith("w:") && s.includes("分派"))).toBe(true);
  });

  // cleanup last
  test("cleanup", () => { rmSync(dir, { recursive: true, force: true }); });
});
