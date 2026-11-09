import { describe, expect, test } from "bun:test";
import {
  BrowserPresence,
  browserPartition,
  formatBrowserPresenceLine,
  formatBrowserSnapshot,
  type BrowserHost,
  type BrowserSnapshot,
} from "../core/browser-presence";
import { ConsentCenter } from "../core/consent-center";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function mockHost(): BrowserHost & { calls: string[]; snapshots: BrowserSnapshot[] } {
  const calls: string[] = [];
  const pages = new Map<string, { url: string; title: string }>();
  const host: BrowserHost & { calls: string[]; snapshots: BrowserSnapshot[] } = {
    calls,
    snapshots: [],
    partitionOf: (botId) => browserPartition(botId),
    async open(botId, url) {
      calls.push(`open:${botId}:${url ?? ""}`);
      const u = url || "about:blank";
      pages.set(botId, { url: u, title: u === "about:blank" ? "" : "Page" });
      return { ok: true, url: u, title: pages.get(botId)!.title };
    },
    async goto(botId, url) {
      calls.push(`goto:${botId}:${url}`);
      pages.set(botId, { url, title: "Gone" });
      return { ok: true, url, title: "Gone" };
    },
    async snapshot(botId) {
      calls.push(`snapshot:${botId}`);
      const page = pages.get(botId) ?? { url: "about:blank", title: "" };
      const snap = formatBrowserSnapshot({
        url: page.url,
        title: page.title,
        elements: [
          { selector: "#email", role: "textbox", name: "邮箱", tag: "input" },
          { selector: "#pw", role: "textbox", name: "密码", tag: "input" },
          { selector: "button.submit", role: "button", name: "登录", tag: "button" },
        ],
      });
      host.snapshots.push(snap);
      return { ok: true, snapshot: snap };
    },
    async click(botId, target) {
      calls.push(`click:${botId}:${target.selector}`);
      return { ok: true, detail: `已点击 ${target.selector}` };
    },
    async type(botId, target) {
      calls.push(`type:${botId}:${target.selector}:${target.text}:${!!target.submit}`);
      return { ok: true, detail: target.submit ? "已输入并提交" : "已输入" };
    },
    async keys(botId, keys) {
      calls.push(`keys:${botId}:${keys}`);
      return { ok: true, detail: `已送按键 ${keys}` };
    },
    async read(botId) {
      calls.push(`read:${botId}`);
      const page = pages.get(botId) ?? { url: "about:blank", title: "" };
      return { ok: true, result: { ...page, text: "正文摘录" } };
    },
    async stop(botId) {
      calls.push(`stop:${botId}`);
      pages.delete(botId);
    },
  };
  return host;
}

describe("browser-presence", () => {
  test("partition 按 bot 隔离", () => {
    expect(browserPartition("a/b")).toBe("persist:bot-browser-a_b");
    expect(browserPartition("alice")).not.toBe(browserPartition("bob"));
  });

  test("snapshot 编出 e1/e2 ref", () => {
    const snap = formatBrowserSnapshot({
      url: "https://x.test",
      title: "登录",
      elements: [{ selector: "#u", role: "textbox", name: "用户", tag: "input", value: "" }],
    });
    expect(snap.refs.e1).toBe("#u");
    expect(snap.text).toContain("[e1]");
    expect(snap.text).toContain("textbox");
  });

  test("open → snapshot → type → click 调用序；stop 保留分区语义（host 不 clear）", async () => {
    const host = mockHost();
    const p = new BrowserPresence(host);
    const opened = await p.open("b1", "https://chat.deepseek.com");
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.state.phase).toBe("ready");
    expect(formatBrowserPresenceLine(opened.state)).toContain("浏览器");

    const snap = await p.takeSnapshot("b1");
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    expect(snap.output).toContain("[e1]");

    const typed = await p.type("b1", { ref: "e1", text: "user@x.com" });
    expect(typed.ok).toBe(true);
    expect(host.calls.some((c) => c.includes("type:b1:#email:user@x.com"))).toBe(true);

    const clicked = await p.click("b1", { ref: "e3" });
    expect(clicked.ok).toBe(true);
    expect(host.calls.some((c) => c.includes("click:b1:button.submit"))).toBe(true);

    const bad = await p.click("b1", { ref: "e99" });
    expect(bad.ok).toBe(false);

    await p.stop("b1");
    expect(p.snapshot("b1")?.phase).toBe("closed");
    expect(host.partitionOf("b1")).toBe("persist:bot-browser-b1");
    expect(host.calls.filter((c) => c.startsWith("stop:")).length).toBe(1);
  });

  test("goto 未开时会先 open", async () => {
    const host = mockHost();
    const p = new BrowserPresence(host);
    const r = await p.goto("b2", "https://example.com");
    expect(r.ok).toBe(true);
    expect(host.calls[0]).toStartWith("open:b2:");
  });

  test("最多 4 个槽：开第 5 个会挤掉最早的", async () => {
    const host = mockHost();
    const p = new BrowserPresence(host, { maxSlots: 4 });
    for (let i = 0; i < 4; i++) await p.open(`b${i}`);
    expect(p.list()).toHaveLength(4);
    await p.open("b4");
    expect(p.list().some((s) => s.botId === "b0")).toBe(false);
    expect(p.list().some((s) => s.botId === "b4")).toBe(true);
  });
});

describe("browser consent", () => {
  test("Ask 弹卡；Auto / Always 跳过", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-bb-"));
    const asked: string[] = [];
    const c = new ConsentCenter(home);
    c.decider = async (req) => {
      asked.push(req.cap);
      return "allow" as const;
    };
    const a = await c.requestBrowserOpen("bot", "打开浏览器");
    expect(a.granted).toBe(true);
    expect(asked).toEqual(["browser:open"]);

    asked.length = 0;
    c.setPermissionMode("bot2", "auto");
    const b = await c.requestBrowserOpen("bot2", "打开");
    expect(b.granted).toBe(true);
    expect(asked).toEqual([]);

    c.setPermissionMode("bot3", "always");
    const d = await c.requestBrowserOpen("bot3", "打开");
    expect(d.granted).toBe(true);
    expect(asked).toEqual([]);
  });

  test("无人值守不弹卡", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-bb-u-"));
    const c = new ConsentCenter(home);
    let asked = 0;
    c.decider = async () => { asked++; return "deny" as const; };
    const r = await c.requestBrowserOpen("bot", "打开", { unattended: true });
    expect(r.granted).toBe(true);
    expect(asked).toBe(0);
  });
});
