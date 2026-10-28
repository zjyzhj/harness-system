import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLogger } from "../core/logger";

describe("日志文件", () => {
  test("按天写入，错误带堆栈，超过 10MB 轮转，7 天前的清掉", () => {
    const home = mkdtempSync(join(tmpdir(), "harness-log-"));
    const now = new Date(2026, 9, 28, 18, 0);
    const log = new FileLogger(home, "main", () => now);
    log.write("error", "出错了", new Error("boom"));
    const f = join(home, "logs", "main-2026-10-28.log");
    const text = readFileSync(f, "utf8");
    expect(text).toContain("[error] 出错了 Error: boom");
    expect(text).toContain("logger.test.ts");
    expect(statSync(f).mode & 0o777).toBe(0o600);

    writeFileSync(f, "x".repeat(10 * 1024 * 1024 + 1));
    log.write("info", "新的一行");
    expect(existsSync(`${f}.1`)).toBe(true);
    expect(readFileSync(f, "utf8")).toContain("新的一行");

    const old = join(home, "logs", "main-2026-10-01.log");
    writeFileSync(old, "旧");
    const t = new Date(2026, 9, 1).getTime() / 1000;
    utimesSync(old, t, t);
    new FileLogger(home, "main", () => now);
    expect(existsSync(old)).toBe(false);
  });
});
