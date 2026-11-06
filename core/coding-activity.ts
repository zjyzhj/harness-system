/**
 * Coding 活动账本：记录 bot 拉起的 Cursor / Codex / Claude / shell 会话，
 * 供日报周报例行汇总。不依赖辅助功能。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type CodingActivityKind = "start" | "end";

export interface CodingActivityEntry {
  at: number;
  kind: CodingActivityKind;
  botId: string;
  cwd: string;
  /** shell | cursor | claude | codex | … */
  cli: string;
  program: "shell" | "agent";
  task?: string;
  reason?: string;
  /** end 时相对同 cwd+cli 最近一次 start 的毫秒数（能算出来才有） */
  durationMs?: number;
}

function fileOf(home: string): string {
  return join(home, "logs", "coding-activity.jsonl");
}

export function appendCodingActivity(
  home: string,
  entry: Omit<CodingActivityEntry, "at"> & { at?: number },
): CodingActivityEntry {
  const full: CodingActivityEntry = { ...entry, at: entry.at ?? Date.now() };
  const dir = join(home, "logs");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try {
    appendFileSync(fileOf(home), `${JSON.stringify(full)}\n`, "utf8");
  } catch {
    /* 账本失败不影响主流程 */
  }
  return full;
}

/** 读最近条目（新→旧） */
export function listCodingActivity(
  home: string,
  opts?: { botId?: string; since?: number; until?: number; limit?: number },
): CodingActivityEntry[] {
  const file = fileOf(home);
  if (!existsSync(file)) return [];
  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const limit = opts?.limit ?? 200;
  const rows: CodingActivityEntry[] = [];
  const lines = raw.trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0 && rows.length < limit * 4; i--) {
    try {
      const j = JSON.parse(lines[i]!) as CodingActivityEntry;
      if (opts?.botId && j.botId !== opts.botId) continue;
      if (opts?.since != null && j.at < opts.since) continue;
      if (opts?.until != null && j.at > opts.until) continue;
      rows.push(j);
      if (rows.length >= limit) break;
    } catch {
      /* skip */
    }
  }
  return rows;
}

export interface CodingActivitySummary {
  since: number;
  until: number;
  sessions: number;
  byCli: Record<string, number>;
  byCwd: Array<{ cwd: string; sessions: number; totalMs: number; clis: string[] }>;
  recent: CodingActivityEntry[];
  /** 给 bot / 例行直接塞进 prompt 的短文 */
  text: string;
}

/** 把 start/end 配对成会话摘要（按 botId+cwd+cli 最近 start 配对） */
export function summarizeCodingActivity(
  home: string,
  opts?: { botId?: string; since?: number; until?: number; recentLimit?: number },
): CodingActivitySummary {
  const until = opts?.until ?? Date.now();
  const since = opts?.since ?? until - 7 * 24 * 60 * 60_000;
  // 多读一些再过滤，方便配对 duration
  const all = listCodingActivity(home, { botId: opts?.botId, since: since - 2 * 24 * 60 * 60_000, until, limit: 2000 }).reverse();
  const byCli: Record<string, number> = {};
  const cwdMap = new Map<string, { sessions: number; totalMs: number; clis: Set<string> }>();
  const open = new Map<string, CodingActivityEntry>();
  let sessions = 0;
  const inWindow: CodingActivityEntry[] = [];

  for (const e of all) {
    const key = `${e.botId}\0${e.cwd}\0${e.cli}`;
    if (e.kind === "start") {
      open.set(key, e);
      if (e.at >= since && e.at <= until) {
        inWindow.push(e);
        sessions += 1;
        byCli[e.cli] = (byCli[e.cli] ?? 0) + 1;
        const row = cwdMap.get(e.cwd) ?? { sessions: 0, totalMs: 0, clis: new Set<string>() };
        row.sessions += 1;
        row.clis.add(e.cli);
        cwdMap.set(e.cwd, row);
      }
      continue;
    }
    if (e.kind === "end") {
      const start = open.get(key);
      open.delete(key);
      const dur = e.durationMs ?? (start ? Math.max(0, e.at - start.at) : undefined);
      if (e.at >= since && e.at <= until) {
        inWindow.push(dur != null ? { ...e, durationMs: dur } : e);
        if (dur != null && start && start.at >= since) {
          const row = cwdMap.get(e.cwd);
          if (row) row.totalMs += dur;
        }
      }
    }
  }

  const byCwd = [...cwdMap.entries()]
    .map(([cwd, v]) => ({ cwd, sessions: v.sessions, totalMs: v.totalMs, clis: [...v.clis].sort() }))
    .sort((a, b) => b.totalMs - a.totalMs || b.sessions - a.sessions)
    .slice(0, 20);

  const recent = inWindow.slice(-Math.max(1, opts?.recentLimit ?? 30)).reverse();
  const fmtDur = (ms: number) => {
    const m = Math.round(ms / 60_000);
    if (m < 60) return `${m} 分钟`;
    return `${(m / 60).toFixed(1)} 小时`;
  };
  const lines = [
    `Coding 活动 ${new Date(since).toLocaleString()} → ${new Date(until).toLocaleString()}`,
    `会话数 ${sessions} · CLI：${Object.entries(byCli).map(([k, n]) => `${k}×${n}`).join("、") || "无"}`,
  ];
  if (byCwd.length) {
    lines.push("按工程：");
    for (const r of byCwd.slice(0, 12)) {
      lines.push(`- ${r.cwd} · ${r.sessions} 次 · ${fmtDur(r.totalMs)} · ${r.clis.join("/")}`);
    }
  } else {
    lines.push("这段时间没有通过 Harness 终端记录到 Coding 会话。");
  }
  return { since, until, sessions, byCli, byCwd, recent, text: lines.join("\n") };
}

/** 例行 prompt 模板 */
export function codingReportPrompt(kind: "daily" | "weekly", summaryText: string): string {
  const label = kind === "daily" ? "日报" : "周报";
  return [
    `请根据下面的 Coding 活动账本，写一份简洁的开发${label}（中文 Markdown）。`,
    "要求：按项目归类；点出 Cursor / Codex / Claude / shell 各自做了什么；没有数据就如实说；最后给 1～3 条下周/明日建议。",
    "",
    "【账本】",
    summaryText,
  ].join("\n");
}
