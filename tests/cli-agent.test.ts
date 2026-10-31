import { describe, expect, test, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  agentCliArgs,
  buildAgentPrompt,
  resolveAgentCwd,
  resolveCwdInput,
  resetCliAgentBusyForTests,
  runCliAgent,
  CliAgentPathError,
} from "../core/cli-agent";

afterEach(() => resetCliAgentBusyForTests());

describe("cli-agent 路径与提示", () => {
  test("拒绝家目录与 Harness 数据目录", () => {
    const home = homedir();
    expect(() => resolveAgentCwd(home)).toThrow(CliAgentPathError);
    expect(() => resolveAgentCwd("/")).toThrow(CliAgentPathError);
    const h = mkdtempSync(join(tmpdir(), "harness-home-"));
    mkdirSync(join(h, "workspace"));
    expect(() => resolveAgentCwd(h, { harnessHome: h })).toThrow(/Harness 数据目录/);
    expect(() => resolveAgentCwd(join(h, "workspace"), { harnessHome: h })).toThrow(/Harness 数据目录/);
  });

  test("拒绝相对路径", () => {
    expect(() => resolveAgentCwd("relative/proj")).toThrow(/绝对路径/);
  });

  test("接受普通工程目录", () => {
    const dir = mkdtempSync(join(tmpdir(), "proj-"));
    writeFileSync(join(dir, "a.txt"), "x");
    expect(resolveAgentCwd(dir)).toBe(realpathSync(dir));
  });

  test("cwd 回落 PROJECT_ROOT / agentCwd", () => {
    expect(resolveCwdInput({}, {})).toBe("");
    expect(resolveCwdInput({ cwd: " /tmp/x " }, {})).toBe("/tmp/x");
    expect(resolveCwdInput({}, { projectRoot: "/p" })).toBe("/p");
    expect(resolveCwdInput({}, { agentCwd: "/agent" })).toBe("/agent");
    expect(resolveCwdInput({}, { projectRoot: "/p", agentCwd: "/agent" })).toBe("/p");
  });

  test("agent 参数：cursor 可写且非 ask；codex workspace-write", () => {
    const c = agentCliArgs("cursor", "fix bug", "/repo");
    expect(c).toContain("-p");
    expect(c).toContain("--force");
    expect(c).toContain("--sandbox");
    expect(c).toContain("disabled");
    expect(c).toContain("/repo");
    expect(c.join(" ")).not.toContain("--mode");

    const x = agentCliArgs("codex", "fix", "/repo");
    expect(x.slice(0, 3)).toEqual(["exec", "--skip-git-repo-check", "-s"]);
    expect(x).toContain("workspace-write");
    expect(x).toContain("-C");

    const cl = agentCliArgs("claude", "fix", "/repo");
    expect(cl).toContain("--dangerously-skip-permissions");
    expect(cl.join(" ")).not.toContain('--tools ""');
  });

  test("提示含任务与 cwd，不含密钥字样模板", () => {
    const p = buildAgentPrompt({ task: "加个按钮", cwd: "/repo", botName: "改包助手" });
    expect(p).toContain("改包助手");
    expect(p).toContain("/repo");
    expect(p).toContain("加个按钮");
    expect(p).not.toContain("{{secret");
  });
});

describe("cli-agent spawn", () => {
  test("mock 成功退出收集 stdout；busy 互斥", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-ok-"));
    const spawnImpl = ((_bin: string, _args: string[]) => {
      const ee = new EventEmitter() as any;
      ee.stdout = new EventEmitter();
      ee.stderr = new EventEmitter();
      ee.killed = false;
      ee.kill = () => {
        ee.killed = true;
        queueMicrotask(() => ee.emit("close", -1));
      };
      queueMicrotask(() => {
        ee.stdout.emit("data", Buffer.from("changed files\n"));
        ee.emit("close", 0);
      });
      return ee;
    }) as any;

    const r = await runCliAgent("b1", {
      task: "fix",
      cwd: dir,
      cli: "cursor",
      spawnImpl,
      timeoutMs: 5_000,
    });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("changed files");

    // busy：卡住第一个
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const spawnBusy = ((_bin: string, _args: string[]) => {
      const ee = new EventEmitter() as any;
      ee.stdout = new EventEmitter();
      ee.stderr = new EventEmitter();
      ee.killed = false;
      ee.kill = () => {
        ee.killed = true;
        queueMicrotask(() => ee.emit("close", -1));
      };
      void gate.then(() => ee.emit("close", 0));
      return ee;
    }) as any;

    const p1 = runCliAgent("b2", { task: "a", cwd: dir, cli: "cursor", spawnImpl: spawnBusy, timeoutMs: 10_000 });
    await new Promise((r) => setTimeout(r, 20));
    const p2 = await runCliAgent("b2", { task: "b", cwd: dir, cli: "cursor", spawnImpl, timeoutMs: 5_000 });
    expect(p2.ok).toBe(false);
    expect(p2.output).toContain("已有一个");
    release();
    await p1;
  });

  test("abort 取消", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-abort-"));
    const ac = new AbortController();
    const spawnImpl = ((_bin: string, _args: string[]) => {
      const ee = new EventEmitter() as any;
      ee.stdout = new EventEmitter();
      ee.stderr = new EventEmitter();
      ee.killed = false;
      ee.kill = () => {
        ee.killed = true;
        queueMicrotask(() => ee.emit("close", -1));
      };
      return ee;
    }) as any;
    const p = runCliAgent("b3", {
      task: "long",
      cwd: dir,
      cli: "cursor",
      spawnImpl,
      signal: ac.signal,
      timeoutMs: 30_000,
    });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    const r = await p;
    expect(r.cancelled).toBe(true);
    expect(r.ok).toBe(false);
  });

  test("onProgress 收到 stdout 尾", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-prog-"));
    const tips: string[] = [];
    const spawnImpl = ((_bin: string, _args: string[]) => {
      const ee = new EventEmitter() as any;
      ee.stdout = new EventEmitter();
      ee.stderr = new EventEmitter();
      ee.killed = false;
      ee.kill = () => {
        ee.killed = true;
      };
      queueMicrotask(() => {
        ee.stdout.emit("data", Buffer.from("step one doing stuff\n"));
        ee.emit("close", 0);
      });
      return ee;
    }) as any;
    const r = await runCliAgent("b4", {
      task: "x",
      cwd: dir,
      cli: "cursor",
      spawnImpl,
      onProgress: (t) => tips.push(t),
      timeoutMs: 5_000,
    });
    expect(r.ok).toBe(true);
    expect(tips.some((t) => t.includes("step one"))).toBe(true);
  });
});
