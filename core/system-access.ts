import { execFile } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Cap, ConsentCenter } from "./consent-center";
import type { AuditLog } from "./audit-log";

export interface AppleAction {
  /** openApp / activate / type / click / hotkey / screenshot */
  action: string;
  args: Record<string, unknown>;
}

/** 白名单 AppleScript 模板：只允许预置动作 + 参数插值（参数强制转义） */
const APPLE_TEMPLATES: Record<string, (a: Record<string, unknown>) => string> = {
  openApp: (a) => `tell application "${escApple(String(a.app ?? ""))}" to activate`,
  activate: (a) => `tell application "${escApple(String(a.app ?? ""))}" to activate`,
  type: (a) => `tell application "System Events" to keystroke ${JSON.stringify(String(a.text ?? ""))}`,
  click: (a) => `tell application "System Events" to click at {${Number(a.x ?? 0)}, ${Number(a.y ?? 0)}}`,
  hotkey: (a) => `tell application "System Events" to keystroke ${JSON.stringify(String(a.key ?? ""))} using {command down}`,
  tellApp: (a) => `tell application "${escApple(String(a.app ?? ""))}" to ${escApple(String(a.script ?? ""))}`,
};

function escApple(s: string): string {
  // 防 AppleScript 注入：拒绝引号/分号/反引号/换行
  if (/["'`;\\\n]/.test(s)) throw new Error("参数含非法字符（AppleScript 注入拦截）");
  return s;
}

const CAP_FOR_ACTION: Record<string, Cap> = {
  openApp: "apple", activate: "apple", tellApp: "apple",
  type: "gui", click: "gui", hotkey: "gui",
  screenshot: "screen",
};

/**
 * G5 系统深度访问 — 在 ConsentCenter 授权后执行真实系统操作。
 * - apple: 白名单模板 osascript（防注入）
 * - screenshot: screencapture 截图 → 返回 {path, dataUrl}
 * - bash 分组校验
 * 默认 deny：任何操作先 consent.request，未授权抛错。
 */
export class SystemAccess {
  constructor(
    private consent: ConsentCenter,
    private audit: AuditLog,
    private opts?: { workDir?: string; screenshotDir?: string },
  ) {}

  private capFor(action: string): Cap {
    return CAP_FOR_ACTION[action] ?? "apple";
  }

  private descFor(action: string, args: Record<string, unknown>): string {
    const a = action === "openApp" || action === "activate" || action === "tellApp" ? String(args.app ?? "") : "";
    const t = args.text || args.key || "";
    return `${action}${a ? ` ${a}` : ""}${t ? ` "${String(t).slice(0, 30)}"` : ""}`;
  }

  /** 校验模板 + 执行 osascript（授权后） */
  async apple(botId: string, action: string, args: Record<string, unknown>): Promise<string> {
    const tpl = APPLE_TEMPLATES[action];
    if (!tpl) throw new Error(`AppleScript 动作不支持: ${action}（可用: ${Object.keys(APPLE_TEMPLATES).join(", ")}）`);
    const script = tpl(args);
    const cap = this.capFor(action);
    const t0 = Date.now();
    const granted = await this.requestConsent(botId, cap, this.descFor(action, args));
    if (!granted) {
      this.audit.append({ botId, cap, action, args: JSON.stringify(args), granted: false, ok: false, latencyMs: Date.now() - t0, detail: "未授权" });
      throw new Error(`系统能力「${cap}」未授权：${this.descFor(action, args)}`);
    }
    try {
      const out = await this.osascript(script);
      this.audit.append({ botId, cap, action, args: JSON.stringify(args), granted: true, ok: true, latencyMs: Date.now() - t0, detail: out.slice(0, 500) });
      return out || "ok";
    } catch (e) {
      this.audit.append({ botId, cap, action, args: JSON.stringify(args), granted: true, ok: false, latencyMs: Date.now() - t0, detail: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }

  /** 截图：区域/全屏 → {path, dataUrl} */
  async screenshot(botId: string, rect?: { x: number; y: number; w: number; h: number }): Promise<{ path: string; dataUrl: string }> {
    const dir = this.opts?.screenshotDir ?? join(this.opts?.workDir ?? process.cwd(), "screenshots");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `shot-${Date.now()}.png`);
    const t0 = Date.now();
    const granted = await this.requestConsent(botId, "screen", rect ? `截图区域 ${rect.x},${rect.y} ${rect.w}x${rect.h}` : "截图全屏");
    if (!granted) {
      this.audit.append({ botId, cap: "screen", action: "screenshot", args: JSON.stringify(rect ?? {}), granted: false, ok: false, latencyMs: Date.now() - t0, detail: "未授权" });
      throw new Error("屏幕截图未授权");
    }
    try {
      const region = rect ? `-R${rect.x},${rect.y},${rect.w},${rect.h}` : "";
      await this.exec("screencapture", ["-x", ...(region ? [region] : []), path]);
      const dataUrl = `data:image/png;base64,${readFileSync(path).toString("base64")}`;
      this.audit.append({ botId, cap: "screen", action: "screenshot", args: JSON.stringify(rect ?? {}), granted: true, ok: true, latencyMs: Date.now() - t0, detail: path });
      return { path, dataUrl };
    } catch (e) {
      this.audit.append({ botId, cap: "screen", action: "screenshot", args: JSON.stringify(rect ?? {}), granted: true, ok: false, latencyMs: Date.now() - t0, detail: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }

  /** bash 分组白名单校验 */
  assertBashGroup(cmd: string, cap: Cap): void {
    const first = cmd.trim().split(/\s+/)[0];
    const groups: Record<string, string[]> = {
      "bash:read": ["echo", "ls", "cat", "head", "tail", "grep", "rg", "find", "pwd", "date", "whoami", "wc", "sort", "uniq", "sed", "awk", "jq", "df", "du"],
      "bash:dev": ["git", "npm", "pnpm", "bun", "node", "swift", "xcodebuild", "make", "cargo"],
      "bash:net": ["curl", "wget", "ping", "nslookup", "dig"],
      "bash:io": ["mkdir", "touch", "cp", "mv", "rm", "chmod", "chown", "open"],
    };
    const allowed = groups[cap] ?? [];
    if (!allowed.includes(first) && !(first.includes("/") && existsSync(first))) {
      throw new Error(`命令 ${first} 不在 ${cap} 白名单（可用: ${allowed.join(", ")}）`);
    }
  }

  private async requestConsent(botId: string, cap: Cap, desc: string): Promise<boolean> {
    const r = await this.consent.request(botId, cap, desc);
    return r.granted;
  }

  private osascript(script: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      execFile("osascript", ["-e", script], { timeout: 20_000 }, (err, stdout, stderr) => {
        if (err) { reject(new Error(`${err.message}${stderr ? " " + stderr.slice(0, 300) : ""}`)); return; }
        resolvePromise(stdout.trim());
      });
    });
  }

  private exec(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      execFile(cmd, args, { timeout: 20_000 }, (err, stdout, stderr) => {
        if (err) { reject(new Error(`${err.message}${stderr ? " " + stderr.slice(0, 300) : ""}`)); return; }
        resolvePromise(stdout.trim());
      });
    });
  }
}
