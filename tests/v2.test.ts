import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import { MemorySystem } from "../core/memory-system";
import { SkillRegistry, BUILTIN_SKILL_TEMPLATES } from "../core/skill-registry";
import { Scheduler } from "../core/scheduler";
import { MigrationV2 } from "../core/migration-v2";
import { McpClient } from "../core/mcp-client";
import { AgentRegistry } from "../core/agent-registry";

let home: string;
let store: Store;
let memory: MemorySystem;
let skills: SkillRegistry;
let scheduler: Scheduler;
let migration: MigrationV2;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "harness-v2-test-"));
  store = new Store(join(home, "h"));
  memory = new MemorySystem(join(home, "h"));
  skills = new SkillRegistry(join(home, "h", "skills"));
  for (const [k, md] of Object.entries(BUILTIN_SKILL_TEMPLATES)) skills.create(k, md);
  scheduler = new Scheduler(join(home, "h"));
  migration = new MigrationV2(store, join(home, "h", "assets"), memory, skills, scheduler);
});

afterAll(() => store.close());

describe("migration-v2", () => {
  test("导出含 memory/skills/tasks", async () => {
    const reg = new AgentRegistry(store);
    const bot = await reg.createBotFromText("创建 bot：迁移测试");
    memory.add(bot.id, { kind: "fact", content: "用户偏好中文", source: "test" });
    scheduler.create({ botId: bot.id, name: "早报", cron: "0 8 * * *", prompt: "早报" });
    const payload = migration.exportPayload();
    expect(payload.format).toBe("harness-bot-migration/v2");
    expect(payload.memory?.[bot.id]?.length).toBe(1);
    expect(Object.keys(payload.skills ?? {})).toContain("web-search");
    expect(payload.tasks?.length).toBe(1);
    // 写到文件可读
    migration.exportToFile(join(home, "out.json"));
    expect(existsSync(join(home, "out.json"))).toBe(true);
  });

  test("全量导入还原记忆/技能/任务", async () => {
    const store2 = new Store(join(home, "h2"));
    const mem2 = new MemorySystem(join(home, "h2"));
    const skills2 = new SkillRegistry(join(home, "h2", "skills"));
    const sched2 = new Scheduler(join(home, "h2"));
    const mig2 = new MigrationV2(store2, join(home, "h2", "assets"), mem2, skills2, sched2);

    const payload = migration.exportPayload();
    const r = mig2.importFromPayload(payload);
    expect(r.importedBots).toBeGreaterThan(0);
    expect(r.importedMemories).toBeGreaterThan(0);
    expect(r.importedSkills).toBeGreaterThan(0);
    expect(r.importedTasks).toBeGreaterThan(0);
    // 还原后记忆/技能/任务可见
    const botId = store2.listBots()[0].id;
    expect(mem2.list(botId).length).toBeGreaterThan(0);
    expect(skills2.list().length).toBeGreaterThan(0);
    expect(sched2.list().length).toBeGreaterThan(0);
    store2.close();
  });
});

describe("mcp-client", () => {
  test("未配置 server 时 listTools 为空且不抛错", async () => {
    const c = new McpClient([]);
    await c.init();
    expect(c.listTools().length).toBe(0);
    c.close();
  });

  test("坏 server 配置静默降级", async () => {
    const c = new McpClient([{ id: "bad", name: "bad", url: "http://127.0.0.1:1/mcp" }]);
    await c.init();
    expect(c.listTools().length).toBe(0);
    c.close();
  });
});
