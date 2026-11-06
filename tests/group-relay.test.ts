import { describe, test, expect } from "bun:test";
import { addressedBots, collectDecisions, collectRetractions, relayCeiling, resolveAddressed, runGroupRelay, stretchLimit, GROUP_END_MARK, GROUP_MAX_MEMBERS } from "../core/group-relay";
import type { Bot } from "../core/types";

const mk = (id: string, name: string, isMaster = false): Bot => ({ id, name, role: "", persona: "", providerId: "", petEnabled: false, createdAt: 0, isMaster });
const bots = [mk("m", "灵感助手", true), mk("x", "灵感小助手"), mk("w", "写作助手"), mk("t", "翻译助手"), mk("c", "代码助手")];

describe("群聊点名识别", () => {
  test("→ 名字 / @名字 / 段首「名字：」/ 主控，按出现顺序，不含自己", () => {
    const text = "**翻译助手 → 主控**：同意。\n\n**翻译助手 → 代码助手**：给个格式？\n\n@写作助手 你看呢";
    expect(addressedBots(text, bots, "t")).toEqual(["m", "c", "w"]);
  });
  test("长名字优先，「灵感小助手」不会误中「灵感助手」", () => {
    expect(addressedBots("@灵感小助手 帮忙", bots, "w")).toEqual(["x"]);
  });
  test("只是提到名字不算点名", () => {
    expect(addressedBots("写作助手的表格很实用", bots, "m")).toEqual([]);
  });
  test("口语里的叫法不是写明的点名", () => {
    expect(addressedBots("翻译助手你看一下", bots, "m")).toEqual([]);
    expect(addressedBots("请写作助手润色一下", bots, "m")).toEqual([]);
    expect(addressedBots("翻译助手，帮我看看", bots, "m")).toEqual([]);
    expect(addressedBots("不要让翻译助手改", bots, "m")).toEqual([]);
    expect(addressedBots("名叫灵感助手", bots, "w")).toEqual([]);
    expect(addressedBots("申请翻译助手", bots, "m")).toEqual([]);
    expect(addressedBots("翻译助手你看起来同意", bots, "m")).toEqual([]);
    expect(addressedBots("写作助手的表格很实用", bots, "m")).toEqual([]);
  });
  test("【交给】写了谁就叫谁，无就没人，长名字优先", () => {
    expect(addressedBots("先这样\n【交给】写作助手；翻译助手", bots, "m")).toEqual(["w", "t"]);
    expect(addressedBots("【交给】无", bots, "m")).toEqual([]);
    expect(addressedBots("【交给】灵感小助手", bots, "w")).toEqual(["x"]);
  });
  test("@everyone / @所有人 / 【交给】全员 叫满房间里除自己以外的人", () => {
    const room = ["m", "w", "t", "c"];
    expect(addressedBots("@everyone 一起看", bots, "m", room)).toEqual(["w", "t", "c"]);
    expect(addressedBots("@所有人 注意", bots, "w", room)).toEqual(["m", "t", "c"]);
    expect(addressedBots("先这样\n【交给】全员", bots, "t", room)).toEqual(["m", "w", "c"]);
    expect(addressedBots("@everyone 一起看", bots, "m")).toEqual([]);
  });
  test("没有【交给】、又出现了人名，才问判断；失败只留 @", async () => {
    let called = 0;
    expect(await resolveAddressed("好的", bots, "m", async () => { called++; return ["w"]; })).toEqual([]);
    expect(called).toBe(0);
    expect(await resolveAddressed("翻译助手，帮我看看", bots, "m", async () => ["t"])).toEqual(["t"]);
    expect(await resolveAddressed("写作助手的表格很实用", bots, "m", async () => [])).toEqual([]);
    called = 0;
    expect(await resolveAddressed("提到翻译助手\n【交给】无", bots, "m", async () => { called++; return ["t"]; })).toEqual([]);
    expect(called).toBe(0);
    expect(await resolveAddressed("@写作助手 另外翻译助手也看看", bots, "m", async () => { throw new Error("down"); })).toEqual(["w"]);
  });
  test("已定事项从定了和【已定】里收下，空话不记，取消单独算", () => {
    expect(collectDecisions("定了：用表格\n【已定】先写大纲；再翻译\n【已定】无\n【已定】没有")).toEqual(["用表格", "先写大纲", "再翻译"]);
    expect(collectRetractions("取消：先写大纲；再翻译")).toEqual(["先写大纲", "再翻译"]);
  });
});

describe("群聊接力", () => {
  const script = (lines: Record<string, string[]>) => {
    const said: string[] = [];
    const reply = async (id: string) => { said.push(id); return lines[id]?.shift() ?? "好的"; };
    return { said, reply };
  };
  test("先按顺序各说一轮，再让被点名的接话；群外 bot 被点名也会被叫进来", async () => {
    const { said, reply } = script({ m: ["→ 写作助手：你先？ → 代码助手：你来定术语"], w: ["好"], t: ["@代码助手 给格式"], c: ["给了，@主控 看下"] });
    const r = await runGroupRelay({ members: ["m", "w", "t"], bots, aborted: () => false, reply });
    expect(said).toEqual(["m", "w", "t", "c", "m"]);
    expect(r.reason).toBe("quiet");
  });
  test("用户点名了谁就只从谁开始，不再全员轮一遍", async () => {
    const { said, reply } = script({ t: ["好的，@写作助手 你润色"] });
    const start = addressedBots("@翻译助手 你来翻一下", bots, "user");
    await runGroupRelay({ members: ["m", "w", "t"], start, bots, aborted: () => false, reply });
    expect(said).toEqual(["t", "w"]);
  });
  test("宣布结束：没被点名的不再发言；这条里点到的人回一句，之后的点名不再接", async () => {
    const { said, reply } = script({ m: [`定了，@代码助手 给下模板 ${GROUP_END_MARK}`], c: ["给了 @翻译助手 看下"] });
    const r = await runGroupRelay({ members: ["m", "w", "t"], bots, aborted: () => false, reply });
    expect(said).toEqual(["m", "c"]);
    expect(r.reason).toBe("ended");
  });
  test("互相点名不停时到上限停下；停止生成立刻停", async () => {
    const ping = async (id: string) => (id === "m" ? "@写作助手" : "@主控");
    expect(await runGroupRelay({ members: ["m", "w"], bots, maxTurns: 5, aborted: () => false, reply: ping })).toMatchObject({ turns: 5, reason: "limit" });
    let n = 0;
    expect((await runGroupRelay({ members: ["m", "w"], bots, aborted: () => n >= 1, reply: async (id) => { n++; return ping(id); } })).reason).toBe("stopped");
  });

  test("轮与轮之间调用主持人小结；最后一轮之后不调", async () => {
    const { said, reply } = script({ m: ["@代码助手 你看"], w: ["好"], c: ["行"] });
    const rounds: number[] = [];
    const r = await runGroupRelay({ members: ["m", "w"], bots, aborted: () => false, reply, onRoundEnd: async (n) => { rounds.push(n); } });
    expect(said).toEqual(["m", "w", "c"]);
    expect(rounds).toEqual([1]);
    expect(r.rounds).toBe(2);
  });
  test("一轮只有一个人说过就不写主持人小结", async () => {
    const { said, reply } = script({ m: ["@写作助手 你来"], w: ["好"] });
    const rounds: number[] = [];
    await runGroupRelay({ members: ["m", "w", "t"], start: ["m"], bots, aborted: () => false, reply, onRoundEnd: async (n) => { rounds.push(n); } });
    expect(said).toEqual(["m", "w"]);
    expect(rounds).toEqual([]);
  });
  test("中途插话插到队首，被 @ 的人先回应，没 @ 就由 fallback 回应", async () => {
    const box: { text: string; targets: string[] }[] = [];
    const notes: string[] = [];
    const reply = async (id: string, _t: number, by: string | null, note?: string) => {
      if (id === "m" && !notes.length) box.push({ text: "@翻译助手 先说英文名", targets: ["t"] }, { text: "顺便看下截图", targets: [] });
      if (note) notes.push(`${id}:${note}`);
      return "好";
    };
    await runGroupRelay({ members: ["m", "w"], bots, fallback: "m", aborted: () => false, reply, inbox: () => box.splice(0) });
    expect(notes).toEqual(["t:@翻译助手 先说英文名", "m:顺便看下截图"]);
  });
  test("关掉接力：只回应首轮，不跟着点名走", async () => {
    const { said, reply } = script({ m: ["@代码助手 你看"] });
    await runGroupRelay({ members: ["m", "w"], bots, relay: false, aborted: () => false, reply });
    expect(said).toEqual(["m", "w"]);
  });
  test("显式传入 start=[] 不回落成全员；oneShot 说完首轮不再跟交接", async () => {
    const empty: string[] = [];
    const { said: none, reply: r0 } = script({ m: ["@写作助手"] });
    await runGroupRelay({ members: ["m", "w", "t"], start: empty, bots, aborted: () => false, reply: r0 });
    expect(none).toEqual([]);

    const { said, reply } = script({ m: ["@写作助手 你来"], w: ["好"] });
    await runGroupRelay({ members: ["m", "w", "t"], start: ["m"], oneShot: true, bots, aborted: () => false, reply });
    expect(said).toEqual(["m"]);
  });
  test("插话把排队中的人提前，不会让这一轮多等一个人", async () => {
    const box: { text: string; targets: string[] }[] = [];
    const rounds: number[] = [];
    const reply = async (id: string, _t: number, by: string | null) => {
      if (id === "m" && !by) box.push({ text: "@翻译助手 短一点", targets: ["t"] });
      if (id === "t") return "@主控 你定吧";
      return "好";
    };
    await runGroupRelay({ members: ["m", "w", "t"], bots, aborted: () => false, reply, inbox: () => box.splice(0), onRoundEnd: async (n) => { rounds.push(n); } });
    expect(rounds).toEqual([1]);
  });

  test("接着上次的队列说，不再从头轮一遍", async () => {
    const { said, reply } = script({ w: ["好"] });
    const r = await runGroupRelay({
      members: ["m", "w", "t"],
      bots,
      aborted: () => false,
      resume: { queue: [{ id: "w", by: "m" }], roundLeft: 1, round: 2, turns: 1, ending: false },
      reply,
    });
    expect(said).toEqual(["w"]);
    expect(r.turns).toBe(2);
  });

  test("还没开口的人被移出就跳过；被点名拉进来的说完这一句", async () => {
    const present = new Set(["m", "w"]);
    const { said, reply } = script({ m: ["@代码助手 你看"], c: ["好"] });
    await runGroupRelay({
      members: ["m", "w"],
      bots,
      aborted: () => false,
      canSpeak: (item) => present.has(item.id) || !!item.invited,
      reply: async (id) => {
        if (id === "m") present.delete("w");
        return reply(id);
      },
    });
    expect(said).toEqual(["m", "c"]);
  });

  test("跳过的人会从检查点里拿掉", async () => {
    const snaps: string[][] = [];
    await runGroupRelay({
      members: ["m", "w"],
      bots,
      aborted: () => false,
      canSpeak: (item) => item.id !== "w",
      onCheckpoint: (c) => snaps.push(c.queue.map((q) => q.id)),
      reply: async () => "好",
    });
    expect(snaps.at(-1)).toEqual([]);
    expect(snaps.some((q) => q.includes("w"))).toBe(true);
  });

  test("轮数到顶前，刚插的话已经进检查点", async () => {
    const box: { text: string; targets: string[] }[] = [];
    const snaps: string[][] = [];
    await runGroupRelay({
      members: ["m", "w"],
      bots,
      maxTurns: 1,
      aborted: () => false,
      inbox: () => box.splice(0),
      onCheckpoint: (c) => snaps.push(c.queue.map((q) => q.id)),
      reply: async (id) => {
        if (id === "m") box.push({ text: "等等", targets: ["t"] });
        return "好";
      },
    });
    expect(snaps.at(-1)).toContain("t");
  });

  test("没有写【交给】时，由判断决定下一位", async () => {
    const { said, reply } = script({ m: ["翻译助手，帮我看看"], t: ["好"] });
    await runGroupRelay({
      members: ["m"],
      bots,
      aborted: () => false,
      reply,
      whoNext: async (text, selfId) => resolveAddressed(text, bots, selfId, async () => (text.includes("帮我看看") ? ["t"] : [])),
    });
    expect(said).toEqual(["m", "t"]);
  });

  test("只点一个人也能交接下去，硬顶才停", async () => {
    const { said, reply } = script({ w: ["先写大纲\n【交给】翻译助手"], t: ["译好了"] });
    const r = await runGroupRelay({
      members: ["w", "t", "c"],
      start: ["w"],
      bots,
      maxTurns: 12,
      aborted: () => false,
      reply,
    });
    expect(said).toEqual(["w", "t"]);
    expect(r.reason).toBe("quiet");
    expect(r.turns).toBe(2);
  });
});

describe("群聊发言硬顶", () => {
  test("硬顶夹在 1～40，点名不缩短次数", () => {
    expect(relayCeiling(12)).toBe(12);
    expect(relayCeiling(0)).toBe(12);
    expect(relayCeiling(99)).toBe(40);
    expect(stretchLimit(undefined, 12)).toBe(12);
    expect(stretchLimit(undefined, 1)).toBe(1);
  });
  test("次数用完再开口，再给一段硬顶；没用完不另加", () => {
    expect(stretchLimit({ turns: 4, maxTurns: 4 }, 12)).toBe(16);
    expect(stretchLimit({ turns: 2, maxTurns: 6 }, 12)).toBe(6);
  });
  test("成员上限是 6", () => {
    expect(GROUP_MAX_MEMBERS).toBe(6);
  });
});
