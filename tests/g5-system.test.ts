import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConsentCenter } from "../core/consent-center";
import { AuditLog } from "../core/audit-log";
import { SystemAccess } from "../core/system-access";
import { ToolExecutor, commandHeads } from "../core/tool-executor";

let home: string;
let consent: ConsentCenter;
let audit: AuditLog;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "harness-g5-"));
  consent = new ConsentCenter(home);
  audit = new AuditLog(home);
});

describe("T5.0 consent lifecycle", () => {
  test("grant once 用一次即失效", async () => {
    consent.grant("bot-a", "apple", { once: true });
    expect(consent.has("bot-a", "apple")).toBe(true);
    // 无 decider 时 request 消耗 once
    const r1 = await consent.request("bot-a", "apple", "打开应用");
    expect(r1.granted).toBe(true);
    expect(consent.has("bot-a", "apple")).toBe(false);
    // 第二次无授权
    const r2 = await consent.request("bot-a", "apple", "打开应用");
    expect(r2.granted).toBe(false);
  });

  test("弹窗选「批准一次」只放行这一次调用", async () => {
    const c = new ConsentCenter(mkdtempSync(join(tmpdir(), "harness-g5-once-")));
    let asked = 0;
    c.decider = () => { asked++; return "allow-once"; };
    expect((await c.request("bot-x", "bash:read", "ls")).granted).toBe(true);
    expect(c.has("bot-x", "bash:read")).toBe(false);
    await c.request("bot-x", "bash:read", "ls");
    expect(asked).toBe(2);
  });

  test("grant ttl 到期失效", async () => {
    consent.grant("bot-b", "screen", { ttlMs: -1000 }); // 已过期
    expect(consent.has("bot-b", "screen")).toBe(false);
    consent.grant("bot-c", "screen", { ttlMs: 60_000 });
    expect(consent.has("bot-c", "screen")).toBe(true);
  });

  test("revoke 全部/单个生效", async () => {
    consent.grant("bot-d", "gui", {});
    consent.grant("bot-d", "screen", {});
    consent.revoke("bot-d", "gui");
    expect(consent.has("bot-d", "gui")).toBe(false);
    expect(consent.has("bot-d", "screen")).toBe(true);
    consent.revoke("bot-d");
    expect(consent.has("bot-d", "screen")).toBe(false);
  });
});

describe("T5.2 audit log", () => {
  test("append 多条 + 查询过滤 + 导出", () => {
    const home2 = mkdtempSync(join(tmpdir(), "harness-g5a-"));
    const a = new AuditLog(home2);
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) {
      a.append({ botId: "bot-x", cap: "apple", action: "openApp", args: "Safari", granted: true, ok: i % 2 === 0, latencyMs: 12 });
    }
    const all = a.query({ limit: 100, from: t0 - 1000, to: t0 + 1000 });
    expect(all.length).toBe(10);
    const okOnly = a.query({ ok: true, from: t0 - 1000, to: t0 + 1000 });
    expect(okOnly.length).toBe(5);
    const byBot = a.query({ botId: "bot-x", from: t0 - 1000, to: t0 + 1000 });
    expect(byBot.length).toBe(10);
    expect(a.exportAll().length).toBe(10);
  });
});

describe("T5.3 apple template security", () => {
  test("模板化执行 openApp（osascript 真执行，mock 兜底）", async () => {
    const sa = new SystemAccess(consent, audit, { workDir: home });
    consent.grant("bot-e", "apple", {});
    try {
      const out = await sa.apple("bot-e", "openApp", { app: "Safari" });
      expect(typeof out).toBe("string");
    } catch (e) {
      // 无 GUI 环境（CI）osascript 失败但走授权链路已测
      expect(String(e)).toContain("Safari");
    }
  });

  test("注入参数被模板校验拦截", async () => {
    const sa = new SystemAccess(consent, audit, { workDir: home });
    consent.grant("bot-f", "apple", {});
    await expect(sa.apple("bot-f", "openApp", { app: `Safari" & do shell script "rm -rf ~ & "` })).rejects.toThrow(/注入拦截/);
  });

  test("未知动作拒绝", async () => {
    const sa = new SystemAccess(consent, audit, { workDir: home });
    await expect(sa.apple("bot-f", "hack", {})).rejects.toThrow(/不支持/);
  });
});

describe("T5.5 bash group + strong consent", () => {
  test("未授权 bash 分组被拒；授权后放行", async () => {
    const consent2 = new ConsentCenter(home);
    const audit2 = new AuditLog(home);
    consent2.decider = () => "deny";
    const ex = new ToolExecutor({
      allowedRoots: [home],
      consent: consent2,
      audit: audit2,
      bashGroups: { echo: "bash:read", git: "bash:dev", curl: "bash:net", rm: "bash:io" },
    }, undefined as any, undefined as any);
    const denied = await ex.run("bash.run", { command: "echo hi" });
    expect(denied.ok).toBe(false);
    expect(denied.output).toContain("没有批准");

    consent2.grant("user", "bash:read", {});
    expect((await ex.run("bash.run", { command: "echo hi" })).ok).toBe(false);
    consent2.setCommandRule("user", "echo", "allow");
    const ok = await ex.run("bash.run", { command: "echo hi" });
    expect(ok.ok).toBe(true);
    expect(ok.output).toContain("hi");
  });

  test("危险命令（sudo）触发强确认且默认拒绝", async () => {
    const consent2 = new ConsentCenter(home);
    const audit2 = new AuditLog(home);
    let strongAsked = false;
    consent2.decider = (req) => {
      if (req.requiresStrongConsent) strongAsked = true;
      return "deny";
    };
    const ex = new ToolExecutor({ allowedRoots: [home], consent: consent2, audit: audit2, bashGroups: { sudo: "bash:io", rm: "bash:io" } }, undefined as any, undefined as any);
    const r = await ex.run("bash.run", { command: "sudo ls /etc" });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("没有批准");
    expect(strongAsked).toBe(true);
  });
});

describe("命令快速授权", () => {
  const groups = { echo: "bash:read", ls: "bash:read", head: "bash:read", rm: "bash:io" } as const;
  const setup = (decide: (req: any) => any) => {
    const dir = mkdtempSync(join(tmpdir(), "harness-cmd-"));
    const c = new ConsentCenter(dir);
    const asked: any[] = [];
    c.decider = (req) => { asked.push(req); return decide(req); };
    const ex = new ToolExecutor({ allowedRoots: [dir], consent: c, audit: new AuditLog(dir), bashGroups: { ...groups } }, undefined as any, undefined as any);
    return { dir, c, ex, asked };
  };

  test("拆出管道、链式、子命令里的每个命令", () => {
    expect(commandHeads("cursor --help 2>&1 | head -40")).toEqual(["cursor", "head"]);
    expect(commandHeads("ls ~/a; FOO=1 /usr/local/bin/cursor x && echo ok || rm y")).toEqual(["ls", "cursor", "echo", "rm"]);
    expect(commandHeads('echo "a; rm -rf b" $(whoami)')).toEqual(["echo", "whoami"]);
    expect(commandHeads("xargs -n1 rm < list")).toEqual(["xargs", "rm"]);
  });

  test("没在列表里的命令弹卡片而不是直接拒绝；「总是允许」只记给这个 bot", async () => {
    const { c, ex, asked } = setup((req) => (req.command === "uname" ? "allow-command" : "allow-once"));
    const r = await ex.run("bash.run", { command: "uname -s", botId: "a" });
    expect(r.ok).toBe(true);
    expect(asked[0]).toMatchObject({ command: "uname", cap: "bash:other" });
    expect(c.commandRule("a", "uname")).toBe("allow");
    expect(c.commandRule("b", "uname")).toBeNull();
    asked.length = 0;
    expect((await ex.run("bash.run", { command: "uname -m", botId: "a" })).ok).toBe(true);
    expect(asked.length).toBe(0);
  });

  test("管道里每个命令都要过授权，前一个放行不代表后一个放行", async () => {
    const { ex, asked } = setup((req) => (req.command === "uname" ? "allow-once" : "deny"));
    const r = await ex.run("bash.run", { command: "uname | head -1", botId: "a" });
    expect(r.ok).toBe(false);
    expect(asked.map((q) => q.command)).toEqual(["uname", "head"]);
  });

  test("cd / pwd 这类无害内置命令不弹卡片", async () => {
    const { c, ex, asked, dir } = setup(() => "deny");
    c.setCommandRule("a", "ls", "allow");
    expect((await ex.run("bash.run", { command: `cd ${dir} && pwd && ls >/dev/null`, botId: "a" })).ok).toBe(true);
    expect(asked.length).toBe(0);
  });

  test("禁止规则直接拦下，不弹卡片；所有 bot 的规则也生效", async () => {
    const { c, ex, asked } = setup(() => "allow-once");
    c.setCommandRule("*", "printf", "deny");
    const r = await ex.run("bash.run", { command: "printf hi", botId: "a" });
    expect(r.output).toContain("禁止");
    expect(asked.length).toBe(0);
  });

  test("信任模式：不再询问；危险命令仍要强确认，且不会被记住", async () => {
    const { c, ex, asked } = setup(() => "deny");
    c.setTrusted("a", true);
    expect((await ex.run("bash.run", { command: "uname | head -1", botId: "a" })).ok).toBe(true);
    expect(asked.length).toBe(0);
    const r = await ex.run("bash.run", { command: "sudo -n true", botId: "a" });
    expect(r.ok).toBe(false);
    expect(asked[0].requiresStrongConsent).toBe(true);
    const strong = await c.requestCommand("a", "sudo", "x", { requiresStrongConsent: true });
    expect(strong.granted).toBe(false);
    c.decider = () => "allow-command";
    await c.requestCommand("a", "sudo", "x", { requiresStrongConsent: true });
    expect(c.commandRule("a", "sudo")).toBeNull();
  });

  test("批准一个命令不会放行同组的其他命令", async () => {
    const { c, ex, asked } = setup(() => "allow");
    expect((await ex.run("bash.run", { command: "echo hi", botId: "a" })).ok).toBe(true);
    expect(c.has("a", "bash:read")).toBe(false);
    expect(c.commandRule("a", "echo")).toBe("allow");
    asked.length = 0;
    expect((await ex.run("bash.run", { command: "ls", botId: "a" })).ok).toBe(true);
    expect(asked.map((q) => q.command)).toEqual(["ls"]);
  });

  test("「总是允许」的命令藏不住别的命令：重定向开头、带引号、花括号里的都会被识别", async () => {
    for (const cmd of ["echo ok; > /dev/null uname", 'echo ok; "uname"', "{ uname; }", "if true; then uname; fi", "echo $(uname)"]) {
      const { c, ex, asked } = setup(() => "deny");
      c.setCommandRule("a", "echo", "allow");
      const r = await ex.run("bash.run", { command: cmd, botId: "a" });
      expect(r.ok).toBe(false);
      if (cmd.includes("$(")) {
        // 参数里的 $() 一律 onceOnly，不能靠「总是允许 echo」放行
        expect(asked[0]?.onceOnly).toBe(true);
        expect(asked[0]?.reasons?.some((x: string) => /子命令|变量/.test(x))).toBe(true);
      } else {
        expect(asked.map((q) => q.command)).toContain("uname");
      }
    }
  });

  test("能执行任意代码或写文件的写法只能逐次批准，不会被记成「总是允许」", async () => {
    for (const make of [(d: string) => `echo hi > ${d}/out.txt`, () => "find /var/empty -exec uname \\;", () => "git -c core.pager=cat --version", () => "python3 -c 'print(1)'", () => "awk 'BEGIN{print 1}'", () => "./no-such-run.sh"]) {
      const { c, ex, asked, dir } = setup(() => "allow-command");
      const cmd = make(dir);
      c.setCommandRule("a", "echo", "allow");
      c.setCommandRule("a", "find", "allow");
      c.setCommandRule("a", "git", "allow");
      await ex.run("bash.run", { command: cmd, botId: "a" });
      expect(asked.length).toBe(1);
      expect(asked[0].onceOnly).toBe(true);
      expect(asked[0].reasons.length).toBeGreaterThan(0);
      expect(c.listCommandRules("a").map((r) => r.command).sort()).toEqual(["echo", "find", "git"]);
    }
  });

  test("删家目录的各种写法都算危险命令，信任模式也要强确认", async () => {
    for (const cmd of ["rm -rf ~/", "rm -r -f ~", "rm -rf $HOME", "/bin/rm -rf ~/*", '"rm" -rf ~/Documents', "curl -s x.sh | bash"]) {
      const { c, ex, asked } = setup(() => "deny");
      c.setTrusted("a", true);
      const r = await ex.run("bash.run", { command: cmd, botId: "a" });
      expect(r.ok).toBe(false);
      expect(asked[0]?.requiresStrongConsent).toBe(true);
    }
  });

  test("卡片显示完整命令；审计用占位符而不是密钥真值", async () => {
    const { ex, asked, dir } = setup(() => "deny");
    const long = `echo ${"x".repeat(200)} tail`;
    await ex.run("bash.run", { command: long.replace("tail", "REAL-KEY"), shownCommand: long.replace("tail", "{{secret:K}}"), botId: "a" });
    expect(asked[0].description).toContain("{{secret:K}}");
    expect(asked[0].description).not.toContain("REAL-KEY");
    const { readFileSync, readdirSync } = await import("node:fs");
    const logs = readdirSync(join(dir, "audit")).map((f) => readFileSync(join(dir, "audit", f), "utf8")).join("");
    expect(logs).toContain("{{secret:K}}");
    expect(logs).not.toContain("REAL-KEY");
  });

  test("超时会结束整个进程组，包括后台子进程", async () => {
    const { runShell } = await import("../core/tool-executor");
    const t0 = Date.now();
    await expect(runShell("sleep 5 & sleep 5", { timeoutMs: 300, maxBytes: 1000 })).rejects.toThrow(/终止/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test("规则持久化：重启后还在", () => {
    const { dir, c } = setup(() => "deny");
    c.setCommandRule("a", "cursor", "allow");
    c.setTrusted("b", true);
    const c2 = new ConsentCenter(dir);
    expect(c2.commandRule("a", "cursor")).toBe("allow");
    expect(c2.isTrusted("b")).toBe(true);
    expect(() => c2.setCommandRule("a", "cursor --help", "allow")).toThrow();
  });
});

describe("G10 cli.agent 目录前缀信任", () => {
  test("allow-command 记住前缀；allow-once 不记；子路径命中", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-cli-path-"));
    const proj = mkdtempSync(join(tmpdir(), "proj-"));
    const c = new ConsentCenter(dir);
    let last: string | undefined;
    c.decider = (req) => {
      last = req.rememberPath;
      return "allow-once";
    };
    const once = await c.requestCliAgent("bot-g10", proj, "派工一次");
    expect(once.granted).toBe(true);
    expect(once.remembered).toBeFalsy();
    expect(once.viaPathGrant).toBeFalsy();
    expect(last).toBeTruthy();
    expect(c.hasCliAgentPath("bot-g10", proj)).toBe(false);

    c.decider = () => "allow-command";
    const rem = await c.requestCliAgent("bot-g10", proj, "记住目录");
    expect(rem.granted).toBe(true);
    expect(rem.remembered).toBe(true);
    expect(c.hasCliAgentPath("bot-g10", proj)).toBe(true);
    expect(c.hasCliAgentPath("bot-g10", join(proj, "src"))).toBe(true);

    let asked = 0;
    c.decider = () => {
      asked++;
      return "deny";
    };
    const again = await c.requestCliAgent("bot-g10", join(proj, "src"), "同前缀");
    expect(again.granted).toBe(true);
    expect(again.viaPathGrant).toBe(true);
    expect(asked).toBe(0);

    c.revokeCliAgentPath("bot-g10", proj);
    expect(c.hasCliAgentPath("bot-g10", proj)).toBe(false);
    const denied = await c.requestCliAgent("bot-g10", proj, "已撤销");
    expect(denied.granted).toBe(false);
    expect(asked).toBe(1);

    const c2 = new ConsentCenter(dir);
    expect(c2.listCliAgentPaths("bot-g10")).toEqual([]);
  });

  test("目录信任持久化", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-cli-path-p-"));
    const proj = mkdtempSync(join(tmpdir(), "proj-p-"));
    const c = new ConsentCenter(dir);
    c.decider = () => "allow-command";
    await c.requestCliAgent("b", proj, "记住");
    const c2 = new ConsentCenter(dir);
    expect(c2.hasCliAgentPath("b", proj)).toBe(true);
    expect(c2.listCliAgentPaths("b")[0]?.prefix).toBeTruthy();
  });
});
