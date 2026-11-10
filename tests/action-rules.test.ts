import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionRuleStore, actionSummary } from "../core/action-rules";
import { ConsentCenter } from "../core/consent-center";

describe("ActionRuleStore", () => {
  test("ask_first 优先于 allow；关键词匹配", () => {
    const home = mkdtempSync(join(tmpdir(), "harness-ar-"));
    const store = new ActionRuleStore(home);
    store.add("webhook", "allow");
    store.add("发外部", "ask_first");
    expect(store.match(actionSummary("webhook.post", "发外部邮件")).decision).toBe("ask_first");
    expect(store.match(actionSummary("webhook.post", "推送状态")).decision).toBe("allow");
    expect(store.match(actionSummary("fs.read", "读文件"))).toBeNull();
  });

  test("各类最多 20 条", () => {
    const home = mkdtempSync(join(tmpdir(), "harness-ar-cap-"));
    const store = new ActionRuleStore(home);
    for (let i = 0; i < 20; i++) store.add(`规则${i}`, "ask_first");
    expect(() => store.add("再一条", "ask_first")).toThrow(/最多/);
  });
});

describe("ConsentCenter + ActionRule", () => {
  test("Ask first 强制弹卡，即使 Auto", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-ar-c-"));
    const c = new ConsentCenter(home);
    c.setPermissionMode("b1", "auto");
    c.actionRules.add("webhook", "ask_first");
    let asked = 0;
    c.decider = async () => {
      asked++;
      return "allow-once";
    };
    const r = await c.request("b1", "webhook:out", "发 webhook.post", { tool: "webhook.post" });
    expect(r.granted).toBe(true);
    expect(asked).toBe(1);
  });

  test("Allow 规则在 Ask 下可跳过常规询问", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-ar-allow-"));
    const c = new ConsentCenter(home);
    c.actionRules.add("browser.open", "allow");
    let asked = 0;
    c.decider = async () => {
      asked++;
      return "deny";
    };
    const r = await c.requestBrowserOpen("b1", "打开内部浏览器", { tool: "browser.open" });
    expect(r.granted).toBe(true);
    expect(asked).toBe(0);
  });

  test("无人值守 + Ask first → 拒绝（停在批准点）", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-ar-u-"));
    const c = new ConsentCenter(home);
    c.actionRules.add("删除", "ask_first");
    const r = await c.request("b1", "fs", "删除临时文件", { tool: "fs.write", unattended: true });
    expect(r.granted).toBe(false);
  });

  test("风险卡「总是允许」写入 Allow 规则后，同类路径不再问", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-ar-path-"));
    const c = new ConsentCenter(home);
    let asked = 0;
    c.decider = async (req) => {
      asked++;
      expect(req.suggestAllowRule).toBe("/Volumes/zjySD/lg");
      return "allow-command";
    };
    const first = await c.requestCommand("b1", "ls", "执行命令: ls -lt /Volumes/zjySD/lg", {
      onceOnly: true,
      reasons: ["会访问白名单外的路径 /Volumes/zjySD/lg"],
      suggestAllowRule: "/Volumes/zjySD/lg",
    });
    expect(first.granted).toBe(true);
    expect(asked).toBe(1);
    expect(c.actionRules.list("allow").some((r) => r.text === "/Volumes/zjySD/lg")).toBe(true);

    asked = 0;
    c.decider = async () => {
      asked++;
      return "deny";
    };
    const second = await c.requestCommand("b1", "ls", "执行命令: ls /Volumes/zjySD/lg/Foo", {
      onceOnly: true,
      reasons: ["会访问白名单外的路径 /Volumes/zjySD/lg/Foo"],
      suggestAllowRule: "/Volumes/zjySD/lg/Foo",
    });
    expect(second.granted).toBe(true);
    expect(asked).toBe(0);
  });
});
