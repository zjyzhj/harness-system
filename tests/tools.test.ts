import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor } from "../core/tool-executor";
import { Store } from "../core/store";
import { MemorySystem } from "../core/memory-system";

let root: string;
let store: Store;
let memory: MemorySystem;
let exe: ToolExecutor;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "harness-tool-test-"));
  store = new Store(join(root, "home"));
  memory = new MemorySystem(join(root, "home"));
  exe = new ToolExecutor({ allowedRoots: [root] }, undefined, memory);
});

afterAll(() => store.close());

describe("tool-executor", () => {
  test("fs.write + fs.read 往返", async () => {
    const p = join(root, "notes", "a.txt");
    const w = await exe.run("fs.write", { path: p, content: "hello 世界" });
    expect(w.ok).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("hello 世界");
    const r = await exe.run("fs.read", { path: p });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("hello");
  });

  test("fs.read 拒绝白名单外路径", async () => {
    const r = await exe.run("fs.read", { path: "/etc/passwd" });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("白名单");
  });

  test("bash.run 执行白名单命令", async () => {
    const r = await exe.run("bash.run", { command: "echo hello-bash" });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("hello-bash");
  });

  test("bash.run 拒绝危险命令", async () => {
    const r = await exe.run("bash.run", { command: "rm -rf /" });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("禁止");
  });

  test("bash.run 拒绝白名单外命令", async () => {
    const r = await exe.run("bash.run", { command: "sudo anything" });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("白名单");
  });

  test("fs.list 列出目录", async () => {
    const r = await exe.run("fs.list", { path: root });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("notes");
  });

  test("memory.add/search 经工具写入", async () => {
    const r1 = await exe.run("memory.add", { botId: "bt1", content: "用户喜欢 Swift", kind: "fact" });
    expect(r1.ok).toBe(true);
    const r2 = await exe.run("memory.search", { botId: "bt1", query: "Swift" });
    expect(r2.ok).toBe(true);
    expect(r2.output).toContain("Swift");
  });

  test("web.fetch 对坏 URL 报错", async () => {
    const r = await exe.run("web.fetch", { url: "not-a-url" });
    expect(r.ok).toBe(false);
  });
});
