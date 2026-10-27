import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * G5 审计日志 — append-only JSONL，只增不删（按天轮转）。
 * 每次系统能力请求/授权/执行/结果都会落一条，供面板查询与导出。
 */
export interface AuditEvent {
  at: number;
  botId: string;
  cap: string;
  action: string;
  args?: string;
  granted: boolean;
  ok?: boolean;
  latencyMs?: number;
  detail?: string;
}

export class AuditLog {
  private dir: string;

  constructor(home: string) {
    this.dir = join(home, "audit");
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  private fileFor(at: number): string {
    const d = new Date(at);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return join(this.dir, `${y}-${m}-${day}.jsonl`);
  }

  /** 追加一条审计（append-only） */
  append(ev: Omit<AuditEvent, "at"> & { at?: number }) {
    const full: AuditEvent = { at: ev.at ?? Date.now(), ...ev } as AuditEvent;
    try {
      appendFileSync(this.fileFor(full.at), JSON.stringify(full) + "\n", "utf8");
    } catch { /* 审计失败不阻断主流程 */ }
    return full;
  }

  /** 查询（倒序，可按 bot/cap/结果过滤） */
  query(opts?: { botId?: string; cap?: string; ok?: boolean; limit?: number; from?: number; to?: number }): AuditEvent[] {
    const from = opts?.from ?? 0;
    const to = opts?.to ?? Date.now();
    const files = readdirSync(this.dir).filter((f) => f.endsWith(".jsonl")).sort().reverse();
    const out: AuditEvent[] = [];
    const limit = opts?.limit ?? 200;
    for (const f of files) {
      const lines = readFileSync(join(this.dir, f), "utf8").split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const ev = JSON.parse(lines[i]) as AuditEvent;
          if (ev.at < from || ev.at > to) continue;
          if (opts?.botId && ev.botId !== opts.botId) continue;
          if (opts?.cap && ev.cap !== opts.cap) continue;
          if (opts?.ok !== undefined && ev.ok !== opts.ok) continue;
          out.push(ev);
          if (out.length >= limit) return out;
        } catch { /* 跳过坏行 */ }
      }
    }
    return out;
  }

  /** 导出全部（含跨天） */
  exportAll(): AuditEvent[] {
    return this.query({ limit: 100_000, from: 0, to: Date.now() + 86_400_000 });
  }
}
