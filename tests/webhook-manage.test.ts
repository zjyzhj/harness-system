import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import { MemorySystem } from "../core/memory-system";
import { SkillRegistry } from "../core/skill-registry";
import { BotRuntime } from "../core/bot-runtime";
import { ProviderCenter } from "../core/provider-center";
import { ConnectorStore } from "../core/connectors";
import { Scheduler } from "../core/scheduler";
import { ConsentCenter } from "../core/consent-center";
import { runTaskTool } from "../core/runtime/tool-helpers";
import type { Bot } from "../core/types";

describe("对话里管理 Webhook", () => {
  const home = mkdtempSync(join(tmpdir(), "harness-wh-manage-"));
  const store = new Store(home);
  afterAll(() => store.close());
  const bot: Bot = { id: "a", name: "助手", role: "通用", persona: "", providerId: "", petEnabled: false, createdAt: 1 };
  store.saveBot(bot);

  test("webhook.list / add / remove；空列表指明出入站", async () => {
    const connectors = new ConnectorStore(home);
    const changes: string[] = [];
    const consent = new ConsentCenter(home);
    consent.decider = () => "allow";
    const rt = new BotRuntime({
      store,
      providers: new ProviderCenter(store),
      memory: new MemorySystem(home),
      skills: new SkillRegistry(join(home, "skills")),
      connectors,
      consent,
      onAppChanged: (w) => changes.push(w),
    });
    const run = (tool: string, args: Record<string, unknown>) =>
      (rt as any).executeBuiltin(bot, { tool, args }, "", 0, "s1");

    const empty = await run("webhook.list", {});
    expect(empty.output).toMatch(/出站/);
    expect(empty.output).toMatch(/入站/);
    expect(empty.output).toContain("webhook.add");

    const added = await run("webhook.add", { name: "钩子", url: "https://hooks.example/x" });
    expect(added.output).toContain("已登记出站 Webhook「钩子」");
    expect(connectors.findWebhook("钩子")?.url).toBe("https://hooks.example/x");
    expect(changes).toContain("vault");

    const listed = await run("webhook.list", {});
    expect(listed.output).toContain("钩子");

    const removed = await run("webhook.remove", { name: "钩子" });
    expect(removed.output).toContain("已移除");
    expect(connectors.findWebhook("钩子")).toBeUndefined();
  });

  test("task.create webhook:true 开通入站令牌", () => {
    const tasks = new Scheduler(mkdtempSync(join(tmpdir(), "harness-wh-task-")));
    const r = runTaskTool(tasks, bot, "task.create", {
      name: "外触发",
      prompt: "跑一下",
      cron: "0 9 * * *",
      webhook: true,
    }, "s1");
    expect(r.output).toMatch(/入站 Webhook 已开通/);
    expect(r.blocks?.some((b) => b.type === "routine" && b.name === "外触发")).toBe(true);
    expect(tasks.list().some((t) => t.name === "外触发" && !!t.webhookToken)).toBe(true);
  });

  test("app.state / 软件现状写明 Webhook，禁止说没有", async () => {
    const connectors = new ConnectorStore(home);
    connectors.upsertWebhook({ name: "飞书钩子", url: "https://hooks.example/feishu" });
    const tasks = new Scheduler(mkdtempSync(join(tmpdir(), "harness-wh-snap-")));
    const rt = new BotRuntime({
      store,
      providers: new ProviderCenter(store),
      memory: new MemorySystem(home),
      skills: new SkillRegistry(join(home, "skills")),
      connectors,
      tasks,
    });
    const snap = (rt as any).prompt.appSnapshot(bot, true);
    expect(snap.brief).toMatch(/出站Webhook/);
    expect(snap.lines.join("\n")).toContain("webhook.add");
    expect(snap.lines.join("\n")).toContain("飞书钩子");
    expect(snap.lines.join("\n")).toMatch(/入站 Webhook/);
    const listed = await (rt as any).appTool(bot, "app.state", {});
    expect(listed.output).toContain("出站 Webhook");
    expect(listed.output).toContain("webhook.add");
  });
});
