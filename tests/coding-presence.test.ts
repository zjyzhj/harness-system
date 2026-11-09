import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliAgentRequest } from "../core/cli-agent";
import { CodingPresence, decodeTermKeys, dropCodingDir, formatCodingDirLine, formatPresenceLine, gazeCodingDir, presenceTaskLine, terminalPosture } from "../core/coding-presence";
import { FrameDecoder, TermScreen, encodeFrame } from "../core/term-screen";

function req(over: Partial<CliAgentRequest> & { spawnImpl?: unknown }): CliAgentRequest {
  return {
    task: "改按钮",
    cwd: "/repo",
    cli: "claude",
    promptText: "改按钮",
    ...over,
    spawnImpl: over.spawnImpl as CliAgentRequest["spawnImpl"],
  };
}

function echoSpawn(opts?: { die?: boolean }) {
  let n = 0;
  const spawnImpl = () => {
    n += 1;
    const ee = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: (s: Buffer | string) => void; end: () => void };
      kill: () => void;
      pid: number;
    };
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    const dec = new FrameDecoder();
    ee.stdin = {
      write(s: Buffer | string) {
        const chunk = Buffer.isBuffer(s) ? s : Buffer.from(s);
        for (const frame of dec.push(chunk)) {
          if (frame.type === 1) {
            ee.stdout.emit("data", encodeFrame(1, frame.payload));
            if (opts?.die) {
              ee.stdout.emit("data", encodeFrame(2, Buffer.alloc(4)));
              ee.emit("close", 0);
            }
          }
          if (frame.type === 3) ee.emit("close", 0);
        }
      },
      end() {},
    };
    ee.kill = () => ee.emit("close", 0);
    ee.pid = 40 + n;
    return ee;
  };
  return { spawnImpl: spawnImpl as unknown as CliAgentRequest["spawnImpl"], get n() { return n; } };
}

function presence(over?: { idleMs?: number }) {
  return new CodingPresence({ quietMs: 60, settleMs: 0, idleMs: over?.idleMs ?? 60_000 });
}

describe("终端屏幕", () => {
  test("普通输入、回车和清屏", () => {
    const s = new TermScreen(20, 6);
    s.feed("hello");
    expect(s.text()).toBe("hello");
    s.feed("\r\nnext");
    expect(s.text()).toContain("hello");
    expect(s.text()).toContain("next");
    s.feed("\u001b[2J\u001b[Honly");
    expect(s.text()).toBe("only");
  });

  test("感知行带上屏幕尾部", () => {
    const now = 1_700_000_000_000;
    const line = formatPresenceLine({
      botId: "b", cli: "claude", program: { kind: "agent", cli: "claude" }, cwd: "/repo", phase: "idle", resident: true,
      startedAt: now, lastActiveAt: now, screen: "hello", screenTail: "hello",
    }, now);
    expect(line).toContain("【终端】");
    expect(line).toContain("claude");
    expect(line).toContain("hello");
    expect(line).toContain("开着");
    expect(line).toContain("down");
    expect(line).toContain("不要说终端不在线");
  });

  test("字停在输入框时告诉 bot 送出，不要说不在线", () => {
    const screen = "> 约束：\n- 你是主控\n- 最后收尾加一个表情";
    expect(terminalPosture(screen)).toBe("composing");
    expect(terminalPosture(">\n")).toBe("prompt");
    expect(terminalPosture("正在改文件\nesc to interrupt")).toBe("running");
    expect(terminalPosture("Working 6 tokens\n→ Add a follow-up\n~/Desktop/CompressedImages")).toBe("prompt");
    expect(terminalPosture("Working 6 tokens\n")).toBe("prompt");
    const line = formatPresenceLine({
      botId: "b", cli: "claude", program: { kind: "agent", cli: "claude" }, cwd: "/repo", phase: "idle", resident: true,
      startedAt: 1, lastActiveAt: 1, screen, screenTail: screen, posture: "composing",
    }, 1);
    expect(line).toContain("字停在输入框");
    expect(line).toContain("enter");
    expect(line).toContain("不要说终端不在线");
    expect(line).toContain("不要重新打开");
  });

  test("openShell 默认开 shell，不依赖 Coding CLI", async () => {
    const live = echoSpawn();
    const p = presence();
    const opened = await p.openShell("b", "/repo", { spawnImpl: live.spawnImpl });
    expect("error" in opened).toBe(false);
    if ("error" in opened) return;
    expect(opened.program).toEqual({ kind: "shell" });
    expect(opened.cli).toBe("shell");
    p.stopAll();
  });

  test("dispatch 会把同槽 shell 换成 Coding CLI", async () => {
    const live = echoSpawn();
    const p = presence();
    await p.openShell("b", "/repo", { spawnImpl: live.spawnImpl });
    expect(p.snapshot("b")?.program.kind).toBe("shell");
    const r = await p.dispatch("b", req({ spawnImpl: live.spawnImpl }));
    expect(r.ok).toBe(true);
    expect(p.snapshot("b")?.program).toEqual({ kind: "agent", cli: "claude" });
    expect(live.n).toBe(2);
    p.stopAll();
  });

  test("启动失败不能停在 starting 僵尸态", async () => {
    const spawnImpl = () => {
      const ee = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter; stderr: EventEmitter;
        stdin: { write: () => void; end: () => void }; kill: () => void; pid: number;
      };
      ee.stdout = new EventEmitter();
      ee.stderr = new EventEmitter();
      ee.stdin = { write() {}, end() {} };
      ee.kill = () => ee.emit("close", 1);
      ee.pid = 99;
      queueMicrotask(() => ee.emit("close", 1));
      return ee;
    };
    const p = presence();
    const opened = await p.openShell("b", "/repo", { spawnImpl: spawnImpl as never });
    expect("error" in opened || p.snapshot("b")?.phase === "exited").toBe(true);
    const snap = p.snapshot("b");
    if (snap) expect(snap.phase).not.toBe("starting");
    p.stopAll();
  });

  test("starting 超时会收尸，不留下打开中", async () => {
    const spawnImpl = () => {
      const ee = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter; stderr: EventEmitter;
        stdin: { write: () => void; end: () => void }; kill: () => void; pid: number;
      };
      ee.stdout = new EventEmitter();
      ee.stderr = new EventEmitter();
      ee.stdin = { write() {}, end() {} };
      ee.kill = () => {};
      ee.pid = 77;
      // 故意不 close，模拟桥接挂死；settle 比超时长，好在 armIdle 前被收尸
      return ee;
    };
    const p = new CodingPresence({ quietMs: 60, settleMs: 120, idleMs: 60_000, startingTimeoutMs: 40 });
    const opened = await p.openShell("b", "/repo", { spawnImpl: spawnImpl as never });
    expect("error" in opened).toBe(true);
    if ("error" in opened) expect(opened.error).toMatch(/超时|没起来|没有留下来/);
    expect(p.snapshot("b")?.phase).not.toBe("starting");
    p.stopAll();
  });

  test("缺少桥接脚本时给出可读错误", async () => {
    const p = new CodingPresence({
      quietMs: 60, settleMs: 0,
      bridgePath: "/tmp/harness-no-such-pty-bridge.py",
      home: mkdtempSync(join(tmpdir(), "harness-bridge-miss-")),
    });
    const opened = await p.openShell("b", "/repo");
    expect("error" in opened).toBe(true);
    if ("error" in opened) expect(opened.error).toMatch(/桥接|不存在|python3/);
    p.stopAll();
  });

  test("agent 槽上再 openShell 不谎称已开 shell，返回现有屏 + notice", async () => {
    const live = echoSpawn();
    const p = presence();
    await p.dispatch("b", req({ spawnImpl: live.spawnImpl }));
    expect(p.snapshot("b")?.program.kind).toBe("agent");
    const again = await p.openShell("b", "/repo", { mode: "shell", spawnImpl: live.spawnImpl });
    expect("error" in again).toBe(false);
    if (!("error" in again)) {
      expect(again.program.kind).toBe("agent");
      expect(again.notice).toMatch(/claude|没有换成 shell/);
    }
    expect(p.snapshot("b")?.program.kind).toBe("agent");
    expect(live.n).toBe(1);
    p.stopAll();
  });

  test("冷 gaze 时 snapshot 为空，groundingSnapshot / line 仍带活槽", async () => {
    const live = echoSpawn();
    const p = presence({ idleMs: 60_000 });
    await p.openShell("b", "/repo", { spawnImpl: live.spawnImpl });
    p.focus("b", "/cold-only");
    expect(p.snapshot("b")).toBeNull();
    const g = p.groundingSnapshot("b");
    expect(g?.cwd).toBe("/repo");
    expect(g?.notice).toContain("/cold-only");
    expect(p.line("b")).toContain("/repo");
    expect(p.line("b")).toContain("/cold-only");
    p.stopAll();
  });

  test("term 读写可指定 cwd，不影响正在看的另一块", async () => {
    const live = echoSpawn();
    const p = presence({ idleMs: 60_000 });
    await p.openShell("b", "/repo", { spawnImpl: live.spawnImpl });
    await p.openShell("b", "/other", { spawnImpl: live.spawnImpl });
    expect(p.snapshot("b")?.cwd).toBe("/other");
    const typed = await p.type("b", "from-repo", { cwd: "/repo", timeoutMs: 5_000 });
    expect(typed.ok).toBe(true);
    expect(p.screenText("b", "/repo")).toContain("from-repo");
    expect(p.snapshot("b")?.cwd).toBe("/other");
    p.stop("b", "结束这块", "/repo");
    expect(p.list("b").some((v) => v.cwd === "/repo" && v.phase !== "exited")).toBe(false);
    expect(p.snapshot("b")?.cwd).toBe("/other");
    p.stopAll();
  });

  test("驱逐多余终端时带上可读原因", async () => {
    const live = echoSpawn();
    const p = presence();
    const reasons: string[] = [];
    p.setScreenListener((v) => {
      if (v.phase === "exited" && v.exitReason) reasons.push(v.exitReason);
    });
    for (const cwd of ["/a", "/b", "/c", "/d", "/e"]) {
      await p.dispatch("b", req({ spawnImpl: live.spawnImpl, cwd, promptText: cwd }));
    }
    expect(reasons.some((r) => /太多|最久没用/.test(r))).toBe(true);
    p.stopAll();
  });

  test("工程目录能记下多个，正在看的是其中一个", () => {
    const a = mkdtempSync(join(tmpdir(), "cd-a-"));
    const b = mkdtempSync(join(tmpdir(), "cd-b-"));
    const one = gazeCodingDir({}, a);
    const ca = one.agentCwd;
    expect(one.agentDirs).toEqual([ca]);
    const two = gazeCodingDir(one, b);
    const cb = two.agentCwd;
    expect(two.agentDirs).toEqual([cb, ca]);
    const back = gazeCodingDir(two, a);
    expect(back.agentCwd).toBe(ca);
    expect(back.agentDirs).toEqual([ca, cb]);
    const line = formatCodingDirLine(back);
    expect(line).toContain(ca);
    expect(line).toContain(cb);
    expect(line).toContain("正在看");
    const dropped = dropCodingDir(back, a);
    expect(dropped.agentCwd).toBe(cb);
    expect(dropped.agentDirs).toEqual([cb]);
  });

  test("按键名字变成终端能认的字节", () => {
    expect(decodeTermKeys("down enter")).toEqual({ data: "\u001b[B\r" });
    expect(decodeTermKeys("ArrowDown")).toEqual({ data: "\u001b[B" });
    expect(decodeTermKeys("\\u001b[B")).toEqual({ data: "\u001b[B" });
    expect(decodeTermKeys("ctrl-c")).toEqual({ data: "\u0003" });
    const bad = decodeTermKeys("按一下方向键");
    expect("error" in bad).toBe(true);
  });
});

describe("编码终端", () => {
  test("人可以打开终端，不往里打任务", async () => {
    const live = echoSpawn();
    const p = presence();
    const opened = await p.openShell("b", "/repo", { cli: "claude", spawnImpl: live.spawnImpl });
    expect("error" in opened).toBe(false);
    if ("error" in opened) return;
    expect(opened.phase).toBe("idle");
    expect(opened.cwd).toBe("/repo");
    expect(p.screenText("b")).not.toContain("改按钮");
    expect(live.n).toBe(1);
    const again = await p.openShell("b", "/repo", { cli: "claude", spawnImpl: live.spawnImpl });
    expect("error" in again).toBe(false);
    expect(live.n).toBe(1);
    p.stopAll();
  });

  test("第二次同目录接着输入，不重新打开", async () => {
    const live = echoSpawn();
    const tails: string[] = [];
    const p = presence();
    const first = await p.dispatch("b", req({ spawnImpl: live.spawnImpl, onProgress: (t) => tails.push(t) }));
    expect(first.ok).toBe(true);
    expect(first.keptAlive).toBe(true);
    expect(first.reused).toBe(false);
    expect(first.output).toContain("改按钮");
    expect(p.snapshot("b")?.phase).toBe("idle");
    expect(p.line("b")).toContain("改按钮");
    expect(tails.some((t) => t.includes("改按钮"))).toBe(true);

    const second = await p.dispatch("b", req({ spawnImpl: live.spawnImpl, task: "再改一处", promptText: "不该用这段" }));
    expect(second.reused).toBe(true);
    expect(second.output).toContain("再改一处");
    expect(second.output).not.toContain("不该用这段");
    expect(live.n).toBe(1);
    expect(p.screenText("b")).toContain("再改一处");
    p.stopAll();
  });

  test("多行任务收成一行；终端层不自己追加 constraints 字段", async () => {
    const live = echoSpawn();
    const p = presence();
    const result = await p.dispatch("b", req({
      spawnImpl: live.spawnImpl,
      task: "看这个项目\n然后启动",
      promptText: "看这个项目\n然后启动",
      constraints: "必须加表情",
    }));
    expect(result.ok).toBe(true);
    expect(result.output).toContain("看这个项目 然后启动");
    expect(result.output).not.toContain("必须加表情");
    expect(result.output).not.toContain("约束：");
    expect(result.output).toContain("不要说终端不在线");
    p.stopAll();
  });

  test("打进终端的第一句只有任务和上次摘要，不带规范", () => {
    const line = presenceTaskLine("看这个项目\n然后启动", { brief: "上次改了按钮" });
    expect(line).toBe("接着上次：上次改了按钮 看这个项目 然后启动");
    expect(line).not.toContain("【规范】");
  });

  test("派工把配置放进子进程环境，不覆盖 PATH", async () => {
    const live = echoSpawn();
    let seen: NodeJS.ProcessEnv | undefined;
    const spawnImpl = ((...args: unknown[]) => {
      seen = (args[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env;
      return (live.spawnImpl as () => unknown)();
    }) as CliAgentRequest["spawnImpl"];
    const p = presence();
    const result = await p.dispatch("b", req({ spawnImpl, env: { FEISHU_TOKEN: "sek", PATH: "/evil" } }));
    expect(result.ok).toBe(true);
    expect(seen?.FEISHU_TOKEN).toBe("sek");
    expect(seen?.PATH).toBe(process.env.PATH);
    expect(String(seen?.PTY_BIN || "")).not.toBe("");
    p.stopAll();
  });

  test("打进终端的一行可以超过 500 字", async () => {
    const live = echoSpawn();
    const p = presence();
    const text = "守".repeat(520);
    const result = await p.dispatch("b", req({ spawnImpl: live.spawnImpl, task: text, promptText: text }));
    expect(result.ok).toBe(true);
    expect((result.output.match(/守/g) ?? []).length).toBeGreaterThanOrEqual(520);
    p.stopAll();
  });

  test("进程退出后，下一次重新打开", async () => {
    const dying = echoSpawn({ die: true });
    const p = presence();
    const first = await p.dispatch("b", req({ spawnImpl: dying.spawnImpl }));
    expect(first.keptAlive).toBe(false);
    expect(p.snapshot("b")?.phase).toBe("exited");
    await p.dispatch("b", req({ spawnImpl: dying.spawnImpl, promptText: "第二次" }));
    expect(dying.n).toBe(2);
    p.stopAll();
  });

  test("结束看着的这块时，视线落到还开着的另一块", async () => {
    const live = echoSpawn();
    const p = presence();
    await p.dispatch("b", req({ spawnImpl: live.spawnImpl }));
    await p.dispatch("b", req({ spawnImpl: live.spawnImpl, cwd: "/other", promptText: "另一块" }));
    expect(p.snapshot("b")?.cwd).toBe("/other");
    p.stop("b", "结束这块", "/other");
    const now = p.snapshot("b");
    expect(now?.cwd).toBe("/repo");
    expect(now?.phase).not.toBe("exited");
    expect(now?.others?.some((o) => o.cwd === "/other")).toBe(false);
    p.stopAll();
  });

  test("换目录留下原来的终端，切回去不重新打开", async () => {
    const live = echoSpawn();
    const p = presence();
    await p.dispatch("b", req({ spawnImpl: live.spawnImpl }));
    await p.dispatch("b", req({ spawnImpl: live.spawnImpl, cwd: "/other", promptText: "换仓库" }));
    expect(live.n).toBe(2);
    expect(p.snapshot("b")?.cwd).toBe("/other");
    expect(p.list("b").map((v) => v.cwd).sort()).toEqual(["/other", "/repo"]);
    expect(p.line("b")).toContain("/repo");
    await p.dispatch("b", req({ spawnImpl: live.spawnImpl, promptText: "回到原来" }));
    expect(live.n).toBe(2);
    expect(p.snapshot("b")?.cwd).toBe("/repo");
    p.stop("b", "结束这块", "/other");
    expect(p.list("b").some((v) => v.cwd === "/repo" && v.phase !== "exited")).toBe(true);
    expect(p.list("b").some((v) => v.cwd === "/other")).toBe(false);
    p.stopAll();
  });

  test("一个工程在忙时，不能派另一个工程", async () => {
    const live = echoSpawn();
    const p = new CodingPresence({ quietMs: 400, settleMs: 0 });
    const first = p.dispatch("b", req({ spawnImpl: live.spawnImpl }));
    await new Promise((r) => setTimeout(r, 20));
    const second = await p.dispatch("b", req({ spawnImpl: live.spawnImpl, cwd: "/other", promptText: "别的工程" }));
    expect(second.ok).toBe(false);
    expect(second.output).toContain("/repo");
    await first;
    p.stopAll();
  });

  test("同一目录换 CLI 只关掉这一块", async () => {
    const live = echoSpawn();
    const p = presence();
    await p.dispatch("b", req({ spawnImpl: live.spawnImpl }));
    await p.dispatch("b", req({ spawnImpl: live.spawnImpl, cwd: "/other", promptText: "另一块" }));
    await p.dispatch("b", req({ spawnImpl: live.spawnImpl, cli: "codex", promptText: "换 CLI" }));
    expect(live.n).toBe(3);
    expect(p.snapshot("b")?.cli).toBe("codex");
    expect(p.snapshot("b")?.cwd).toBe("/repo");
    expect(p.list("b").some((v) => v.cwd === "/other" && v.phase !== "exited")).toBe(true);
    p.stopAll();
  });

  test("同时开着的工程超过四块时关掉最久没用的", async () => {
    const live = echoSpawn();
    const p = presence();
    for (const cwd of ["/a", "/b", "/c", "/d", "/e"]) {
      await p.dispatch("b", req({ spawnImpl: live.spawnImpl, cwd, promptText: cwd }));
    }
    const living = p.list("b").filter((v) => v.phase !== "exited");
    expect(living.length).toBeLessThanOrEqual(4);
    expect(living.some((v) => v.cwd === "/a")).toBe(false);
    expect(living.some((v) => v.cwd === "/e")).toBe(true);
    p.stopAll();
  });

  test("同一条真实路径只占一块终端", async () => {
    const live = echoSpawn();
    const p = presence();
    const dir = mkdtempSync(join(tmpdir(), "cwd-"));
    const link = join(tmpdir(), `cwd-link-${Date.now()}`);
    symlinkSync(dir, link);
    await p.dispatch("b", req({ spawnImpl: live.spawnImpl, cwd: dir, promptText: "真实路径" }));
    await p.dispatch("b", req({ spawnImpl: live.spawnImpl, cwd: link, promptText: "链接" }));
    expect(live.n).toBe(1);
    expect(p.list("b").filter((v) => v.phase !== "exited")).toHaveLength(1);
    p.stopAll();
  });

  test("看着一个还没打开的目录不会凭空启动", async () => {
    const live = echoSpawn();
    const p = presence();
    await p.dispatch("b", req({ spawnImpl: live.spawnImpl }));
    const view = p.focus("b", "/not-open");
    expect(view).toBeNull();
    expect(live.n).toBe(1);
    expect(p.list("b").some((v) => v.cwd === "/repo" && v.phase !== "exited")).toBe(true);
    p.stopAll();
  });

  test("正在忙的时候换着看，不会关掉正在忙的那块", async () => {
    const live = echoSpawn();
    const p = new CodingPresence({ quietMs: 400, settleMs: 0 });
    await p.dispatch("b", req({ spawnImpl: live.spawnImpl, cwd: "/other", promptText: "先开着" }));
    const first = p.dispatch("b", req({ spawnImpl: live.spawnImpl }));
    await new Promise((r) => setTimeout(r, 20));
    p.focus("b", "/other");
    expect(p.snapshot("b")?.cwd).toBe("/other");
    expect(p.list("b").some((v) => v.cwd === "/repo" && v.phase === "busy")).toBe(true);
    await first;
    p.stopAll();
  });

  test("按键不占派工的锁，忙的时候也能打进同一块", async () => {
    const live = echoSpawn();
    const p = new CodingPresence({ quietMs: 400, settleMs: 0, tapMs: 30 });
    const first = p.dispatch("b", req({ spawnImpl: live.spawnImpl }));
    await new Promise((r) => setTimeout(r, 20));
    expect(p.snapshot("b")?.phase).toBe("busy");
    const keys = decodeTermKeys("y");
    expect("data" in keys).toBe(true);
    if (!("data" in keys)) return;
    const tapped = await p.tap("b", keys.data);
    expect(tapped.ok).toBe(true);
    expect(tapped.output).not.toContain("等这一轮结束");
    expect(p.snapshot("b")?.phase).toBe("busy");
    await first;
    expect(p.screenText("b")).toContain("y");
    const again = await p.tap("b", "\u001b[B");
    expect(again.ok).toBe(true);
    expect(p.snapshot("b")?.phase).toBe("idle");
    p.stopAll();
  });

  test("正在输入时不能再派一个", async () => {
    const live = echoSpawn();
    const p = new CodingPresence({ quietMs: 400, settleMs: 0 });
    const first = p.dispatch("b", req({ spawnImpl: live.spawnImpl }));
    await new Promise((r) => setTimeout(r, 20));
    const second = await p.dispatch("b", req({ spawnImpl: live.spawnImpl, promptText: "别插队" }));
    expect(second.ok).toBe(false);
    expect(second.output).toContain("正在");
    const done = await first;
    expect(done.ok).toBe(true);
    p.stopAll();
  });

  test("空闲太久会关掉终端", async () => {
    const live = echoSpawn();
    const p = presence({ idleMs: 400 });
    await p.dispatch("b", req({ spawnImpl: live.spawnImpl }));
    expect(p.snapshot("b")?.phase).toBe("idle");
    await new Promise((r) => setTimeout(r, 500));
    expect(p.snapshot("b")?.phase).toBe("exited");
    expect(p.snapshot("b")?.exitReason).toContain("空闲");
  });

  test("界面按键和派工进同一个屏幕", async () => {
    const live = echoSpawn();
    const p = presence();
    await p.dispatch("b", req({ spawnImpl: live.spawnImpl }));
    expect(p.writeRaw("b", "y")).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(p.screenText("b")).toContain("y");
    p.stopAll();
  });
});

describe("真终端桥", () => {
  test("python pty 里的 cat 能看见打进去的字", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pty-"));
    const bridge = join(import.meta.dir, "..", "assets", "pty-bridge.py");
    const child = spawn("python3", ["-u", bridge], {
      env: {
        ...process.env,
        TERM: "xterm-256color",
        PTY_BIN: "/bin/cat",
        PTY_CWD: dir,
        PTY_COLS: "80",
        PTY_ROWS: "24",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const dec = new FrameDecoder();
    const screen = new TermScreen(80, 24);
    const done = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("pty 没有回显")), 3000);
      child.stdout?.on("data", (d: Buffer) => {
        for (const frame of dec.push(d)) {
          if (frame.type === 1) screen.feed(frame.payload.toString("utf8"));
          if (screen.text().includes("hi-term")) {
            clearTimeout(timer);
            resolve(screen.text());
          }
        }
      });
      child.on("error", reject);
    });
    child.stdin?.write(encodeFrame(1, "hi-term\r"));
    const text = await done;
    expect(text).toContain("hi-term");
    child.kill("SIGTERM");
  });
});
