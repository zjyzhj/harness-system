import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
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

  test("旧包里的 plans 跳过不导入；导出不再带 plans", async () => {
    const payload = migration.exportPayload();
    expect(payload.plans).toBeUndefined();
    payload.plans = [
      { id: "p1", title: "旧编排", stages: [] },
      { id: "p2", title: "另一条", stages: [] },
    ];
    const store2 = new Store(join(home, "h2-plans"));
    const mig2 = new MigrationV2(store2, join(home, "h2-plans", "assets"), new MemorySystem(join(home, "h2-plans")), new SkillRegistry(join(home, "h2-plans", "skills")), new Scheduler(join(home, "h2-plans")));
    const r = mig2.importFromPayload(payload);
    expect(r.importedPlans).toBe(0);
    expect(r.skippedPlans).toBe(2);
    expect(mig2.exportPayload().plans).toBeUndefined();
    store2.close();
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

describe("migration-v2 skins", () => {
  test("导出含 skins 元数据与文件，导入后还原注册 + bot.skinId 映射", async () => {
    // 构造带皮肤的迁移源
    const srcHome = mkdtempSync(join(tmpdir(), "harness-v2-skin-"));
    const srcStore = new Store(join(srcHome, "h"));
    const srcMem = new MemorySystem(join(srcHome, "h"));
    const srcSkills = new SkillRegistry(join(srcHome, "h", "skills"));
    const srcSched = new Scheduler(join(srcHome, "h"));
    const srcAssets = join(srcHome, "h", "assets");
    const skinDir = join(srcAssets, "skins", "claude-x");
    mkdirSync(skinDir, { recursive: true });
    const sprites = join(skinDir, "spritesheet.webp");
    writeFileSync(sprites, "fake-webp-bytes");
    // 写 index.json（注册）
    writeFileSync(join(srcAssets, "skins", "index.json"), JSON.stringify([{
      id: "claude-x", name: "Claude 测试", color: "#D97757", desc: "社区皮肤", fps: 8,
      frames: { idle: ["🙂"], walk: ["🚶"], jump: ["🤸"], sleep: ["😴"], celebrate: ["🎉"], work: ["🤔"], think: ["💭"] },
      sprite: { url: "https://example.test/claude/spritesheet.webp", path: sprites, rows: 9, cols: 8, cellW: 192, cellH: 208 },
    }], null, 2), "utf8");
    // bot 使用该皮肤
    const reg = new AgentRegistry(srcStore);
    const bot = await reg.createBotFromText("创建 bot：皮肤迁移测试");
    srcStore.saveBot({ ...bot, skinId: "claude-x" });
    const srcMig = new MigrationV2(srcStore, srcAssets, srcMem, srcSkills, srcSched);

    const payload = srcMig.exportPayload();
    expect(payload.skins?.["claude-x"]?.rows).toBe(9);
    expect(payload.skins?.["claude-x"]?.path).toBe(sprites);

    // 导入到新 home
    const dstHome = mkdtempSync(join(tmpdir(), "harness-v2-skin-dst-"));
    const dstStore = new Store(join(dstHome, "h"));
    const dstMem = new MemorySystem(join(dstHome, "h"));
    const dstSkills = new SkillRegistry(join(dstHome, "h", "skills"));
    const dstSched = new Scheduler(join(dstHome, "h"));
    const dstAssets = join(dstHome, "h", "assets");
    const dstMig = new MigrationV2(dstStore, dstAssets, dstMem, dstSkills, dstSched);
    const r = dstMig.importFromPayload(payload);
    expect(r.importedSkins).toBe(1);
    // 皮肤文件复制 + index 还原
    expect(existsSync(join(dstAssets, "skins", "claude-x", "spritesheet.webp"))).toBe(true);
    const idx = JSON.parse(readFileSync(join(dstAssets, "skins", "index.json"), "utf8"));
    expect(idx[0].id).toBe("claude-x");
    expect(idx[0].sprite.cellW).toBe(192);
    // bot.skinId 映射到新 bot id
    const newBot = dstStore.listBots()[0];
    expect(newBot.skinId).toBe("claude-x");
    dstStore.close(); srcStore.close();
  });
});
