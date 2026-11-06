import { capLabel, type Cap, type CliAgentPathGrant, type CommandRule, type ConsentCenter, type Grant, type PermissionMode, type TermOpenPathGrant } from "./consent-center";

export type GatewayAccessInfo = {
  enabled: boolean;
  host?: string;
  port?: number;
  loopback?: boolean;
  allowRemote?: boolean;
  routinesBase?: string;
  /** 非回环且未显式允许时为 true */
  remoteBlocked?: boolean;
};

export type RoutineAccessRow = {
  id: string;
  name: string;
  enabled: boolean;
  hasWebhook: boolean;
  /** 完整能力 URL（仅网关开启且有 token 时） */
  capabilityUrl?: string;
  /** 仅令牌，网关未开时也给 */
  webhookToken?: string;
};

export type BotAccessOverview = {
  botId: string;
  mode: PermissionMode;
  modeHint: string;
  grants: Array<{ cap: Cap; label: string; once?: boolean; expiresAt?: number; grantedAt: number }>;
  allowCommands: string[];
  denyCommands: string[];
  cliPaths: string[];
  termPaths: string[];
  routines: RoutineAccessRow[];
  gateway: GatewayAccessInfo;
  recentAudit: Array<{ at: number; cap: string; action: string; ok: boolean; detail?: string }>;
  /** 给人看的短句清单 */
  canDo: string[];
  warnings: string[];
};

const MODE_HINT: Record<PermissionMode, string> = {
  ask: "每次敏感操作先问你",
  auto: "Shell / 终端 / Coding CLI 自动过；危险命令仍要确认",
  always: "工具默认全过（含危险命令）；禁止规则仍生效",
};

export function isLoopbackHost(host: string | undefined | null): boolean {
  const h = (host || "127.0.0.1").trim().toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1";
}

/** 非回环绑定是否允许启动（需显式 allowRemote） */
export function gatewayBindAllowed(gw: { host?: string; allowRemote?: boolean } | null | undefined): {
  ok: boolean;
  host: string;
  loopback: boolean;
  reason?: string;
} {
  const host = (gw?.host || "127.0.0.1").trim() || "127.0.0.1";
  const loopback = isLoopbackHost(host);
  if (loopback) return { ok: true, host, loopback: true };
  if (gw?.allowRemote === true) return { ok: true, host, loopback: false };
  return {
    ok: false,
    host,
    loopback: false,
    reason: `网关 host=${host} 非本机回环，且未设 gateway.allowRemote=true。例行 POST /routines/:token 无 Bearer，默认拒绝绑定。`,
  };
}

export function buildBotAccessOverview(input: {
  botId: string;
  consent: ConsentCenter;
  routines?: Array<{ id: string; name: string; enabled: boolean; webhookToken?: string }>;
  gateway?: GatewayAccessInfo | null;
  /** 短链桥 base，有则优先公网 /w/:token */
  shareBridgeBase?: string | null;
  audit?: Array<{ at: number; botId: string; cap: string; action: string; ok: boolean; detail?: string }>;
}): BotAccessOverview {
  const { botId, consent } = input;
  const mode = consent.permissionMode(botId);
  const grants = consent.list(botId);
  const rules = consent.listCommandRules(botId);
  const allowCommands = uniqCmds(rules.filter((r) => r.decision === "allow"));
  const denyCommands = uniqCmds(rules.filter((r) => r.decision === "deny"));
  const cliPaths = consent.listCliAgentPaths(botId).map((p) => p.prefix);
  const termPaths = consent.listTermOpenPaths(botId).map((p) => p.prefix);

  const gw = normalizeGateway(input.gateway);
  const cloudBase = (input.shareBridgeBase || "").replace(/\/$/, "");
  const routines: RoutineAccessRow[] = (input.routines || []).map((t) => {
    const token = t.webhookToken?.trim() || undefined;
    const cloudUrl = cloudBase && token ? `${cloudBase}/w/${token}` : undefined;
    const localUrl = gw.enabled && token && gw.routinesBase ? `${gw.routinesBase.replace(/\/$/, "")}/${token}` : undefined;
    return {
      id: t.id,
      name: t.name,
      enabled: !!t.enabled,
      hasWebhook: !!token,
      webhookToken: token,
      capabilityUrl: cloudUrl || localUrl,
    };
  });

  const recentAudit = (input.audit || [])
    .filter((e) => e.botId === botId)
    .slice(0, 12)
    .map((e) => ({ at: e.at, cap: e.cap, action: e.action, ok: e.ok, detail: e.detail }));

  const canDo: string[] = [];
  const warnings: string[] = [];
  canDo.push(`权限模式：${modeLabel(mode)}（${MODE_HINT[mode]}）`);
  if (mode === "always") warnings.push("Always：危险命令也可直接执行，请确认禁止规则够用。");
  if (grants.length) {
    canDo.push(`已批准能力：${grants.map((g) => formatGrant(g)).join("、")}`);
  } else {
    canDo.push("尚未单独批准能力（Ask 下会逐次询问；Auto/Always 另按模式放行）。");
  }
  if (allowCommands.length) canDo.push(`命令白名单：${allowCommands.join("、")}`);
  if (denyCommands.length) {
    canDo.push(`命令禁止：${denyCommands.join("、")}`);
    warnings.push(`禁止规则对 Always 仍生效：${denyCommands.join("、")}`);
  }
  if (termPaths.length) canDo.push(`可免问开终端的目录：${termPaths.map(shortPath).join("、")}`);
  if (cliPaths.length) canDo.push(`可免问派 Coding CLI 的目录：${cliPaths.map(shortPath).join("、")}`);
  const hookRoutines = routines.filter((r) => r.hasWebhook);
  if (hookRoutines.length) {
    canDo.push(`入站例行 Webhook：${hookRoutines.map((r) => r.name).join("、")}${gw.enabled ? "" : "（网关未开，仅有令牌）"}`);
  }
  if (gw.enabled && !gw.loopback) {
    warnings.push(`网关绑在 ${gw.host}（非回环）：例行能力 URL 即令牌，勿外泄；可加请求头 X-Harness-Signature: HMAC-SHA256(token, body)。网关有每分钟限流。`);
  }
  if (hookRoutines.length && gw.enabled) {
    warnings.push("入站例行 Webhook 为能力型 URL（路径含令牌）；泄露即可触发整轮 bot，请当密码保管。");
  }
  if (gw.remoteBlocked) {
    warnings.push(`网关曾配置非回环 host，但未设 allowRemote，当前未对外绑定。`);
  }

  return {
    botId,
    mode,
    modeHint: MODE_HINT[mode],
    grants: grants.map((g) => ({
      cap: g.cap,
      label: capLabel(g.cap),
      once: g.once,
      expiresAt: g.expiresAt,
      grantedAt: g.grantedAt,
    })),
    allowCommands,
    denyCommands,
    cliPaths,
    termPaths,
    routines,
    gateway: gw,
    recentAudit,
    canDo,
    warnings,
  };
}

function normalizeGateway(gw?: GatewayAccessInfo | null): GatewayAccessInfo {
  if (!gw?.enabled) {
    return {
      enabled: false,
      host: gw?.host,
      port: gw?.port,
      allowRemote: gw?.allowRemote,
      remoteBlocked: gw?.remoteBlocked,
    };
  }
  const host = gw.host || "127.0.0.1";
  const loopback = gw.loopback ?? isLoopbackHost(host);
  return {
    enabled: true,
    host,
    port: gw.port,
    loopback,
    allowRemote: gw.allowRemote,
    routinesBase: gw.routinesBase || (gw.port ? `http://${host}:${gw.port}/routines` : undefined),
    remoteBlocked: gw.remoteBlocked,
  };
}

function modeLabel(m: PermissionMode): string {
  return m === "always" ? "Always" : m === "auto" ? "Auto" : "Ask";
}

function formatGrant(g: Grant): string {
  const base = capLabel(g.cap);
  if (g.once) return `${base}（仅一次）`;
  if (g.expiresAt) return `${base}（限期）`;
  return base;
}

function uniqCmds(rules: CommandRule[]): string[] {
  return [...new Set(rules.map((r) => r.command))].sort();
}

function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return `…/${parts.slice(-2).join("/")}`;
}

/** 测试/调用方也可直接用 path 列表组装（不依赖 ConsentCenter 实例方法以外的数据） */
export function summarizePaths(cli: CliAgentPathGrant[], term: TermOpenPathGrant[], botId: string) {
  return {
    cliPaths: cli.filter((p) => p.botId === botId).map((p) => p.prefix),
    termPaths: term.filter((p) => p.botId === botId).map((p) => p.prefix),
  };
}
