/**
 * 系统行为底座（观察层）：进程 / 前台 / 磁盘 / 活动账本 / 目录扫描。
 * 不绑定周报、清理等产品场景——那些由 bot 调工具 + task.create 自行组合。
 * GUI 点控仍走电脑操控（辅助功能 / 屏幕录制）。
 */
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { realPathLoose } from "./tool-executor";
import {
  codingCliIdentity,
  resolveAppIdentity,
  resolveVolumeIdentity,
  type AppIdentity,
  type VolumeIdentity,
} from "./app-identity";
import { summarizeCodingActivity, type CodingActivitySummary } from "./coding-activity";

export interface DiskVolume {
  mount: string;
  totalKb: number;
  usedKb: number;
  availKb: number;
  usedPct: number;
  identity: VolumeIdentity;
}

export interface ProcessHit {
  pid: number;
  ppid: number;
  cpu: number;
  rssKb: number;
  command: string;
  matched?: string;
  identity: AppIdentity;
  /** 宿主填充的 data URL 图标 */
  iconDataUrl?: string;
}

export interface FrontmostInfo {
  name: string | null;
  error?: string;
  identity?: AppIdentity;
  iconDataUrl?: string;
}

export interface ScanHit {
  path: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface SystemObserveSnapshot {
  at: number;
  frontmost: FrontmostInfo;
  processes: ProcessHit[];
  disk: DiskVolume[];
  coding?: CodingActivitySummary;
  notes: string[];
}

/** 解析 `df -k`；Capacity 之后整段作为挂载点（支持空格卷名） */
export function parseDfK(text: string): DiskVolume[] {
  const lines = text.trim().split("\n").slice(1);
  const out: DiskVolume[] = [];
  for (const line of lines) {
    const m = line.trim().match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(\/.*)$/);
    if (!m) continue;
    const mount = m[6]!.trim();
    const totalKb = Number(m[2]);
    const usedKb = Number(m[3]);
    const availKb = Number(m[4]);
    const usedPct = Number(m[5]);
    if (!Number.isFinite(totalKb) || !mount.startsWith("/")) continue;
    out.push({
      mount,
      totalKb,
      usedKb: Number.isFinite(usedKb) ? usedKb : 0,
      availKb: Number.isFinite(availKb) ? availKb : 0,
      usedPct: Number.isFinite(usedPct) ? usedPct : 0,
      identity: resolveVolumeIdentity(mount),
    });
  }
  return out;
}

export function observeDisk(): DiskVolume[] {
  try {
    const text = execFileSync("df", ["-k"], { encoding: "utf8", timeout: 8000 });
    return parseDfK(text)
      .filter((v) => !v.mount.startsWith("/dev") && v.mount !== "/private/var/vm")
      .sort((a, b) => b.usedPct - a.usedPct)
      .slice(0, 16);
  } catch {
    return [];
  }
}

/** 解析 ps 表；apps 非空则按子串过滤（大小写不敏感） */
export function parsePs(text: string, apps: string[] = []): ProcessHit[] {
  const keys = apps.map((a) => a.toLowerCase()).filter(Boolean);
  const lines = text.trim().split("\n");
  const hits: ProcessHit[] = [];
  for (const line of lines) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const rawCommand = m[5]!.trim();
    const command = basename(rawCommand.split(/\s+/)[0] || rawCommand);
    const low = rawCommand.toLowerCase();
    const matched = keys.length ? keys.find((k) => low.includes(k)) : undefined;
    if (keys.length && !matched) continue;
    const identity = resolveAppIdentity({ command, rawCommand });
    hits.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      cpu: Number(m[3]),
      rssKb: Number(m[4]),
      command,
      matched,
      identity,
    });
  }
  hits.sort((a, b) => b.cpu - a.cpu || b.rssKb - a.rssKb);
  return hits.slice(0, 60);
}

export function observeProcesses(apps: string[] = []): ProcessHit[] {
  try {
    // command= 保留路径，便于解析 .app bundle
    const text = execFileSync("ps", ["-axo", "pid=,ppid=,pcpu=,rss=,command="], {
      encoding: "utf8",
      timeout: 8000,
    });
    return parsePs(text, apps);
  } catch {
    return [];
  }
}

function execText(cmd: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout || ""));
    });
  });
}

/** 跟同步版一样，但把 df / ps / osascript 让出主进程，避免堵住会话 IPC */
export async function observeDiskAsync(): Promise<DiskVolume[]> {
  try {
    const text = await execText("df", ["-k"], 8000);
    return parseDfK(text)
      .filter((v) => !v.mount.startsWith("/dev") && v.mount !== "/private/var/vm")
      .sort((a, b) => b.usedPct - a.usedPct)
      .slice(0, 16);
  } catch {
    return [];
  }
}

export async function observeProcessesAsync(apps: string[] = []): Promise<ProcessHit[]> {
  try {
    const text = await execText("ps", ["-axo", "pid=,ppid=,pcpu=,rss=,command="], 8000);
    return parsePs(text, apps);
  } catch {
    return [];
  }
}

export async function observeFrontmostAsync(): Promise<FrontmostInfo> {
  try {
    const stdout = await execText(
      "osascript",
      ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true'],
      5000,
    );
    const name = stdout.trim() || null;
    const identity = name ? resolveAppIdentity({ command: name, displayHint: name }) : undefined;
    return { name, identity };
  } catch (e) {
    return { name: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export function observeFrontmost(): FrontmostInfo {
  try {
    const r = spawnSync(
      "osascript",
      ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true'],
      { encoding: "utf8", timeout: 5000 },
    );
    if (r.status !== 0) {
      return { name: null, error: (r.stderr || r.stdout || "osascript failed").trim().slice(0, 160) };
    }
    const name = (r.stdout || "").trim() || null;
    const identity = name ? resolveAppIdentity({ command: name, displayHint: name }) : undefined;
    return { name, identity };
  } catch (e) {
    return { name: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export { codingCliIdentity };

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

const BLOCKED = new Set(["/", "/System", "/Library", "/bin", "/sbin", "/usr", "/private", "/Applications", "/Users"]);

function underHome(real: string, home: string): boolean {
  const h = home.endsWith(sep) ? home.slice(0, -1) : home;
  return real === h || real.startsWith(`${h}${sep}`);
}

/** 仅允许家目录下的真实路径（realpath），防止符号链接逃出 $HOME */
export function safeUserPath(raw: string): { ok: true; path: string } | { ok: false; error: string } {
  const p = resolve(expandHome(String(raw || "").trim()));
  if (!p) return { ok: false, error: "路径为空" };
  if (BLOCKED.has(p) || p === homedir()) return { ok: false, error: `不允许扫描系统路径或家目录根：${p}` };
  const home = homedir();
  if (p !== home && !p.startsWith(`${home}${sep}`)) return { ok: false, error: `只允许家目录内路径：${p}` };
  if (!existsSync(p)) return { ok: false, error: `不存在：${p}` };
  let real: string;
  try {
    real = realPathLoose(p);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  let homeReal = home;
  try {
    homeReal = realpathSync(home);
  } catch { /* keep */ }
  if (!underHome(real, homeReal)) {
    return { ok: false, error: `真实路径逃出家目录：${real}` };
  }
  if (BLOCKED.has(real) || real === homeReal) {
    return { ok: false, error: `不允许扫描系统路径或家目录根：${real}` };
  }
  return { ok: true, path: real };
}

/** 浅扫过期文件（观察用；真删走 sys.purge + 强确认） */
export function scanOldFiles(root: string, opts?: { minAgeDays?: number; cap?: number; minSizeKb?: number }): ScanHit[] {
  const safe = safeUserPath(root);
  if (!safe.ok) return [];
  const ageRaw = opts?.minAgeDays;
  const minAgeDays = Number.isFinite(Number(ageRaw))
    ? Math.max(0, Math.min(3650, Math.round(Number(ageRaw))))
    : 30;
  const cap = Math.max(1, Math.min(200, Number(opts?.cap) || 80));
  const minSize = Math.max(0, (Number(opts?.minSizeKb) || 0) * 1024);
  const cutoff = Date.now() - minAgeDays * 24 * 60 * 60_000;
  const home = homedir();
  let homeReal = home;
  try { homeReal = realpathSync(home); } catch { /* keep */ }
  const out: ScanHit[] = [];
  const visit = (dir: string, depth: number) => {
    if (out.length >= cap) return;
    // 目录本身若是指向家外的符号链接，跳过
    try {
      const lst = lstatSync(dir);
      if (lst.isSymbolicLink()) {
        const real = realpathSync(dir);
        if (!underHome(real, homeReal)) return;
      }
    } catch {
      return;
    }
    let ents: string[] = [];
    try {
      ents = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of ents) {
      if (out.length >= cap) break;
      if (name === "." || name === ".." || name === ".Trash") continue;
      const full = join(dir, name);
      let st;
      let real = full;
      try {
        const lst = lstatSync(full);
        if (lst.isSymbolicLink()) {
          real = realpathSync(full);
          if (!underHome(real, homeReal)) continue;
        } else {
          real = full;
        }
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isFile() && st.mtimeMs < cutoff && st.size >= minSize) {
        out.push({ path: real, sizeBytes: st.size, mtimeMs: st.mtimeMs });
      } else if (st.isDirectory() && depth < 2) {
        visit(full, depth + 1);
      }
    }
  };
  visit(safe.path, 0);
  out.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return out.slice(0, cap);
}

export function purgePaths(paths: string[]): { deleted: string[]; failed: Array<{ path: string; error: string }> } {
  const deleted: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  for (const raw of paths.slice(0, 100)) {
    const safe = safeUserPath(raw);
    if (!safe.ok) {
      failed.push({ path: raw, error: safe.error });
      continue;
    }
    try {
      const st = statSync(safe.path);
      if (st.isDirectory()) {
        failed.push({ path: safe.path, error: "拒绝直接删目录；请指定文件" });
        continue;
      }
      rmSync(safe.path, { force: true });
      deleted.push(safe.path);
    } catch (e) {
      failed.push({ path: safe.path, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { deleted, failed };
}

export function observeSystem(home: string, opts?: {
  apps?: string[];
  includeCoding?: boolean;
  codingSinceMs?: number;
}): SystemObserveSnapshot {
  const notes: string[] = [
    "进程/磁盘/账本不依赖辅助功能；读其他 App UI 或点击仍需辅助功能 + 电脑操控。",
  ];
  const frontmost = observeFrontmost();
  if (frontmost.error) notes.push(`前台应用：${frontmost.error}（可能需辅助功能）`);
  const coding = opts?.includeCoding === false
    ? undefined
    : summarizeCodingActivity(home, {
      since: Date.now() - (opts?.codingSinceMs ?? 7 * 24 * 60 * 60_000),
      recentLimit: 24,
    });
  return {
    at: Date.now(),
    frontmost,
    processes: observeProcesses(opts?.apps ?? []),
    disk: observeDisk(),
    coding,
    notes,
  };
}

export function formatObserveText(snap: SystemObserveSnapshot): string {
  const lines: string[] = [];
  lines.push(`时间 ${new Date(snap.at).toLocaleString()}`);
  const frontLabel = snap.frontmost.identity?.label || snap.frontmost.name || "（未知）";
  lines.push(`前台：${frontLabel}`);
  if (snap.processes.length) {
    lines.push("进程（节选）：");
    for (const p of snap.processes.slice(0, 20)) {
      const name = p.identity?.label || p.command;
      lines.push(`- ${name} · pid ${p.pid} · CPU ${p.cpu}% · RSS ${Math.round(p.rssKb / 1024)} MB`);
    }
  } else {
    lines.push("进程：无匹配（可传 apps 关键字过滤，或不传看高占用）");
  }
  if (snap.disk.length) {
    lines.push("磁盘：");
    for (const d of snap.disk.slice(0, 8)) {
      const usedG = (d.usedKb / 1024 / 1024).toFixed(1);
      const totalG = (d.totalKb / 1024 / 1024).toFixed(1);
      const label = d.identity?.label || d.mount;
      lines.push(`- ${label}（${d.mount}） · ${d.usedPct}% · ${usedG}/${totalG} GB`);
    }
  }
  if (snap.coding) {
    lines.push("", snap.coding.text);
  }
  for (const n of snap.notes) lines.push(`注：${n}`);
  return lines.join("\n");
}
