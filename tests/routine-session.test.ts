import { describe, expect, test } from "bun:test";
import { canPostRoutineToSession, pickRoutineTranscriptSessionId } from "../core/routine-session";

describe("例行结果进对话会话挑选", () => {
  test("排除群 / b2b / 内部会话", () => {
    expect(canPostRoutineToSession("s-1")).toBe(true);
    expect(canPostRoutineToSession("s-routine-bot")).toBe(true);
    expect(canPostRoutineToSession("group-1")).toBe(false);
    expect(canPostRoutineToSession("b2b-a-b")).toBe(false);
    expect(canPostRoutineToSession("plan-1")).toBe(false);
    expect(canPostRoutineToSession("sched-1")).toBe(false);
    expect(canPostRoutineToSession("wh-1")).toBe(false);
    expect(canPostRoutineToSession("")).toBe(false);
  });

  test("优先钉死会话，其次注视，再次最近单聊", () => {
    const exists = new Set(["s-pin", "s-gaze", "s-old", "sched-x"]);
    const pick = (opts: { pinned?: string; gazed?: string }) =>
      pickRoutineTranscriptSessionId({
        pinned: opts.pinned,
        gazed: opts.gazed,
        sessionExists: (id) => exists.has(id),
        recentSessions: [{ id: "sched-x" }, { id: "s-old" }],
      });

    expect(pick({ pinned: "s-pin", gazed: "s-gaze" })).toBe("s-pin");
    expect(pick({ pinned: "group-1", gazed: "s-gaze" })).toBe("s-gaze");
    expect(pick({ pinned: "missing", gazed: "sched-x" })).toBe("s-old");
    expect(pick({})).toBe("s-old");
  });

  test("没有可用会话返回 null", () => {
    expect(
      pickRoutineTranscriptSessionId({
        pinned: "sched-1",
        gazed: "wh-1",
        sessionExists: () => true,
        recentSessions: [{ id: "b2b-a-b" }, { id: "group-1" }],
      }),
    ).toBeNull();
  });
});
