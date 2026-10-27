import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * G5 授权中心 — 对标 macOS TCC 心智：默认 deny，显式 allow。
 * - 组级能力：notify/clipboard/fs/bash:read/bash:dev/bash:net/bash:io/gui/screen/apple
 * - Grant 支持 once（用一次即失效）/ ttl（到期失效）/ 长期
 * - 危险操作 requiresStrongConsent（调用方二次确认）
 * - 持久化 consent.json
 */
export type Cap =
  | "notify" | "clipboard" | "fs"
  | "bash:read" | "bash:dev" | "bash:net" | "bash:io"
  | "gui" | "screen" | "apple";

export interface Grant {
  botId: string;
  cap: Cap;
  once?: boolean;
  expiresAt?: number;
  grantedAt: number;
  note?: string;
}

export interface ConsentRequest {
  botId: string;
  cap: Cap;
  description: string;
  requiresStrongConsent?: boolean;
}

export type ConsentDecision = "allow" | "allow-once" | "deny";

/**
 * 授权决策回调（由宿主注入）：弹窗或策略，返回用户决定。
 * 未注入时默认拒绝（安全兜底）。
 */
export type ConsentDecider = (req: ConsentRequest) => Promise<ConsentDecision> | ConsentDecision;

export const CAP_LABELS: Record<Cap, string> = {
  notify: "系统通知",
  clipboard: "剪贴板",
  fs: "文件读写",
  "bash:read": "命令·只读",
  "bash:dev": "命令·开发(git/构建)",
  "bash:net": "命令·网络",
  "bash:io": "命令·文件操作",
  gui: "GUI 自动化",
  screen: "屏幕截图",
  apple: "AppleScript/应用控制",
};

export class ConsentCenter {
  private grants = new Map<string, Grant>();   // key: botId:cap
  private file: string;

  constructor(private home: string) {
    this.file = join(home, "consent.json");
    this.load();
  }

  private load() {
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as Grant[];
        for (const g of raw) this.grants.set(`${g.botId}:${g.cap}`, g);
      } catch { /* 损坏则重置 */ }
    }
  }
  private persist() {
    writeFileSync(this.file, JSON.stringify([...this.grants.values()], null, 2), "utf8");
  }

  /** 主动授权 */
  grant(botId: string, cap: Cap, opts?: { once?: boolean; ttlMs?: number; note?: string }): Grant {
    const g: Grant = {
      botId, cap,
      once: opts?.once,
      expiresAt: opts?.ttlMs ? Date.now() + opts.ttlMs : undefined,
      grantedAt: Date.now(),
      note: opts?.note,
    };
    this.grants.set(`${botId}:${cap}`, g);
    this.persist();
    return g;
  }

  revoke(botId: string, cap?: Cap) {
    if (cap) this.grants.delete(`${botId}:${cap}`);
    else for (const [k, g] of this.grants) if (g.botId === botId) this.grants.delete(k);
    this.persist();
  }

  /** 撤销过期授权（每次 request 前调用） */
  expire() {
    const now = Date.now();
    let changed = false;
    for (const [k, g] of this.grants) {
      if (g.expiresAt && g.expiresAt <= now) { this.grants.delete(k); changed = true; }
    }
    if (changed) this.persist();
  }

  /** 是否有未过期授权（含 once 未用） */
  has(botId: string, cap: Cap): boolean {
    this.expire();
    const g = this.grants.get(`${botId}:${cap}`);
    return !!g;
  }

  list(botId?: string): Grant[] {
    this.expire();
    const all = [...this.grants.values()];
    return botId ? all.filter((g) => g.botId === botId) : all;
  }

  /**
   * 请求授权：有 grant → 消耗 once 并返回 true；无 → 调 decider 弹窗。
   * @returns { granted: boolean; pending?: boolean }
   */
  async request(botId: string, cap: Cap, description: string, opts?: { requiresStrongConsent?: boolean }): Promise<{ granted: boolean }> {
    this.expire();
    const g = this.grants.get(`${botId}:${cap}`);
    if (g) {
      if (g.once) { this.grants.delete(`${botId}:${cap}`); this.persist(); }
      return { granted: true };
    }
    if (!this.decider) return { granted: false };
    const decision = await this.decider({
      botId, cap, description,
      requiresStrongConsent: opts?.requiresStrongConsent,
    });
    if (decision === "deny") return { granted: false };
    this.grant(botId, cap, decision === "allow-once" ? { once: true } : undefined);
    return { granted: true };
  }

  decider: ConsentDecider | null = null;
}
