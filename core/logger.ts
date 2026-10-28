import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";

const MAX_BYTES = 10 * 1024 * 1024;
const KEEP_DAYS = 7;

/**
 * 按天写日志文件（logs/main-YYYY-MM-DD.log），单个文件超过 10MB 轮转成 .1，只保留最近 7 天。
 * 写日志失败不抛错，不能因为日志把应用带崩。
 */
export class FileLogger {
  readonly dir: string;
  constructor(home: string, private name = "main", private now: () => Date = () => new Date()) {
    this.dir = join(home, "logs");
    try { mkdirSync(this.dir, { recursive: true }); this.prune(); } catch { /* 忽略 */ }
  }

  file(): string {
    const d = this.now();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return join(this.dir, `${this.name}-${day}.log`);
  }

  write(level: "info" | "warn" | "error", ...args: unknown[]) {
    try {
      const f = this.file();
      if (existsSync(f) && statSync(f).size > MAX_BYTES) renameSync(f, `${f}.1`);
      const text = args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.stack ?? a.message : inspect(a, { depth: 4, breakLength: 160 }))).join(" ");
      appendFileSync(f, `${this.now().toISOString()} [${level}] ${text}\n`, { mode: 0o600 });
    } catch { /* 忽略 */ }
  }

  /** 让 console.log / warn / error 同时写进日志文件 */
  captureConsole() {
    for (const level of ["log", "warn", "error"] as const) {
      const orig = console[level].bind(console);
      console[level] = (...args: unknown[]) => {
        orig(...args);
        this.write(level === "log" ? "info" : level, ...args);
      };
    }
  }

  private prune() {
    const cutoff = this.now().getTime() - KEEP_DAYS * 86_400_000;
    for (const f of readdirSync(this.dir)) {
      const p = join(this.dir, f);
      if (f.startsWith(`${this.name}-`) && statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
    }
  }
}
