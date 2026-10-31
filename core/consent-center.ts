import { join } from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./atomic-fs";

/**
 * G5 授权中心 — 对标 macOS TCC 心智：默认 deny，显式 allow。
 * - 组级能力：notify/clipboard/fs/bash:read/bash:dev/bash:net/bash:io/gui/screen/apple
 * - Grant 支持 once（用一次即失效）/ ttl（到期失效）/ 长期
 * - 危险操作 requiresStrongConsent（调用方二次确认）
 * - 命令规则：按命令名记住「总是允许 / 禁止」，可只对某个 bot 或所有 bot（"*"）
 * - 信任模式：某个 bot 的命令直接执行（禁止规则和危险命令确认仍然生效）
 * - 持久化 consent.json + command-rules.json
 */
export type Cap =
  | "notify" | "clipboard" | "fs" | "fs:send"
  | "bash:read" | "bash:dev" | "bash:net" | "bash:io" | "bash:other"
  | "gui" | "screen" | "apple" | "net:local" | "skill:shared"
  | "cli:agent"
  | `mcp:${string}`;

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
  /** 单个命令的授权请求：卡片多一个「总是允许 <command>」 */
  command?: string;
  /** 只能批准这一次（有风险的写法 / 解释器），卡片不给「总是允许」 */
  onceOnly?: boolean;
  /** 为什么要单独确认，显示在卡片上 */
  reasons?: string[];
}

export type ConsentDecision = "allow" | "allow-once" | "allow-command" | "deny";

export interface CommandRule {
  /** bot id，"*" = 所有 bot */
  botId: string;
  command: string;
  decision: "allow" | "deny";
  createdAt: number;
}

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
  "bash:other": "命令·其他",
  gui: "GUI 自动化",
  screen: "屏幕截图",
  apple: "AppleScript/应用控制",
  "fs:send": "发送工作区以外的文件",
  "net:local": "访问本机 / 局域网地址",
  "skill:shared": "修改共享技能",
  "cli:agent": "派本机 Coding CLI 改工程",
};

export function capLabel(cap: string): string {
  return (CAP_LABELS as Record<string, string>)[cap] ?? (cap.startsWith("mcp:") ? `MCP 工具 ${cap.slice(4)}` : cap);
}

export class ConsentCenter {
  private grants = new Map<string, Grant>();   // key: botId:cap
  private file: string;
  private rulesFile: string;
  private rules: CommandRule[] = [];
  private trusted = new Set<string>();

  constructor(private home: string) {
    this.file = join(home, "consent.json");
    this.rulesFile = join(home, "command-rules.json");
    this.load();
  }

  private load() {
    const grants = readJsonSafe<Grant[]>(this.file, []);
    if (Array.isArray(grants)) for (const g of grants) if (g?.botId && g.cap) this.grants.set(`${g.botId}:${g.cap}`, g);
    const raw = readJsonSafe<{ rules?: CommandRule[]; trusted?: string[] }>(this.rulesFile, {});
    this.rules = (Array.isArray(raw.rules) ? raw.rules : []).filter((r) => r?.command && r.botId && (r.decision === "allow" || r.decision === "deny"));
    this.trusted = new Set(Array.isArray(raw.trusted) ? raw.trusted : []);
  }
  private persist() {
    writeJsonAtomic(this.file, [...this.grants.values()]);
  }
  private persistRules() {
    writeJsonAtomic(this.rulesFile, { rules: this.rules, trusted: [...this.trusted] });
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

  // ---- 命令规则 ----

  /** 这个 bot 对这个命令的规则：自己的规则优先于「所有 bot」，同级里禁止优先 */
  commandRule(botId: string, command: string): "allow" | "deny" | null {
    for (const scope of [botId, "*"]) {
      const hits = this.rules.filter((r) => r.botId === scope && r.command === command);
      if (hits.some((r) => r.decision === "deny")) return "deny";
      if (hits.length) return "allow";
    }
    return null;
  }

  setCommandRule(botId: string, command: string, decision: "allow" | "deny"): CommandRule {
    const cmd = command.trim();
    if (!cmd || /\s/.test(cmd)) throw new Error("命令名不能为空，也不能带参数（例如 cursor）");
    this.rules = this.rules.filter((r) => !(r.botId === botId && r.command === cmd));
    const rule: CommandRule = { botId, command: cmd, decision, createdAt: Date.now() };
    this.rules.push(rule);
    this.persistRules();
    return rule;
  }

  removeCommandRule(botId: string, command: string) {
    this.rules = this.rules.filter((r) => !(r.botId === botId && r.command === command));
    this.persistRules();
  }

  listCommandRules(botId?: string): CommandRule[] {
    return botId ? this.rules.filter((r) => r.botId === botId || r.botId === "*") : [...this.rules];
  }

  isTrusted(botId: string): boolean {
    return this.trusted.has(botId);
  }

  setTrusted(botId: string, on: boolean) {
    if (on) this.trusted.add(botId);
    else this.trusted.delete(botId);
    this.persistRules();
  }

  trustedBots(): string[] {
    return [...this.trusted];
  }

  /**
   * 请求授权：有 grant → 消耗 once 并返回 true；无 → 调 decider 弹窗。
   * 危险操作不走已有授权，每次都要确认，也不会被记成长期。
   */
  async request(botId: string, cap: Cap, description: string, opts?: { requiresStrongConsent?: boolean; onceOnly?: boolean; reasons?: string[] }): Promise<{ granted: boolean }> {
    this.expire();
    const strong = !!opts?.requiresStrongConsent;
    const once = strong || !!opts?.onceOnly;
    const g = this.grants.get(`${botId}:${cap}`);
    if (g && !once) {
      if (g.once) { this.grants.delete(`${botId}:${cap}`); this.persist(); }
      return { granted: true };
    }
    if (!this.decider) return { granted: false };
    const decision = await this.decider({ botId, cap, description, requiresStrongConsent: opts?.requiresStrongConsent, onceOnly: once || undefined, reasons: opts?.reasons });
    if (decision === "deny") return { granted: false };
    if (decision === "allow" && !once) this.grant(botId, cap);
    return { granted: true };
  }

  /** 单个命令的授权：「总是允许」只记成这个 bot 对这一个命令的规则，不会放行整组命令 */
  async requestCommand(
    botId: string, command: string, description: string,
    opts?: { cap?: Cap; requiresStrongConsent?: boolean; onceOnly?: boolean; reasons?: string[] },
  ): Promise<{ granted: boolean }> {
    const strong = !!opts?.requiresStrongConsent;
    const once = strong || !!opts?.onceOnly;
    if (!once && this.commandRule(botId, command) === "allow") return { granted: true };
    if (!this.decider) return { granted: false };
    const decision = await this.decider({
      botId, cap: opts?.cap ?? "bash:other", description, requiresStrongConsent: opts?.requiresStrongConsent,
      command, onceOnly: once || undefined, reasons: opts?.reasons,
    });
    if (decision === "deny") return { granted: false };
    if (!once && (decision === "allow-command" || decision === "allow")) this.setCommandRule(botId, command, "allow");
    return { granted: true };
  }

  decider: ConsentDecider | null = null;
}
