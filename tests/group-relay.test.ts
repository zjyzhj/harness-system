import { describe, test, expect } from "bun:test";
import { addressedBots, runGroupRelay, GROUP_END_MARK } from "../core/group-relay";
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
});
