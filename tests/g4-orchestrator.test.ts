import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import { Orchestrator, planFromText } from "../core/orchestrator";
import { GroupRegistry } from "../core/group-registry";
import type { Bot } from "../core/types";

let home: string;
let store: Store;
let orch: Orchestrator;
let groups: GroupRegistry;
let a: Bot, b: Bot, c: Bot;
const calls: string[] = [];

function mkBot(name: string): Bot {
  return { id: `bot-${name}`, name, role: "助手", persona: "", providerId: "default", petEnabled: false, createdAt: Date.now() };
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "harness-g4o-"));
  store = new Store(home);
  groups = new GroupRegistry(home);
  orch = new Orchestrator({ store, groups }, home);
  a = mkBot("A"); b = mkBot("B"); c = mkBot("C");
  store.saveBot(a); store.saveBot(b); store.saveBot(c);
  orch.stageRunner = async (stage, prev) => {
    calls.push(`${stage.botId}|${stage.prompt}|${prev ?? ""}`);
    if (stage.prompt.includes("失败")) throw new Error("故意失败");
    return `【${stage.botId} 产出】`;
  };
});

describe("G4 orchestrator", () => {
  test("T4.2 顺序流水线：A→B→C 串行，stage3 含 stage2 结果", async () => {
    calls.length = 0;
    const plan = orch.create({
      ownerBotId: "user",
      title: "调研流水线",
      stages: [
        { botId: a.id, prompt: "调研 X" },
        { botId: b.id, prompt: "总结" },
        { botId: c.id, prompt: "写报告" },
      ],
    });
    expect(plan.status).toBe("pending");
    const done = await orch.run(plan.id);
    expect(done.status).toBe("done");
    expect(done.stages.every((s) => s.status === "done")).toBe(true);
    // stage3 调用时 prev 含 stage2 结果
    const stage3Call = calls.find((x) => x.startsWith(`${c.id}|`));
    expect(stage3Call).toContain("【bot-B 产出】");
    expect(done.result).toContain("【bot-C 产出】");
  });

  test("T4.3a fan 并行完成", async () => {
    calls.length = 0;
    const plan = orch.create({
      ownerBotId: "user",
      title: "并行收集",
      stages: [
        { botId: a.id, prompt: "查天气", mode: "fan" },
        { botId: b.id, prompt: "查股价", mode: "fan" },
        { botId: c.id, prompt: "汇总", mode: "seq" },
      ],
    });
    const done = await orch.run(plan.id);
    expect(done.status).toBe("done");
    // fan 两路结果都进汇总 prev
    const sumCall = calls.find((x) => x.startsWith(`${c.id}|`));
    expect(sumCall).toContain("【bot-A 产出】");
    expect(sumCall).toContain("【bot-B 产出】");
  });

  test("T4.3b 单路失败 → 该阶段 error，后续中止", async () => {
    const plan = orch.create({
      ownerBotId: "user",
      title: "失败链",
      stages: [
        { botId: a.id, prompt: "正常" },
        { botId: b.id, prompt: "故意失败" },
        { botId: c.id, prompt: "不该执行" },
      ],
    });
    const done = await orch.run(plan.id);
    expect(done.status).toBe("error");
    expect(done.stages[1].status).toBe("error");
    expect(done.stages[2].status).toBe("pending"); // 中止
  });

  test("T4.4 规则降级：一句话解析 3 阶段", async () => {
    const stages = await planFromText("让 A 调研用户需求，B 总结分析，C 写报告", [a, b, c]);
    expect(stages.length).toBe(3);
    expect(stages.map((s) => s.botId)).toEqual([a.id, b.id, c.id]);
  });

  test("指定了不存在的 bot：报错，不偷偷换成别的 bot", async () => {
    const complete = async () => ({ text: '[{"bot":"A","prompt":"调研"},{"bot":"乙","prompt":"总结"}]' });
    await expect(planFromText("让 A 调研，乙 总结", [a, b, c], { provider: { id: "p" }, complete })).rejects.toThrow(/找不到 bot：乙/);
  });

  test("规则降级：长名字优先（「灵感助手 2」不会被当成「灵感助手」）", async () => {
    const x = { ...a, id: "x", name: "灵感助手" }, y = { ...a, id: "y", name: "灵感助手 2" };
    const stages = await planFromText("让 灵感助手 调研，灵感助手 2 写报告", [x, y]);
    expect(stages.map((s) => s.botId)).toEqual(["x", "y"]);
  });

  test("T4.7 权限：非 admin bot 不能发起", () => {
    expect(() => orch.create({ ownerBotId: a.id, title: "越权", stages: [{ botId: b.id, prompt: "x" }] })).toThrow(/权限不足/);
    // admin bot 可发起
    groups.create("管理组", a.id, [b.id]);
    const plan = orch.create({ ownerBotId: a.id, title: "授权", stages: [{ botId: b.id, prompt: "x" }] });
    expect(plan.ownerBotId).toBe(a.id);
  });

  test("T4.3c 超时兜底", async () => {
    const slow = new Orchestrator({ store, groups }, home);
    slow.stageRunner = async () => { await new Promise((r) => setTimeout(r, 500)); return "慢"; };
    const plan = slow.create({ ownerBotId: "user", title: "慢", stages: [{ botId: a.id, prompt: "慢任务" }] });
    const done = await slow.run(plan.id, { timeoutMs: 80 });
    expect(done.status).toBe("error");
    expect(done.stages[0].error).toContain("超时");
  });

  test("重新运行：先清空上一轮的阶段状态和结果，过程实时推送", async () => {
    const o = new Orchestrator({ store, groups }, home);
    let round = 0;
    o.stageRunner = async (stage, _prev, ctx) => {
      ctx.onActivity("调用 web.search");
      ctx.onText("第一段");
      ctx.onText("第二段");
      if (stage.botId === b.id && ++round === 1) throw new Error("首轮失败");
      return `${stage.botId} 完成`;
    };
    const plan = o.create({ ownerBotId: "user", title: "重跑", stages: [{ botId: a.id, prompt: "x" }, { botId: b.id, prompt: "y" }] });
    expect((await o.run(plan.id)).status).toBe("error");
    const seen: string[] = [];
    o.onChange = (p) => seen.push(`${p.status}:${p.stages.map((s) => `${s.status}${s.error ? "!" : ""}${s.live ?? ""}`).join(",")}`);
    const done = await o.run(plan.id);
    expect(seen[0]).toBe("running:pending,pending");
    expect(seen).toContain("running:running第一段第二段,pending");
    expect(done.status).toBe("done");
    expect(done.stages.every((s) => s.status === "done" && !s.error && s.live === undefined)).toBe(true);
    expect(done.startedAt).toBeLessThanOrEqual(done.finishedAt!);
  });

  test("停止：中断正在跑的阶段，后续阶段不再执行", async () => {
    const o = new Orchestrator({ store, groups }, home);
    let aborted = false;
    const ran: string[] = [];
    o.stageRunner = (stage, _prev, ctx) => new Promise((resolve) => {
      ran.push(stage.botId);
      ctx.signal.addEventListener("abort", () => { aborted = true; resolve("被打断"); });
    });
    const plan = o.create({ ownerBotId: "user", title: "停", stages: [{ botId: a.id, prompt: "x" }, { botId: b.id, prompt: "y" }] });
    const running = o.run(plan.id);
    await expect(o.run(plan.id)).rejects.toThrow(/正在运行/);
    await new Promise((r) => setTimeout(r, 10));
    o.cancel(plan.id);
    const done = await running;
    expect(aborted).toBe(true);
    expect(ran).toEqual([a.id]);
    expect(done.result).toBe("（已取消）");
    expect(done.stages[0].error).toBe("已取消");
    expect(done.stages[1].status).toBe("pending");
  });
});

describe("G4 migration groups/plans", () => {
  test("T4.7 迁移往返：groups + plans 随导出/导入", async () => {
    const { MigrationV2 } = await import("../core/migration-v2");
    const { SkillRegistry } = await import("../core/skill-registry");
    const { MemorySystem } = await import("../core/memory-system");
    const { Scheduler } = await import("../core/scheduler");
    const mem = new MemorySystem(home);
    const skills = new SkillRegistry(home);
    const sched = new Scheduler(home);
    const mig = new MigrationV2(store, join(home, "assets"), mem, skills, sched, groups, orch);
    const payload = mig.exportPayload();
    expect(payload.groups!.length).toBeGreaterThan(0);
    expect(payload.plans!.length).toBeGreaterThan(0);
    // 导入到新 home
    const home2 = mkdtempSync(join(tmpdir(), "harness-g4m-"));
    const store2 = new Store(home2);
    const groups2 = new GroupRegistry(home2);
    const orch2 = new Orchestrator({ store: store2, groups: groups2 }, home2);
    const mig2 = new MigrationV2(store2, join(home2, "assets"), new MemorySystem(home2), new SkillRegistry(home2), new Scheduler(home2), groups2, orch2);
    // 先导入 bots
    for (const b of payload.bots) store2.saveBot({ ...b, id: b.id });
    const r = mig2.importFromPayload(payload);
    expect(r.importedGroups).toBeGreaterThan(0);
    expect(r.importedPlans).toBeGreaterThan(0);
    expect(groups2.list().length).toBe(groups.list().length);
    expect(orch2.list().length).toBe(orch.list().length);
  });
});

describe("编排计划的持久状态", () => {
  test("上次退出时还在跑的计划，重启后标为中断；删除后不再出现", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-g4-stale-"));
    writeFileSync(join(dir, "plans.json"), JSON.stringify([{ id: "p1", ownerBotId: "user", title: "t", createdAt: 1, status: "running", stages: [{ id: "s1", botId: "x", prompt: "p", status: "running" }, { id: "s2", botId: "y", prompt: "q", status: "pending" }] }]));
    const o = new Orchestrator({ store: new Store(dir), groups: new GroupRegistry(dir) }, dir);
    const p = o.list()[0];
    expect(p.status).toBe("error");
    expect(p.stages.map((s) => s.status)).toEqual(["error", "pending"]);
    o.delete("p1");
    expect(new Orchestrator({ store: new Store(dir), groups: new GroupRegistry(dir) }, dir).list().length).toBe(0);
  });
});
