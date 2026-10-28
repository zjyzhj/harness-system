import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import { MemorySystem } from "../core/memory-system";
import { SkillRegistry } from "../core/skill-registry";
import { BotRuntime } from "../core/bot-runtime";
import { ProviderCenter } from "../core/provider-center";
import { Scheduler } from "../core/scheduler";
import { SystemKit } from "../core/system-kit";
import { ToolExecutor } from "../core/tool-executor";
import type { Bot } from "../core/types";

const bot: Bot = { id: "b1", name: "代码助手", role: "编程", persona: "", providerId: "", petEnabled: false, createdAt: 1 };

function setup(notifyOk: boolean) {
  const home = mkdtempSync(join(tmpdir(), "harness-notify-"));
  const store = new Store(home);
  const tasks = new Scheduler(home);
  const checks: string[] = [];
  const rt = new BotRuntime({
    store, providers: new ProviderCenter(store), memory: new MemorySystem(home), skills: new SkillRegistry(join(home, "skills")),
    tasks,
    executor: new ToolExecutor({ allowedRoots: [home] }, new SystemKit({ notify: () => notifyOk })),
    notifyCheck: async (title, body) => { checks.push(`${title}|${body}`); return notifyOk; },
  });
  const run = (tool: string, args: Record<string, unknown>) => (rt as any).executeBuiltin(bot, { tool, args }, "", 0, "s-1");
  return { run, tasks, checks };
}

describe("系统通知权限", () => {
  test("设提醒时确认通知能弹；没权限就如实告诉 bot", async () => {
    const { run, tasks, checks } = setup(false);
    const r = await run("task.create", { name: "喝水", in: "5m" });
    expect(tasks.listForBot("b1")).toHaveLength(1);
    expect(checks[0]).toContain("提醒已设好");
    expect(r.output).toContain("系统通知现在弹不出来");
    expect(r.output).toContain("到点时提醒会发到这个聊天里");
    expect(r.output).toContain("[去开启通知](app:settings/notifications)");
  });

  test("通知正常时只回创建结果", async () => {
    const { run } = setup(true);
    const r = await run("task.create", { name: "喝水", in: "5m" });
    expect(r.output).toStartWith("已创建一次性任务");
    expect(r.output).not.toContain("弹不出来");
  });

  test("notify 正常时照常回已通知", async () => {
    const { run } = setup(true);
    expect((await run("notify", { title: "提醒", body: "喝水" })).output).toBe("已通知: 提醒");
  });

  test("notify 被系统拦下时不能说已通知", async () => {
    const { run } = setup(false);
    const r = await run("notify", { title: "提醒", body: "喝水" });
    expect(r.output).toContain("没弹出来");
    expect(r.output).not.toStartWith("已通知");
    expect(r.output).toContain("app:settings/notifications");
  });
});
