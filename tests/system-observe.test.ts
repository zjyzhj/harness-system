import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { appendCodingActivity, summarizeCodingActivity } from "../core/coding-activity";
import { detectBrand, extractBundlePath, resolveVolumeIdentity } from "../core/app-identity";
import { parseDfK, parsePs, purgePaths, safeUserPath, scanOldFiles } from "../core/system-observe";

describe("system-observe parsers", () => {
  test("parseDfK", () => {
    const text = `Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/disk3s1s1 488245288 1000 2000 50% /
/dev/disk3s5 488245288 300000000 100000000 75% /System/Volumes/Data`;
    const rows = parseDfK(text);
    expect(rows.length).toBe(2);
    expect(rows[1]!.mount).toBe("/System/Volumes/Data");
    expect(rows[1]!.usedPct).toBe(75);
  });

  test("parsePs filters by apps and attaches identity", () => {
    const text = `  1  0  0.0  100 /sbin/launchd
  42 1 12.5 200000 /Applications/Cursor.app/Contents/MacOS/Cursor
  99 1  1.0  5000 /usr/bin/ssh`;
    const all = parsePs(text, []);
    expect(all.length).toBeGreaterThanOrEqual(2);
    const cur = parsePs(text, ["cursor"]);
    expect(cur).toHaveLength(1);
    expect(cur[0]!.matched).toBe("cursor");
    expect(cur[0]!.identity.brand).toBe("cursor");
    expect(cur[0]!.identity.label.length).toBeGreaterThan(0);
  });

  test("df rows get volume identity", () => {
    const rows = parseDfK(`Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/disk3s1s1 100 40 60 40% /
/dev/disk3s5 100 80 20 80% /System/Volumes/Data
/dev/disk4s1 100 10 90 10% /Volumes/zjySD`);
    expect(rows[0]!.identity.label).toBe("系统盘");
    expect(rows[1]!.identity.kind).toBe("data");
    expect(rows[2]!.identity.kind).toBe("external");
    expect(rows[2]!.identity.label).toBe("zjySD");
  });

  test("parseDfK keeps spaced mount names", () => {
    const rows = parseDfK(`Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/disk4s1 100 10 90 10% /Volumes/Macintosh HD`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mount).toBe("/Volumes/Macintosh HD");
  });
});

describe("app-identity", () => {
  test("detectBrand + extractBundlePath", () => {
    expect(detectBrand("/Applications/Cursor.app/Contents/MacOS/Cursor")).toBe("cursor");
    expect(detectBrand("codex")).toBe("codex");
    expect(extractBundlePath("/Applications/Cursor.app/Contents/MacOS/Cursor")).toBe("/Applications/Cursor.app");
    expect(resolveVolumeIdentity("/").brand).toBe("macos");
  });

  test("safeUserPath blocks system roots", () => {
    expect(safeUserPath("/").ok).toBe(false);
    expect(safeUserPath("/Applications").ok).toBe(false);
  });
});

describe("coding-activity ledger", () => {
  test("summarize pairs start/end", () => {
    const home = mkdtempSync(join(tmpdir(), "harness-act-"));
    mkdirSync(join(home, "logs"), { recursive: true });
    const t0 = Date.now() - 60_000;
    appendCodingActivity(home, { at: t0, kind: "start", botId: "b1", cwd: "/tmp/proj", cli: "cursor", program: "agent" });
    appendCodingActivity(home, { at: t0 + 30_000, kind: "end", botId: "b1", cwd: "/tmp/proj", cli: "cursor", program: "agent" });
    const s = summarizeCodingActivity(home, { since: t0 - 1000 });
    expect(s.sessions).toBe(1);
    expect(s.byCli.cursor).toBe(1);
    expect(s.byCwd[0]?.cwd).toBe("/tmp/proj");
    expect(s.text).toContain("Coding 活动");
  });
});

describe("safeUserPath + purge symlink escape", () => {
  test("rejects directory symlink pointing outside home", () => {
    const home = homedir();
    const nest = mkdtempSync(join(home, "harness-safe-"));
    const outside = mkdtempSync(join(tmpdir(), "harness-out-"));
    const victim = join(outside, "secret.txt");
    writeFileSync(victim, "nope");
    const link = join(nest, "out-link");
    symlinkSync(outside, link);
    const viaLink = join(link, "secret.txt");
    expect(safeUserPath(viaLink).ok).toBe(false);
    const purged = purgePaths([viaLink]);
    expect(purged.deleted).toHaveLength(0);
    expect(existsSync(victim)).toBe(true);
  });

  test("scanOldFiles finds aged file under home", () => {
    const nest = mkdtempSync(join(homedir(), "harness-scan-"));
    const f = join(nest, "old.bin");
    writeFileSync(f, "x".repeat(2048));
    const old = new Date(Date.now() - 40 * 24 * 60 * 60_000);
    utimesSync(f, old, old);
    const hits = scanOldFiles(nest, { minAgeDays: 30, cap: 10 });
    expect(hits.some((h) => h.path.endsWith("old.bin"))).toBe(true);
  });
});
