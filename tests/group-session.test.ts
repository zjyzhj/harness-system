/**
 * GroupSessionRunner：编排下沉后的薄集成测试（不调真实模型）
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import { GroupRegistry } from "../core/group-registry";
import { ProviderCenter } from "../core/provider-center";
import { GroupSessionRunner, pickGroupSession } from "../core/group-session";
import { contentText, type Bot, type ContentBlock } from "../core/types";

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
  let mTurns = 0;
  const runtime = {
    handleStream: async (req: { bot: Bot; text: string }, opts: { onBlock: (b: ContentBlock) => void }) => {
      spoken.push(`${req.bot.id}:${req.text.slice(0, 40)}`);
      const text = req.bot.id === "m" && !req.text.includes("你是本群主持人") && mTurns++ === 0
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
    // 结论阶段会短暂盖住 done；结束后必须再推 done，否则 UI 卡在「正在整理结论」
    if (progress.includes("conclusion")) {
      expect(progress.lastIndexOf("done")).toBeGreaterThan(progress.lastIndexOf("conclusion"));
    }
    expect(progress.at(-1)).toBe("done");
    expect(streams.length).toBeGreaterThan(0);
    // 用户消息落盘一次
    expect(store.listMessages(r.sessionId).some((m) => m.role === "user")).toBe(true);
  });

  test("interject：无进行中会话时拒绝", async () => {
    expect(await runner.interject(g.id, "no-such", "插一句")).toEqual({ ok: false });
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

describe("群聊：一段对话一轮接力", () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-live-"));
  const store = new Store(dir);
  const groups = new GroupRegistry(dir);
  const providers = new ProviderCenter(store);
  store.saveBot(bot("m", "主控", { isMaster: true }));
  store.saveBot(bot("w", "写作助手"));
  store.saveBot(bot("c", "代码助手"));
  const g = groups.create("另一间", "user", ["m", "w"]);
  groups.update(g.id, { settings: { moderator: "m", maxTurns: 6, relay: true } });
  const hooks = { onProgress: () => {}, onStream: () => {}, setRunning: () => {}, setIdle: () => {} };

  test("同一段再发是插话；另一段照常进行，不停掉这段", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let n = 0;
    const runtime = {
      handleStream: async (_req: { bot: Bot }, opts: { onBlock: (b: ContentBlock) => void }) => {
        if (n++ === 0) await gate;
        opts.onBlock({ type: "text", text: "好" });
        return { text: "好", content: [{ type: "text", text: "好" }] };
      },
    };
    const runner = new GroupSessionRunner({ store, groups, runtime: runtime as any, providers });
    const sid = `group-${g.id}-a`;
    const first = runner.chat(g.id, "先讨论", sid, hooks);
    await new Promise((r) => setTimeout(r, 30));
    const again = await runner.chat(g.id, "插一句", sid, hooks);
    expect(again.joined).toBe(true);
    expect(runner.isLive(sid)).toBe(true);
    const otherId = `group-${g.id}-b`;
    const other = await runner.chat(g.id, "另一段", otherId, hooks);
    expect(other.sessionId).toBe(otherId);
    expect(other.joined).toBeUndefined();
    expect(runner.isLive(sid)).toBe(true);
    release();
    await first;
    expect(runner.isLive(sid)).toBe(false);
  });

  test("还没开口就被移出的成员不再发言；主持人离开后不再小结", async () => {
    const said: string[] = [];
    const runtime = {
      handleStream: async (req: { bot: Bot; text: string }, opts: { onBlock: (b: ContentBlock) => void }) => {
        said.push(req.bot.id);
        if (req.bot.id === "m") {
          groups.leave(room.id, "w");
          groups.leave(room.id, "m");
        }
        const text = req.bot.id === "m" ? "@代码助手 你看" : "好";
        opts.onBlock({ type: "text", text });
        return { text, content: [{ type: "text", text }] };
      },
    };
    const room = groups.create("会离人的", "user", ["m", "w"]);
    groups.update(room.id, { settings: { moderator: "m", maxTurns: 6, relay: true } });
    const runner = new GroupSessionRunner({ store, groups, runtime: runtime as any, providers });
    await runner.chat(room.id, "开始", `group-${room.id}`, hooks);
    expect(said.filter((id) => id === "w")).toEqual([]);
    expect(said.filter((id) => id === "m")).toEqual(["m"]);
    expect(said).toContain("c");
  });

  test("关掉时停住的接力，再发一句从下一个人接着说", async () => {
    const sid = `group-${g.id}-hold`;
    writeFileSync(join(dir, "group-relays.json"), JSON.stringify({
      relays: [{
        sessionId: sid, groupId: g.id, status: "running",
        queue: [{ id: "w", by: "m" }], roundLeft: 1, round: 2, turns: 1, ending: false,
        seedText: "一起写一篇文章", userMsgId: 1, maxTurns: 4,
      }],
      boards: { [sid]: ["先写大纲"] },
    }));
    const spoken: string[] = [];
    const runner2 = new GroupSessionRunner({
      store, groups,
      runtime: { handleStream: async (req: { bot: Bot }, opts: { onBlock: (b: ContentBlock) => void }) => {
        spoken.push(req.bot.id);
        opts.onBlock({ type: "text", text: "接着写" });
        return { text: "接着写", content: [{ type: "text", text: "接着写" }] };
      } } as any,
      providers,
    });
    expect(runner2.peek(sid)?.next).toEqual(["写作助手"]);
    expect(runner2.boardOf(sid)).toEqual(["先写大纲"]);
    await runner2.chat(g.id, "@写作助手 接着", sid, { onProgress: () => {}, onStream: () => {}, setRunning: () => {}, setIdle: () => {} });
    expect(spoken[0]).toBe("w");
    expect(spoken.includes("m")).toBe(false);
  });

  test("正在看的那段优先于正在接力的和最近的", () => {
    expect(pickGroupSession("g", { gazed: "group-g-2", live: "group-g-1", sessions: [{ id: "group-g-9", updatedAt: 9 }] })).toBe("group-g-2");
    expect(pickGroupSession("g", { live: "group-g-1", sessions: [{ id: "group-g-9", updatedAt: 9 }] })).toBe("group-g-1");
    expect(pickGroupSession("g", { sessions: [{ id: "group-g-1", updatedAt: 1 }, { id: "group-g-9", updatedAt: 9 }] })).toBe("group-g-9");
  });

  test("到了轮数上限就停住，不再出结论", async () => {
    const room = groups.create("有上限", "user", ["m", "w"]);
    groups.update(room.id, { settings: { moderator: "m", maxTurns: 1, relay: true } });
    const states: string[] = [];
    const runner = new GroupSessionRunner({
      store, groups,
      runtime: { handleStream: async (_req: { bot: Bot }, opts: { onBlock: (b: ContentBlock) => void }) => {
        // 没点名时只有主持人先说；交接给写作助手后碰到硬顶，队列里还留着人
        const text = "【已定】没有\n@写作助手 你接着\n好的";
        opts.onBlock({ type: "text", text });
        return { text, content: [{ type: "text", text }] };
      } } as any,
      providers,
    });
    const sid = `group-${room.id}-cap`;
    const r = await runner.chat(room.id, "开始", sid, { onProgress: (p) => states.push(p.state), onStream: () => {}, setRunning: () => {}, setIdle: () => {} });
    expect(r.reason).toBe("limit");
    expect(r.conclusion).toBeNull();
    expect(states).toContain("paused");
    expect(states).not.toContain("conclusion");
    expect(runner.peek(sid)?.next).toContain("写作助手");
    expect(runner.boardOf(sid)).toEqual([]);
    const events = store.listMessages(sid).filter((m) => m.kind === "event").map((m) => contentText(m.content));
    expect(events.some((t) => t.includes("接力停住了"))).toBe(true);
    expect(events.some((t) => t.includes("接力结束"))).toBe(false);
  });

  test("bot 发起的接力进行中，用户再发是插话", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let n = 0;
    const runner = new GroupSessionRunner({
      store, groups,
      runtime: { handleStream: async (_req: { bot: Bot }, opts: { onBlock: (b: ContentBlock) => void }) => {
        if (n++ === 0) await gate;
        opts.onBlock({ type: "text", text: "好" });
        return { text: "好", content: [{ type: "text", text: "好" }] };
      } } as any,
      providers,
    });
    const sid = `group-${g.id}-bot`;
    const posted = runner.post(g.id, store.getBot("m")!, "大家好", hooks, { sessionId: sid });
    await new Promise((r) => setTimeout(r, 30));
    expect(runner.isLive(sid)).toBe(true);
    const again = await runner.chat(g.id, "插一句", sid, hooks);
    expect(again.joined).toBe(true);
    release();
    await posted;
    expect(runner.isLive(sid)).toBe(false);
  });

  test("停住后 bot 插话，只有被点到的人听这句", async () => {
    const sid = `group-${g.id}-cue`;
    writeFileSync(join(dir, "group-relays.json"), JSON.stringify({
      relays: [{
        sessionId: sid, groupId: g.id, status: "paused",
        queue: [{ id: "w", by: "m" }, { id: "c", by: "w" }],
        roundLeft: 2, round: 1, turns: 1, ending: false,
        seedText: "一起写一篇文章", userMsgId: 1, maxTurns: 6,
      }],
      boards: {},
    }));
    const prompts: string[] = [];
    const runner = new GroupSessionRunner({
      store, groups,
      runtime: { handleStream: async (req: { bot: Bot; text: string }, opts: { onBlock: (b: ContentBlock) => void }) => {
        prompts.push(`${req.bot.id}:${req.text}`);
        opts.onBlock({ type: "text", text: "好" });
        return { text: "好", content: [{ type: "text", text: "好" }] };
      } } as any,
      providers,
    });
    await runner.post(g.id, store.getBot("m")!, "@写作助手 改成短句", hooks, { sessionId: sid });
    const w = prompts.find((p) => p.startsWith("w:")) ?? "";
    const c = prompts.find((p) => p.startsWith("c:")) ?? "";
    expect(w).toContain("改成短句");
    expect(c).not.toContain("改成短句");
    expect(c).toContain("一起写一篇文章");
  });

  test("插话在下一句开始前就落盘", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const runner = new GroupSessionRunner({
      store, groups,
      runtime: { handleStream: async (_req: { bot: Bot }, opts: { onBlock: (b: ContentBlock) => void }) => {
        await gate;
        opts.onBlock({ type: "text", text: "好" });
        return { text: "好", content: [{ type: "text", text: "好" }] };
      } } as any,
      providers,
    });
    const sid = `group-${g.id}-pend`;
    const first = runner.chat(g.id, "开始", sid, hooks);
    await new Promise((r) => setTimeout(r, 30));
    await runner.interject(g.id, sid, "@写作助手 等等");
    const disk = JSON.parse(readFileSync(join(dir, "group-relays.json"), "utf8"));
    const relay = disk.relays.find((x: { sessionId: string }) => x.sessionId === sid);
    expect(relay.pending?.some((p: { text: string }) => p.text.includes("等等"))).toBe(true);
    release();
    await first;
  });

  test("【已定】收进板子，聊天里不留这行；取消能拿掉", async () => {
    const room = groups.create("剥离", "user", ["m"]);
    groups.update(room.id, { settings: { moderator: "m", maxTurns: 4, relay: true } });
    let n = 0;
    const runner = new GroupSessionRunner({
      store, groups,
      runtime: { handleStream: async (req: { bot: Bot; sessionId: string }, opts: { onBlock: (b: ContentBlock) => void }) => {
        const text = n++ === 0 ? "先这样\n【已定】先写大纲\n【已定】没有\n【交给】无" : "取消：先写大纲";
        opts.onBlock({ type: "text", text });
        store.addMessage({ sessionId: req.sessionId, from: req.bot.id, to: "user", role: "assistant", content: text, kind: "chat", createdAt: Date.now() });
        return { text, content: [{ type: "text", text }] };
      } } as any,
      providers,
    });
    const sid = `group-${room.id}-board`;
    await runner.chat(room.id, "开始", sid, hooks);
    expect(runner.boardOf(sid)).toEqual(["先写大纲"]);
    const saved = store.listMessages(sid).filter((m) => m.from === "m").map((m) => contentText(m.content)).join("\n");
    expect(saved).toContain("先这样");
    expect(saved).not.toContain("【已定】");
    expect(saved).not.toContain("【交给】");
    await runner.chat(room.id, "改一下", sid, hooks);
    expect(runner.boardOf(sid)).toEqual([]);
  });

  test("次数用完后再发一句，排队的人会接着说", async () => {
    const sid = `group-${g.id}-again`;
    writeFileSync(join(dir, "group-relays.json"), JSON.stringify({
      relays: [{
        sessionId: sid, groupId: g.id, status: "paused",
        queue: [{ id: "w", by: "m" }], roundLeft: 1, round: 2, turns: 4, ending: false,
        seedText: "一起写一篇文章", userMsgId: 1, maxTurns: 4,
      }],
    }));
    const spoken: string[] = [];
    const runner2 = new GroupSessionRunner({
      store, groups,
      runtime: { handleStream: async (req: { bot: Bot }, opts: { onBlock: (b: ContentBlock) => void }) => {
        spoken.push(req.bot.id);
        opts.onBlock({ type: "text", text: "接着写" });
        return { text: "接着写", content: [{ type: "text", text: "接着写" }] };
      } } as any,
      providers,
    });
    const r = await runner2.chat(g.id, "继续", sid, hooks);
    expect(spoken[0]).toBe("w");
    expect(r.reason).not.toBe("limit");
  });

  test("群名不能重", () => {
    expect(() => groups.create("另一间", "user", ["m", "w"])).toThrow(/已经有叫/);
  });

  test("没点名只让主持人先说；进度带本段和累计", async () => {
    const room = groups.create("安静开场", "user", ["m", "w", "c"]);
    groups.update(room.id, { settings: { moderator: "m", maxTurns: 6, relay: true } });
    const order: string[] = [];
    const ticks: { turn?: number; max?: number; total?: number }[] = [];
    const runner = new GroupSessionRunner({
      store, groups,
      runtime: { handleStream: async (req: { bot: Bot }, opts: { onBlock: (b: ContentBlock) => void }) => {
        order.push(req.bot.id);
        const text = req.bot.id === "m" ? "先定方向\n【交给】写作助手" : "大纲好了\n【交给】无";
        opts.onBlock({ type: "text", text });
        return { text, content: [{ type: "text", text }] };
      } } as any,
      providers,
    });
    await runner.chat(room.id, "一起商量一下", `group-${room.id}-quiet`, {
      onProgress: (p) => { if (p.state === "running") ticks.push({ turn: p.turn, max: p.max, total: p.total }); },
      onStream: () => {},
      setRunning: () => {},
      setIdle: () => {},
    });
    expect(order[0]).toBe("m");
    expect(order).toEqual(["m", "w"]);
    expect(ticks[0]).toEqual({ turn: 1, max: 6, total: 1 });
    expect(ticks.at(-1)?.total).toBe(2);
  });

  test("一个群最多 6 个成员", () => {
    const ids = ["m", "w", "c", "a", "b", "d"];
    for (const id of ["a", "b", "d"]) store.saveBot(bot(id, id));
    const room = groups.create("六人满", "user", ids);
    expect(room.members).toHaveLength(6);
    store.saveBot(bot("e", "e"));
    expect(() => groups.join(room.id, "e")).toThrow(/最多 6/);
    expect(() => groups.update(room.id, { members: [...ids, "e"] })).toThrow(/最多 6/);
  });

  test("bot 回复交接不口语判断，只认显式点名", async () => {
    const room = groups.create("不猜", "user", ["m", "w"]);
    groups.update(room.id, { settings: { moderator: "m", maxTurns: 4, relay: true } });
    let judged = 0;
    const orig = providers.complete.bind(providers);
    (providers as any).complete = async (...args: unknown[]) => {
      judged++;
      return orig(...args as [any, any]);
    };
    const order: string[] = [];
    const runner = new GroupSessionRunner({
      store, groups,
      runtime: { handleStream: async (req: { bot: Bot }, opts: { onBlock: (b: ContentBlock) => void }) => {
        order.push(req.bot.id);
        const text = req.bot.id === "m" ? "写作助手你看一下" : "好";
        opts.onBlock({ type: "text", text });
        return { text, content: [{ type: "text", text }] };
      } } as any,
      providers,
    });
    await runner.chat(room.id, "@主控 开场", `group-${room.id}-noj`, {
      onProgress: () => {},
      onStream: () => {},
      setRunning: () => {},
      setIdle: () => {},
    });
    expect(order).toEqual(["m"]);
    expect(judged).toBe(0);
  });

  test("cleanup", () => { rmSync(dir, { recursive: true, force: true }); });
});
