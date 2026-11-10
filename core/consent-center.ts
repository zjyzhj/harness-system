import { existsSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./atomic-fs";
import { ActionRuleStore, actionSummary, type ActionRule } from "./action-rules";

/**
 * G5 授权中心 — 对标 Grok Ask / Auto / Always-approve。
 * - Ask：未授权都问
 * - Auto：Shell / 开终端 / 派 CLI 自动过；危险命令仍强确认；禁止规则仍生效
 * - Always：工具默认全过（含危险命令）；禁止规则仍生效
 * - 命令规则：按命令名 allow/deny；目录前缀信任（cli.agent / term.open）
 * - 持久化 consent.json + command-rules.json（兼容旧 trusted[]）
 */
export type PermissionMode = "ask" | "auto" | "always";

export type Cap =
  | "notify" | "clipboard" | "fs" | "fs:send"
  | "bash:read" | "bash:dev" | "bash:net" | "bash:io" | "bash:other"
  | "gui" | "screen" | "apple" | "net:local" | "skill:shared"
  | "cli:agent"
  | "term:open"
  | "browser:open"
  | "mcp:manage"
  | "webhook:out"
  | "system:observe"
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
  /** 只能批准这一次（有风险的写法 / 解释器）；若另有 suggestAllowRule 仍可写入自定义 Allow */
  onceOnly?: boolean;
  /** 为什么要单独确认，显示在卡片上 */
  reasons?: string[];
  /**
   * 目录前缀授权（cli.agent / term.open）。有值时卡片多「总是允许此目录」；
   * 选 allow-command 时按此前缀记住，二次同前缀可免弹窗。
   */
  rememberPath?: string;
  /** 命中的自定义规则 id（Ask first）；卡片可「编辑规则」 */
  actionRuleId?: string;
  /**
   * 对齐 Grok Always allow → Custom Rules：
   * 有值时卡片多「总是允许（写入规则）」；点选后写入账号级 Allow 规则。
   * 用于白名单外路径等 onceOnly 场景，避免永远只能「允许一次」。
   */
  suggestAllowRule?: string;
}

export interface CliAgentPathGrant {
  botId: string;
  /** realpath 前缀 */
  prefix: string;
  createdAt: number;
}

/** 与 CliAgentPathGrant 同形：term.open 的目录信任 */
export type TermOpenPathGrant = CliAgentPathGrant;

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
  "term:open": "在工程目录打开终端",
  "browser:open": "打开 bot 内部浏览器",
  "mcp:manage": "安装 / 移除 MCP server",
  "webhook:out": "出站 Webhook（登记 / POST）",
  "system:observe": "系统观察（进程 / 磁盘 / 活动账本）",
};

export function capLabel(cap: string): string {
  return (CAP_LABELS as Record<string, string>)[cap] ?? (cap.startsWith("mcp:") ? `MCP 工具 ${cap.slice(4)}` : cap);
}

export class ConsentCenter {
  private grants = new Map<string, Grant>();   // key: botId:cap
  private file: string;
  private rulesFile: string;
  private rules: CommandRule[] = [];
  /** botId → 权限模式；缺省 ask。旧版 trusted[] 加载时迁成 auto */
  private modes = new Map<string, PermissionMode>();
  private cliPaths: CliAgentPathGrant[] = [];
  private termPaths: TermOpenPathGrant[] = [];
  /** Grok Custom Rules：Ask first / Allow（账号级关键词） */
  readonly actionRules: ActionRuleStore;

  constructor(private home: string) {
    this.file = join(home, "consent.json");
    this.rulesFile = join(home, "command-rules.json");
    this.actionRules = new ActionRuleStore(home);
    this.load();
  }

  /** 查自定义规则；Ask first 优先。summary 可用 actionSummary() 生成 */
  matchActionRule(summary: string): ActionRule | null {
    return this.actionRules.match(summary);
  }

  actionSummary(tool: string, description?: string, args?: Record<string, unknown>): string {
    return actionSummary(tool, description, args);
  }

  private load() {
    const grants = readJsonSafe<Grant[]>(this.file, []);
    if (Array.isArray(grants)) for (const g of grants) if (g?.botId && g.cap) this.grants.set(`${g.botId}:${g.cap}`, g);
    const raw = readJsonSafe<{
      rules?: CommandRule[];
      trusted?: string[];
      modes?: Record<string, string>;
      cliAgentPaths?: CliAgentPathGrant[];
      termOpenPaths?: TermOpenPathGrant[];
    }>(this.rulesFile, {});
    this.rules = (Array.isArray(raw.rules) ? raw.rules : []).filter((r) => r?.command && r.botId && (r.decision === "allow" || r.decision === "deny"));
    this.modes = new Map();
    if (raw.modes && typeof raw.modes === "object") {
      for (const [id, m] of Object.entries(raw.modes)) {
        if (m === "ask" || m === "auto" || m === "always") this.modes.set(id, m);
      }
    }
    // 旧 trusted[] → auto（已有 modes 条目的不覆盖）
    for (const id of Array.isArray(raw.trusted) ? raw.trusted : []) {
      if (id && !this.modes.has(id)) this.modes.set(id, "auto");
    }
    this.cliPaths = (Array.isArray(raw.cliAgentPaths) ? raw.cliAgentPaths : []).filter((p) => p?.botId && p?.prefix);
    this.termPaths = (Array.isArray(raw.termOpenPaths) ? raw.termOpenPaths : []).filter((p) => p?.botId && p?.prefix);
  }
  private persist() {
    writeJsonAtomic(this.file, [...this.grants.values()]);
  }
  private persistRules() {
    const modes: Record<string, PermissionMode> = {};
    for (const [id, m] of this.modes) if (m !== "ask") modes[id] = m;
    writeJsonAtomic(this.rulesFile, {
      rules: this.rules,
      // 兼容旧读法：auto|always 都算「信任过」
      trusted: Object.keys(modes),
      modes,
      cliAgentPaths: this.cliPaths,
      termOpenPaths: this.termPaths,
    });
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

  permissionMode(botId: string): PermissionMode {
    return this.modes.get(botId) ?? "ask";
  }

  setPermissionMode(botId: string, mode: PermissionMode) {
    if (mode === "ask") this.modes.delete(botId);
    else this.modes.set(botId, mode);
    this.persistRules();
  }

  /** Auto 或 Always：Shell / 终端 / Coding CLI 可跳过常规询问 */
  isTrusted(botId: string): boolean {
    const m = this.permissionMode(botId);
    return m === "auto" || m === "always";
  }

  /** 兼容旧 API：开 → Auto，关 → Ask */
  setTrusted(botId: string, on: boolean) {
    this.setPermissionMode(botId, on ? "auto" : "ask");
  }

  trustedBots(): string[] {
    return [...this.modes.entries()].filter(([, m]) => m === "auto" || m === "always").map(([id]) => id);
  }

  /** 各 bot 的模式表（Ask 不出现） */
  permissionModes(): Record<string, PermissionMode> {
    const out: Record<string, PermissionMode> = {};
    for (const [id, m] of this.modes) if (m !== "ask") out[id] = m;
    return out;
  }

  // ---- G10：cli.agent 目录前缀信任 ----

  private normalizePrefix(cwd: string): string {
    const abs = resolve(cwd.trim());
    try {
      if (existsSync(abs)) return realpathSync(abs);
      // 路径尚不存在时：对已有祖先做 realpath，避免 macOS /var → /private/var 与前缀对不上
      let cur = abs;
      while (true) {
        const parent = resolve(cur, "..");
        if (parent === cur) return abs;
        if (existsSync(parent)) {
          const realParent = realpathSync(parent);
          const rel = relative(parent, abs);
          return rel ? join(realParent, rel) : realParent;
        }
        cur = parent;
      }
    } catch {
      return abs;
    }
  }

  /**
   * 同一目录信任同时覆盖开终端、往里打字和派 Coding CLI。
   * 旧数据可能只记在其中一张表里，命中任意一张即算信任。
   */
  hasCodingDir(botId: string, cwd: string): boolean {
    return this.hasCliAgentPath(botId, cwd) || this.hasTermOpenPath(botId, cwd);
  }

  /** cwd 是否落在该 bot 已信任的前缀下 */
  hasCliAgentPath(botId: string, cwd: string): boolean {
    const real = this.normalizePrefix(cwd);
    return this.cliPaths.some(
      (p) => p.botId === botId && (real === p.prefix || real.startsWith(p.prefix + sep)),
    );
  }

  grantCliAgentPath(botId: string, cwd: string): CliAgentPathGrant {
    const prefix = this.normalizePrefix(cwd);
    this.cliPaths = this.cliPaths.filter((p) => !(p.botId === botId && p.prefix === prefix));
    const g: CliAgentPathGrant = { botId, prefix, createdAt: Date.now() };
    this.cliPaths.push(g);
    this.persistRules();
    return g;
  }

  revokeCliAgentPath(botId: string, cwd?: string) {
    this.revokeCodingDir(botId, cwd);
  }

  listCliAgentPaths(botId?: string): CliAgentPathGrant[] {
    return botId ? this.cliPaths.filter((p) => p.botId === botId) : [...this.cliPaths];
  }

  hasTermOpenPath(botId: string, cwd: string): boolean {
    const real = this.normalizePrefix(cwd);
    return this.termPaths.some(
      (p) => p.botId === botId && (real === p.prefix || real.startsWith(p.prefix + sep)),
    );
  }

  grantTermOpenPath(botId: string, cwd: string): TermOpenPathGrant {
    const prefix = this.normalizePrefix(cwd);
    this.termPaths = this.termPaths.filter((p) => !(p.botId === botId && p.prefix === prefix));
    const g: TermOpenPathGrant = { botId, prefix, createdAt: Date.now() };
    this.termPaths.push(g);
    this.persistRules();
    return g;
  }

  revokeTermOpenPath(botId: string, cwd?: string) {
    this.revokeCodingDir(botId, cwd);
  }

  /** 撤销目录信任时两张表一起清，避免只撤一边、另一边仍放行。 */
  private revokeCodingDir(botId: string, cwd?: string) {
    const drop = (p: { botId: string; prefix: string }) => {
      if (p.botId !== botId) return false;
      if (!cwd) return true;
      const prefix = this.normalizePrefix(cwd);
      return p.prefix === prefix || prefix.startsWith(p.prefix + sep) || p.prefix.startsWith(prefix + sep);
    };
    this.cliPaths = this.cliPaths.filter((p) => !drop(p));
    this.termPaths = this.termPaths.filter((p) => !drop(p));
    this.persistRules();
  }

  listTermOpenPaths(botId?: string): TermOpenPathGrant[] {
    return botId ? this.termPaths.filter((p) => p.botId === botId) : [...this.termPaths];
  }

  /**
   * cli.agent / term.open：Auto / Always 直接放行。
   * Ask 下弹窗，可选「总是允许此目录」。任何具体目录都能记住，包括 /tmp。
   */
  async requestCliAgent(
    botId: string,
    cwd: string,
    description: string,
    opts?: { reasons?: string[]; unattended?: boolean },
  ): Promise<{ granted: boolean; remembered?: boolean; viaPathGrant?: boolean }> {
    const prefix = this.normalizePrefix(cwd);
    // 已信任前缀：放行但仍标记 viaPathGrant，调用方须写一条可见摘要（避免完全静默）
    if (this.hasCodingDir(botId, prefix)) return { granted: true, viaPathGrant: true };
    if (this.isTrusted(botId)) return { granted: true }; // Auto / Always
    // 例行 / 入站是用户已经定下的吩咐，到点没有人能点卡片，这一次直接做，不写成永久目录信任。
    if (opts?.unattended) return { granted: true };
    if (!this.decider) return { granted: false };
    const decision = await this.decider({
      botId,
      cap: "cli:agent",
      description,
      requiresStrongConsent: true,
      rememberPath: prefix,
      reasons: opts?.reasons,
    });
    if (decision === "deny") return { granted: false };
    if (decision === "allow-command") {
      this.rememberCodingDir(botId, prefix);
      return { granted: true, remembered: true };
    }
    return { granted: true };
  }

  /** 一次「总是允许此目录」同时记下开终端和派工。 */
  private rememberCodingDir(botId: string, prefix: string) {
    this.grantCliAgentPath(botId, prefix);
    this.grantTermOpenPath(botId, prefix);
  }

  /** term.open：与派工共用目录信任。用户点「打开」不经这里。 */
  async requestTermOpen(
    botId: string,
    cwd: string,
    description: string,
    opts?: { reasons?: string[]; unattended?: boolean },
  ): Promise<{ granted: boolean; remembered?: boolean; viaPathGrant?: boolean }> {
    const prefix = this.normalizePrefix(cwd);
    if (this.hasCodingDir(botId, prefix)) return { granted: true, viaPathGrant: true };
    if (this.isTrusted(botId)) return { granted: true }; // Auto / Always
    if (opts?.unattended) return { granted: true };
    if (!this.decider) return { granted: false };
    const decision = await this.decider({
      botId,
      cap: "term:open",
      description,
      rememberPath: prefix,
      reasons: opts?.reasons,
    });
    if (decision === "deny") return { granted: false };
    if (decision === "allow-command") {
      this.rememberCodingDir(botId, prefix);
      return { granted: true, remembered: true };
    }
    return { granted: true };
  }

  /** bot 内部浏览器：第一次问；「以后不再问」记 browser:open grant；Auto/Always 跳过。 */
  async requestBrowserOpen(
    botId: string,
    description: string,
    opts?: { reasons?: string[]; unattended?: boolean; tool?: string },
  ): Promise<{ granted: boolean }> {
    const summary = this.actionSummary(opts?.tool || "browser.open", description);
    const hit = this.matchActionRule(summary);
    if (hit?.decision === "ask_first") {
      if (opts?.unattended) return { granted: false };
      return this.request(botId, "browser:open", description, {
        reasons: [...(opts?.reasons ?? []), `自定义规则「${hit.text}」要求先问`],
        actionRuleId: hit.id,
        forceAsk: true,
      });
    }
    if (hit?.decision === "allow" || this.isTrusted(botId)) return { granted: true };
    if (opts?.unattended) return { granted: true };
    return this.request(botId, "browser:open", description, { reasons: opts?.reasons });
  }

  /**
   * 请求授权：有 grant → 消耗 once 并返回 true；无 → 调 decider 弹窗。
   * Always 模式直接放行；Ask/Auto 下危险/onceOnly 不走已有长期授权。
   * Custom Rules：Ask first 强制弹卡；Allow 可跳过常规询问（强确认仍问）。
   */
  async request(botId: string, cap: Cap, description: string, opts?: {
    requiresStrongConsent?: boolean; onceOnly?: boolean; reasons?: string[]; unattended?: boolean;
    tool?: string; args?: Record<string, unknown>; actionRuleId?: string; forceAsk?: boolean;
  }): Promise<{ granted: boolean }> {
    this.expire();
    const mode = this.permissionMode(botId);
    const summary = this.actionSummary(opts?.tool || cap, description, opts?.args);
    const hit = opts?.forceAsk ? (opts.actionRuleId ? this.actionRules.get(opts.actionRuleId) : this.matchActionRule(summary)) : this.matchActionRule(summary);
    if (hit?.decision === "ask_first" || opts?.forceAsk) {
      if (opts?.unattended) return { granted: false };
      if (!this.decider) return { granted: false };
      const reasons = [...(opts?.reasons ?? [])];
      if (hit && !reasons.some((r) => r.includes(hit.text))) reasons.push(`自定义规则「${hit.text}」要求先问`);
      const decision = await this.decider({
        botId, cap, description,
        requiresStrongConsent: opts?.requiresStrongConsent,
        onceOnly: opts?.onceOnly || undefined,
        reasons: reasons.length ? reasons : undefined,
        actionRuleId: hit?.id,
      });
      if (decision === "deny") return { granted: false };
      if (decision === "allow" && !opts?.onceOnly) this.grant(botId, cap);
      return { granted: true };
    }
    if (mode === "always") return { granted: true };
    if (hit?.decision === "allow" && !opts?.requiresStrongConsent && !opts?.onceOnly) return { granted: true };
    // 例行做普通工作。删除这类不可逆操作停在批准点，不弹没人能点的卡。
    if (opts?.unattended && opts?.requiresStrongConsent) return { granted: false };
    if (opts?.unattended) return { granted: true };
    const once = !!opts?.onceOnly;
    const g = this.grants.get(`${botId}:${cap}`);
    if (g && !once) {
      if (g.once) { this.grants.delete(`${botId}:${cap}`); this.persist(); }
      return { granted: true };
    }
    if (opts?.unattended) return { granted: false };
    if (!this.decider) return { granted: false };
    const decision = await this.decider({ botId, cap, description, requiresStrongConsent: opts?.requiresStrongConsent, onceOnly: once || undefined, reasons: opts?.reasons });
    if (decision === "deny") return { granted: false };
    if (decision === "allow" && !once) this.grant(botId, cap);
    return { granted: true };
  }

  /** 卡片「总是允许」：可写命令规则，也可写入账号级 Allow 自定义规则（Grok Custom Rules） */
  private rememberAllowDecision(
    botId: string,
    command: string | undefined,
    decision: ConsentDecision,
    opts?: { onceOnly?: boolean; suggestAllowRule?: string },
  ) {
    if (decision !== "allow-command" && decision !== "allow") return;
    if (!opts?.onceOnly && command) this.setCommandRule(botId, command, "allow");
    const ruleText = (opts?.suggestAllowRule || "").trim();
    if (!ruleText) return;
    try {
      this.actionRules.add(ruleText, "allow");
    } catch {
      // Allow 已满 20：挤掉最旧一条再写（对齐 Grok Always allow 挤位）
      const oldest = this.actionRules.list("allow")[0];
      if (oldest) this.actionRules.remove(oldest.id);
      try { this.actionRules.add(ruleText, "allow"); } catch { /* 仍失败就只放行本次 */ }
    }
  }

  /** 单个命令的授权：「总是允许」只记成这个 bot 对这一个命令的规则，不会放行整组命令 */
  async requestCommand(
    botId: string, command: string, description: string,
    opts?: {
      cap?: Cap; requiresStrongConsent?: boolean; onceOnly?: boolean; reasons?: string[];
      unattended?: boolean; suggestAllowRule?: string;
    },
  ): Promise<{ granted: boolean }> {
    const mode = this.permissionMode(botId);
    const summary = this.actionSummary(command, description);
    const hit = this.matchActionRule(summary);
    if (hit?.decision === "ask_first") {
      if (opts?.unattended) return { granted: false };
      if (!this.decider) return { granted: false };
      const decision = await this.decider({
        botId, cap: opts?.cap ?? "bash:other", description, requiresStrongConsent: opts?.requiresStrongConsent,
        command, onceOnly: opts?.onceOnly || undefined,
        reasons: [...(opts?.reasons ?? []), `自定义规则「${hit.text}」要求先问`],
        actionRuleId: hit.id,
        suggestAllowRule: opts?.suggestAllowRule,
      });
      if (decision === "deny") return { granted: false };
      this.rememberAllowDecision(botId, command, decision, opts);
      return { granted: true };
    }
    // Always：含危险命令一并放行（调用方已拦 deny 规则）
    if (mode === "always") return { granted: true };
    // Allow 规则可跳过常规与路径风险（危险仍问）
    if (hit?.decision === "allow" && !opts?.requiresStrongConsent) return { granted: true };
    // Auto：非危险直接放行。危险命令有人在场才确认；无人时停在批准点。
    if (mode === "auto" && !opts?.requiresStrongConsent) return { granted: true };
    const once = !!opts?.onceOnly;
    if (!once && this.commandRule(botId, command) === "allow") return { granted: true };
    // 例行可以做准备和普通命令。发送、删除、改生产、危险命令不偷偷执行。
    if (opts?.unattended && !opts?.requiresStrongConsent) return { granted: true };
    if (opts?.unattended) return { granted: false };
    if (!this.decider) return { granted: false };
    const decision = await this.decider({
      botId, cap: opts?.cap ?? "bash:other", description, requiresStrongConsent: opts?.requiresStrongConsent,
      command, onceOnly: once || undefined, reasons: opts?.reasons,
      suggestAllowRule: opts?.suggestAllowRule,
    });
    if (decision === "deny") return { granted: false };
    this.rememberAllowDecision(botId, command, decision, opts);
    return { granted: true };
  }

  decider: ConsentDecider | null = null;
}
