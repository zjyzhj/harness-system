import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
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
