import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** 先写临时文件再改名：写到一半崩溃 / 断电也不会留下半截文件 */
export function writeFileAtomic(path: string, data: string | Buffer, opts?: { mode?: number }): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  try {
    writeFileSync(tmp, data, { mode: opts?.mode });
    renameSync(tmp, path);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

export function writeJsonAtomic(path: string, value: unknown, opts?: { mode?: number }): void {
  writeFileAtomic(path, JSON.stringify(value, null, 2), opts);
}

/** 坏文件先另存一份再用默认值，之后的写入不会把用户数据直接覆盖掉 */
export function backupCorrupt(path: string): string | null {
  try {
    const dest = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(path, dest);
    console.warn(`[harness] ${path} 解析失败，已备份到 ${dest}`);
    return dest;
  } catch {
    return null;
  }
}

export function readJsonSafe<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return fallback; }
  if (!text.trim()) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    backupCorrupt(path);
    return fallback;
  }
}

/** 追加 jsonl：上次崩溃留下没换行的半行时先补一个换行，新记录不会粘到坏行上 */
export function appendLinesSafe(path: string, lines: string[]): void {
  if (!lines.length) return;
  let prefix = "";
  try {
    const size = statSync(path).size;
    if (size > 0) {
      const fd = openSync(path, "r");
      try {
        const b = Buffer.alloc(1);
        readSync(fd, b, 0, 1, size - 1);
        if (b[0] !== 0x0a) prefix = "\n";
      } finally { closeSync(fd); }
    }
  } catch {}
  appendFileSync(path, prefix + lines.join("\n") + "\n", "utf8");
}

/** jsonl 逐行解析：坏行跳过（通常是崩溃时写了半行），不影响其它记录 */
export function parseJsonl<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as T); } catch {}
  }
  return out;
}
