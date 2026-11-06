/**
 * Harness Bot — Electron 壳
 * Tray(菜单栏) + 主控窗口 + 宠物窗口(无边框透明)
 * 核心逻辑全部在 core/（纯 TS），这里只做宿主桥接。
 */
import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, clipboard, Notification, screen, nativeImage, shell, safeStorage, systemPreferences } from "electron";
import { SecretStore } from "../core/secret-store";
import { EnvStore } from "../core/env-store";
import { GroupSessionRunner, pickGroupSession, type GroupProgress, type GroupSessionHooks } from "../core/group-session";
import { join, resolve, extname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, readFileSync, existsSync, statSync, openSync, readSync, closeSync, readdirSync, watch, realpathSync } from "node:fs";
import { createUsageBook } from "./host/usage";
import { createSemanticRecall, type EmbeddingConfig } from "./host/semantic";
import { EVAL_MODE, prepareEvalHome, runEvalMode } from "./host/eval-mode";
import { pathToFileURL } from "node:url";

// 应用根：electron . 运行时 getAppPath() 返回项目根目录
// bun build 会把 import.meta.url / __dirname 编译成源码路径，不能用于定位运行文件。
const APP_ROOT = app.getAppPath();
const DIST_DIR = join(APP_ROOT, "dist");
import { Store } from "../core/store";
import { AgentRegistry } from "../core/agent-registry";
import { seedBotWelcome } from "../core/bot-onboard";
import { seedGroupWelcome } from "../core/group-onboard";
import { detectChoiceOffer } from "../core/choice-offer";
import { gatewayBindAllowed, isLoopbackHost } from "../core/bot-access";
import { MessageBus } from "../core/message-bus";
import { ProviderCenter } from "../core/provider-center";
import { PersonaGenerator, parseAppearancePick, type AppearancePick } from "../core/persona";
import {
  buildPetMind, formatMindForPrompt, notePetDecision, listPetActivity, extractCompanionFact, levelFromXp, type PetMind,
} from "../core/pet-mind";
import { resolveMotion, traitsBlob } from "../core/pet-motion";
import { expandPhraseToBeats, estimateScriptMs, type PetBeat } from "../core/pet-script";
import type { PetActName } from "../core/pet-director";
import { MigrationV2 } from "../core/migration-v2";
import { SystemKit } from "../core/system-kit";
import { MemorySystem, memoRewriteMessages } from "../core/memory-system";
import { SkillRegistry, BUILTIN_SKILL_TEMPLATES } from "../core/skill-registry";
import { Scheduler } from "../core/scheduler";
import { GroupRegistry } from "../core/group-registry";
import { FileLogger } from "../core/logger";
import { SCHEMA_VERSION, ensureSchema } from "../core/schema";
import { ProactiveEngine, collectSignals } from "../core/proactive";
import { GatewayServer } from "../core/gateway-server";
import {
  buildInboundExtraSystem,
  buildInboundUserText,
  InboundDedupe,
  parseInboundWebhookBody,
  claimInboundEvent,
  sortInboundEventsByPriority,
  type InboundPriority,
} from "../core/inbound-webhook";
import { pickRoutineTranscriptSessionId } from "../core/routine-session";
import { PetSkinRegistry } from "../core/pet-skin";
import { ConsentCenter, capLabel as capLabelOf, type ConsentDecision } from "../core/consent-center";
import { CodingThreadStore } from "../core/coding-thread";
import { CodingPresence, dropCodingDir, gazeCodingDir, type CodingPresenceView } from "../core/coding-presence";
import { appendCodingActivity } from "../core/coding-activity";
import { codingCliIdentity, resolveAppIdentity, type AppIdentity } from "../core/app-identity";
import { formatObserveText, observeDiskAsync, observeFrontmostAsync, observeProcessesAsync, observeSystem, type ProcessHit } from "../core/system-observe";
import { listInstalledApps, readBotWatch, watchKeywords, writeBotWatch, type BotSystemWatch } from "../core/system-watch";
import { CliAgentPathError, resolveAgentCwd } from "../core/cli-agent";
import { AuditLog } from "../core/audit-log";
import { SystemAccess } from "../core/system-access";
import { BotRuntime } from "../core/bot-runtime";
import { attachPetEntertainment, type PetHost } from "../core/pet";
import { DemoSkillEngine } from "../core/demo-skill";
import { ContactStore } from "../core/contacts";
import { ConnectorStore, CONNECT_INSTALL_CARDS } from "../core/connectors";
import { parseRunAt } from "../core/runtime/tool-helpers";
import { Vault } from "../core/vault";
import { OfflinePersona } from "../core/offline-persona";
import { ToolExecutor } from "../core/tool-executor";
import { McpClient, type McpServerConfig } from "../core/mcp-client";
import { COMPUTER_MCP_ID, ensureBuiltinMcpServers, isBuiltinMcpId, mcpServersForClient } from "../core/builtin-mcp";
import { buildComputerSteps, computerMcpConfig, ensureManagedUv, humanizeComputerError, warmComputerUseKit, type ComputerUseStatus } from "../core/computer-use-setup";
import { CompanionEngine } from "../core/companion";
import {
  parsePetIntent,
  parsePetIntentsRule,
  shouldUseDirectorModel,
  directorSystemPrompt,
  directorUserPrompt,
  parseDirectorIntents,
  type PetIntent,
} from "../core/pet-director";
import {
  clearPetBotPrefs, mergePrefs, patchPetBotPrefs, petPrefsFromConfig, resolvePetPrefs, type PetPrefs,
} from "../core/pet-prefs";
import { PetEvolveEngine, parseEvolveInvent } from "../core/pet-evolve";
import { PetVisitEngine, parseVisitLines } from "../core/pet-visit";
import {
  PetEffectRegistry,
  fxInventSystemPrompt,
  fxInventUserPrompt,
  parseInventedEffect,
  type FxRecipe,
} from "../core/pet-effects";
import { RECOMMENDED_PETDEX, fetchPetdexManifest, installPetdex, petdexSkinId, searchPetdex } from "../core/petdex";
import { OpenAICompatImageGen } from "../core/adapters/image-gen";
import { AgentStatus, contentText, type Bot, type ContentBlock, type ScheduledTask, type Session } from "../core/types";
import { defaultAvatar, withDefaultAvatar } from "../core/avatar";
import type { ImageGenConfig } from "../core/image-tool";
import { ProjectRegistry, instructionsPrompt, type GlobalInstructions } from "../core/projects";
import { ingestFiles } from "../core/attachments";
import { registerShareIpc } from "./host/share";
import { registerSecurityIpc } from "./host/security-ipc";
import { registerSkinsIpc } from "./host/skins-ipc";
import { registerVoiceIpc } from "./host/voice-ipc";
import { registerRealmIpc } from "./host/realm-ipc";
import { registerKnowledgeIpc } from "./host/knowledge-ipc";
import { TEMPLATE_EXT, TEMPLATE_SCHEME, normalizeTemplate, parseTemplate, templateLink, templateOf, uniqueBotName, type BotTemplate } from "../core/bot-template";
import {
  collectNeeds,
  diffNeeds,
  hasNeeds,
  onboardGreeting,
  type NeedsDiff,
} from "../core/bot-share-needs";
import {
  ackCloudInboundEvents,
  clearShareBridgeCreds,
  cloudInboundWebhookUrl,
  deleteShareBridgeLink,
  listShareBridgeLinks,
  probeShareBridge,
  pullCloudInboundEvents,
  putHarnessShortLink,
  registerCloudInboundTokens,
  resolveTemplateInput,
  saveShareBridgeCreds,
  shareBridgeCreds,
  shareBridgeStatus,
  unregisterCloudInboundTokens,
} from "../core/share-bridge";
import {
  clearCloudflareCreds,
  cloudflareCredsStatus,
  provisionShareBridge,
  saveCloudflareCreds,
} from "../core/share-bridge-provision";

if (EVAL_MODE) prepareEvalHome(process.env.HARNESS_HOME || join(app.getPath("userData"), "..", "harness-bot"), (dir) => app.setPath("userData", dir));

// 两个进程同时读写同一份数据会互相覆盖，只允许开一个
if (!EVAL_MODE && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
/** 最近一条带会话的系统通知：osascript 兜底点不了 onClick，靠 activate 打开主面板 */
let pendingNotifySession: string | null = null;
/** 入站投递（whenReady 里挂上；网关 / 云轮询共用） */
let deliverInboundWebhook: ((task: ScheduledTask, parsed: ReturnType<typeof parseInboundWebhookBody>) => Promise<void>) | null = null;
type InboundJob = {
  task: ScheduledTask;
  parsed: ReturnType<typeof parseInboundWebhookBody>;
  source: "gateway" | "cloud";
  eventId?: string;
  kvKey?: string;
};
let enqueueInboundJob: ((job: InboundJob) => void) | null = null;

function focusMainPanel(sessionId?: string | null) {
  const sid = sessionId ?? pendingNotifySession;
  if (sid) pendingNotifySession = null;
  if (!mainWin || mainWin.isDestroyed()) {
    createMainWindow();
    if (sid) mainWin?.webContents.once("did-finish-load", () => mainWin?.webContents.send("window:open-session", sid));
    return;
  }
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
  // Dock / activate 常带着上次通知的 sessionId；渲染端会对「已在看的会话」直接跳过，避免 clear→空白→重绘
  if (sid) mainWin.webContents.send("window:open-session", sid);
}

app.on("second-instance", () => focusMainPanel());

const home = process.env.HARNESS_HOME || join(app.getPath("userData"), "..", "harness-bot");
const schemaBoot = ensureSchema(home);
const logger = new FileLogger(home);
logger.captureConsole();
if (schemaBoot.created || schemaBoot.from !== schemaBoot.to) {
  logger.write("info", `[schema] ${schemaBoot.created ? "创建" : "升级"} ${schemaBoot.from} → ${schemaBoot.to}`);
}
process.on("uncaughtException", (e) => {
  logger.write("error", "[harness] 未捕获的异常", e);
  console.error("[harness] 未捕获的异常", e);
});
process.on("unhandledRejection", (r) => {
  logger.write("error", "[harness] 未处理的 Promise 拒绝", r);
  console.error("[harness] 未处理的 Promise 拒绝", r);
});
app.on("child-process-gone", (_e, d) => { if (d.reason !== "clean-exit") console.error(`[harness] 子进程退出：${d.type} ${d.reason}`); });
const store = new Store(home);
const assetsDir = join(home, "assets");
const petSkins = new PetSkinRegistry(assetsDir);
const registry = new AgentRegistry(store);
const bus = new MessageBus(store);
const providers = new ProviderCenter(store);
const persona = new PersonaGenerator(store, assetsDir);

const system = new SystemKit({
  allowedRoot: join(home, "workspace"),
  notify: (p) => deliverNotification({ title: p.title, body: p.body }),
  clipboardWrite: (t) => clipboard.writeText(t),
  clipboardRead: () => clipboard.readText(),
});

// ---- Bot 底层运行时（持久记忆 / 技能 / 定时任务）----
const memory = new MemorySystem(home);
/** MEMORY.md：新增 fact/rule 后后台蒸馏（对齐 Grok Build 的 capture→dream，不挡回复） */
memory.setMemoRewriter(async (_ns, cur, recent) => {
  const p = providers.getDefault();
  if (!p) return cur;
  const msg = memoRewriteMessages(cur, recent);
  const r = await providers.complete(p, { system: msg.system, user: msg.user });
  return r.text.trim() || cur;
});
const skillsDir = join(home, "skills");
const skills = new SkillRegistry(skillsDir);
if (skills.list().length === 0) {
  for (const [k, md] of Object.entries(BUILTIN_SKILL_TEMPLATES)) {
    try { skills.create(k, md); } catch {}
  }
}
const scheduler = new Scheduler(home);
const groups = new GroupRegistry(home);
bus.setGroups(groups);

/** 本机 HTTP 网关（例行入站）；Connect 设置页可热启停 */
type GatewayCfg = { port?: number; token?: string; host?: string; allowRemote?: boolean; requireHmac?: boolean };
let gatewayServer: GatewayServer | null = null;
const readGatewayCfg = (): GatewayCfg | undefined =>
  (store.readConfig() as { gateway?: GatewayCfg }).gateway;
function maskToken(tok: string): string {
  if (!tok) return "";
  if (tok.length <= 8) return "••••";
  return `${tok.slice(0, 4)}…${tok.slice(-4)}`;
}

function gatewaySnapshot() {
  const gw = readGatewayCfg();
  if (!gw?.port) {
    return {
      enabled: false as const,
      running: false,
      configured: false,
      host: "127.0.0.1",
      port: 8787,
      allowRemote: false,
      requireHmac: false,
      loopback: true,
      hasMsgToken: false,
      msgTokenHint: "",
    };
  }
  const bind = gatewayBindAllowed(gw);
  const host = bind.ok ? bind.host : (gw.host ?? "127.0.0.1");
  const token = gw.token && gw.token.length >= 16 ? gw.token : "";
  return {
    enabled: bind.ok && !!gatewayServer,
    running: !!gatewayServer,
    configured: true,
    host,
    port: gw.port,
    allowRemote: !!gw.allowRemote,
    requireHmac: !!gw.requireHmac,
    loopback: isLoopbackHost(host),
    remoteBlocked: !bind.ok,
    routinesBase: bind.ok && gatewayServer ? `http://${host}:${gw.port}/routines` : undefined,
    botsMsgUrl: bind.ok && gatewayServer ? `http://${host}:${gw.port}/bots/msg` : undefined,
    hasMsgToken: !!token,
    msgTokenHint: maskToken(token),
    warning: bind.ok ? undefined : bind.reason,
    guide: "例行：面板 🪝 复制能力 URL。跨机 bot：用下方 Bearer 调 POST /bots/msg。令牌等同密码。"
      + (gw.requireHmac ? " 已强制要求 X-Harness-Signature。" : ""),
  };
}

async function rotateGatewayMsgToken() {
  const gw = readGatewayCfg();
  if (!gw?.port) return { ok: false as const, error: "请先启用入站网关", info: gatewaySnapshot() };
  gw.token = randomBytes(24).toString("hex");
  store.writeConfig({ ...store.readConfig(), gateway: gw });
  const started = await startGatewayFromConfig();
  return {
    ok: started.ok,
    error: started.error,
    info: started.info ?? gatewaySnapshot(),
    token: gw.token,
  };
}

function copyGatewayMsgToken(): { ok: boolean; token?: string; error?: string; info: ReturnType<typeof gatewaySnapshot> } {
  const gw = readGatewayCfg();
  if (!gw?.port || !gw.token || gw.token.length < 16) {
    return { ok: false, error: "网关未启用或尚无令牌", info: gatewaySnapshot() };
  }
  return { ok: true, token: gw.token, info: gatewaySnapshot() };
}
async function stopGateway() {
  if (!gatewayServer) return;
  try { await gatewayServer.stop(); } catch { /* ignore */ }
  gatewayServer = null;
}
async function startGatewayFromConfig(): Promise<{ ok: boolean; error?: string; info?: ReturnType<typeof gatewaySnapshot> }> {
  await stopGateway();
  const gw = readGatewayCfg();
  if (!gw?.port) return { ok: true, info: gatewaySnapshot() };
  if (!gw.token || gw.token.length < 16 || gw.token === "harness-default-token") {
    gw.token = randomBytes(24).toString("hex");
    store.writeConfig({ ...store.readConfig(), gateway: gw });
  }
  const bind = gatewayBindAllowed(gw);
  if (!bind.ok) {
    console.error(`[harness] ${bind.reason}`);
    return { ok: false, error: bind.reason, info: gatewaySnapshot() };
  }
  const host = bind.host;
  if (!bind.loopback) {
    console.warn(`[harness] 网关 host=${host} 非本机回环（已显式 allowRemote）：POST /routines/:token 为能力 URL（无 Bearer），勿把令牌发到不可信渠道`);
  }
  const server = new GatewayServer(gw.port, gw.token, bus, { host, requireHmac: !!gw.requireHmac });
  server.onRoutine = async (token, body, meta) => {
    const task = scheduler.findByWebhookToken(token);
    if (!task) return { ok: false, error: "not found" };
    if (!task.enabled) return { ok: false, error: "routine paused" };
    const parsed = parseInboundWebhookBody(body, { priority: meta?.priorityHeader });
    // 快速受理：入队；真正注入由 inbound pump（会话串行 + urgent 插队）
    if (!enqueueInboundJob) return { ok: false, error: "runtime not ready" };
    enqueueInboundJob({ task, parsed, source: "gateway" });
    return {
      ok: true,
      accepted: true,
      taskId: task.id,
      name: task.name,
      priority: parsed.priority,
    };
  };
  try {
    const port = await server.start();
    gatewayServer = server;
    console.log(`[harness] 网关已启动 ${host}:${port} 🕸（例行 POST /routines/:token）`);
    return { ok: true, info: gatewaySnapshot() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[harness] 网关启动失败:", msg);
    return { ok: false, error: msg, info: gatewaySnapshot() };
  }
}
async function applyGatewaySettings(input: {
  enabled: boolean;
  port?: number;
  host?: string;
  allowRemote?: boolean;
  requireHmac?: boolean;
}) {
  const prev = readGatewayCfg() ?? {};
  if (!input.enabled) {
    store.writeConfig({ ...store.readConfig(), gateway: undefined });
    await stopGateway();
    return { ok: true as const, info: gatewaySnapshot() };
  }
  const port = Math.max(1, Math.min(65535, Number(input.port ?? prev.port ?? 8787) || 8787));
  const host = String(input.host ?? prev.host ?? "127.0.0.1").trim() || "127.0.0.1";
  const allowRemote = input.allowRemote === true;
  const requireHmac = input.requireHmac === true;
  if (!isLoopbackHost(host) && !allowRemote) {
    return {
      ok: false as const,
      error: "绑定非本机地址时必须勾选「允许远程访问」。默认只监听 127.0.0.1 更安全。",
      info: gatewaySnapshot(),
    };
  }
  const gw: GatewayCfg = {
    port,
    host,
    allowRemote: allowRemote || undefined,
    requireHmac: requireHmac || undefined,
    token: prev.token && prev.token.length >= 16 ? prev.token : randomBytes(24).toString("hex"),
  };
  store.writeConfig({ ...store.readConfig(), gateway: gw });
  const started = await startGatewayFromConfig();
  if (!started.ok) return { ok: false as const, error: started.error, info: started.info ?? gatewaySnapshot() };
  return { ok: true as const, info: started.info ?? gatewaySnapshot() };
}

const migration = new MigrationV2(store, assetsDir, memory, skills, scheduler, groups);
const workspace = join(home, "workspace");
const consent = new ConsentCenter(home);
const codingThreads = new CodingThreadStore(home);
const codingPresence = new CodingPresence({
  home,
  bridgePath: join(APP_ROOT, "assets", "pty-bridge.py"),
});
const audit = new AuditLog(home);
const systemAccess = new SystemAccess(consent, audit, { workDir: workspace, screenshotDir: join(workspace, "screenshots") });
const executor = new ToolExecutor({
  allowedRoots: [workspace],
  consent,
  audit,
  bashGroups: {
    echo: "bash:read", ls: "bash:read", cat: "bash:read", head: "bash:read", tail: "bash:read", grep: "bash:read", rg: "bash:read", find: "bash:read", pwd: "bash:read", date: "bash:read", whoami: "bash:read", wc: "bash:read", sort: "bash:read", uniq: "bash:read", sed: "bash:read", awk: "bash:read", jq: "bash:read", df: "bash:read", du: "bash:read",
    git: "bash:dev", npm: "bash:dev", pnpm: "bash:dev", bun: "bash:dev", node: "bash:dev", swift: "bash:dev", make: "bash:dev",
    curl: "bash:net", wget: "bash:net", ping: "bash:net", dig: "bash:net", nslookup: "bash:net",
    mkdir: "bash:io", touch: "bash:io", cp: "bash:io", mv: "bash:io", rm: "bash:io", chmod: "bash:io", chown: "bash:io", open: "bash:io",
  },
}, system, memory);
const mcp = new McpClient(loadMcpServers());
const statuses = new Map<string, AgentStatus>();
{
  // 状态变化实时推给面板（侧栏「正在处理」提示）
  const rawSet = statuses.set.bind(statuses);
  statuses.set = (k, v) => {
    rawSet(k, v);
    try {
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("status:changed", v);
    } catch {
      // 启动早期 mainWin 尚未声明
    }
    return statuses;
  };
}
/** 回复结束后：有未答 UI 卡 → waiting；否则 idle（对齐 Grok presence） */
function settleBotStatus(botId: string, content?: import("../core/types").ContentBlock[], sessionId?: string) {
  const pending = (content ?? []).some((b) =>
    (b.type === "choice" && !b.answer) || (b.type === "form" && !b.answer) || (b.type === "secret" && !b.saved),
  );
  if (pending) {
    statuses.set(botId, { botId, state: "waiting", lastRunAt: Date.now(), currentTask: "等待你确认", sessionId });
  } else {
    statuses.set(botId, { botId, state: "idle", lastRunAt: Date.now() });
  }
}
/** 进行中的回复：sessionId → 中止控制器（停止生成） */
const inflight = new Map<string, AbortController>();
const keyCipher = {
  encrypt: (v: string) => (safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(v).toString("base64")}` : `b64:${Buffer.from(v).toString("base64")}`),
  decrypt: (c: string) => (c.startsWith("enc:") ? safeStorage.decryptString(Buffer.from(c.slice(4), "base64")) : Buffer.from(c.slice(4), "base64").toString("utf8")),
};
const secrets = new SecretStore(home, keyCipher);
/** 配置里存的 key：加密的解开，旧版明文原样返回 */
function openStoredKey(v: unknown): string {
  const s = typeof v === "string" ? v : "";
  if (!/^(enc|b64):/.test(s)) return s;
  try { return keyCipher.decrypt(s); } catch { return ""; }
}
/** 旧版明文存的接口 key（图片生成、语音识别）改成加密存储 */
function encryptLegacyConfigKeys() {
  const all = store.readConfig();
  const changed: string[] = [];
  for (const [section, label] of [["imageGen", "图片生成"], ["asr", "语音识别"], ["tts", "语音合成"]] as const) {
    const v = all[section] as Record<string, unknown> | undefined;
    if (v && typeof v.apiKey === "string" && v.apiKey && !/^(enc|b64):/.test(v.apiKey)) {
      all[section] = { ...v, apiKey: keyCipher.encrypt(v.apiKey) };
      changed.push(label);
    }
  }
  if (changed.length) {
    store.writeConfig(all);
    console.log(`[harness] ${changed.join("、")}接口的 key 已改为加密存储`);
  }
}
const env = new EnvStore(home);
const contacts = new ContactStore(home);
const connectors = new ConnectorStore(home);
const vault = new Vault({
  secrets,
  env,
  contacts,
  connectors,
  mcp: () => mcpManage.list(),
  cli: () => [
    { id: "bash", name: "本机 Shell（bash.run）", ready: true, detail: "经授权后执行" },
    { id: "fs", name: "工作区文件（fs.*）", ready: true, detail: "读写 bot 工作目录" },
    { id: "computer-use", name: "电脑操控 MCP", ready: !!mcpManage.list().find((s) => s.id === "computer" && !s.error), detail: "看屏 / 点击（设置 → MCP）" },
  ],
});
mcp.setSecretFiller((m) => {
  const r = secrets.fill(m);
  if (r.missing.length) console.warn(`[mcp] 未找到密钥：${r.missing.join("、")}`);
  return r.args as Record<string, string>;
});
void mcp.init();
const usage = createUsageBook(join(home, "usage.json"), (id) => providers.get(id)?.name);
const semantic = createSemanticRecall({
  home, store, memory, cipher: keyCipher,
  groupsOf: (botId) => groups.list(botId).map((g) => g.id),
  log: (msg) => logger.write("info", "[recall]", msg),
});
function mcpIdFromName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `mcp-${Date.now().toString(36)}`;
}
function mcpFingerprint(servers: Array<{ id: string; command?: string; args?: string[]; url?: string }>): string {
  return servers
    .map((s) => `${s.id}\t${s.url ?? ""}\t${s.command ?? ""}\t${(s.args ?? []).join("\0")}`)
    .sort()
    .join("\n");
}
const mcpManage = {
  list: () => mcp.status(),
  /** 磁盘 config 被外部改过时（shell 手改 config.json），补一次热重连，不必重启软件 */
  resync: async () => {
    const disk = loadMcpServers();
    if (mcpFingerprint(disk) === mcpFingerprint(mcp.status())) return { reloaded: false, count: disk.length };
    await mcp.reload(disk);
    return { reloaded: true, count: disk.length };
  },
  add: async (input: { id?: string; name: string; command?: string; args?: string[]; url?: string; env?: Record<string, string> }) => {
    const id = (input.id?.trim() || mcpIdFromName(input.name)).slice(0, 40);
    if (isBuiltinMcpId(id)) return { id, name: input.name, tools: 0, error: "「电脑操控」是内置能力，不用再 mcp.add" };
    const next: McpServerConfig = {
      id, name: input.name.trim(),
      ...(input.url ? { url: input.url } : { command: input.command, args: input.args ?? [] }),
      ...(input.env && Object.keys(input.env).length ? { env: input.env } : {}),
    };
    const cur = allMcpServers();
    const servers = ensureBuiltinMcpServers([...cur.filter((s) => s.id !== id), next], home);
    store.writeConfig({ ...store.readConfig(), mcpServers: servers });
    await mcp.reload(mcpServersForClient(servers, home));
    const st = mcp.status().find((s) => s.id === id)!;
    return { id: st.id, name: st.name, tools: st.tools, error: st.error };
  },
  remove: async (idOrName: string) => {
    const cur = allMcpServers();
    const hit = cur.find((s) => s.id === idOrName || s.name === idOrName)
      ?? cur.find((s) => s.name.includes(idOrName) || s.id.includes(idOrName));
    if (!hit) return { error: `找不到 MCP「${idOrName}」。现有：${cur.map((s) => s.name).join("、") || "无"}` };
    if (hit.builtin || isBuiltinMcpId(hit.id)) return { error: `「${hit.name}」是软件内置能力，请用设置里的开关关闭` };
    const servers = ensureBuiltinMcpServers(cur.filter((s) => s.id !== hit.id), home);
    store.writeConfig({ ...store.readConfig(), mcpServers: servers });
    await mcp.reload(mcpServersForClient(servers, home));
    return { removed: hit.name };
  },
};

const petHost: PetHost = {
    show: (botId) => {
      if (EVAL_MODE) return;
      const b = store.getBot(botId);
      if (b && !b.petEnabled) store.saveBot({ ...b, petEnabled: true });
      showPetWindow(botId);
    },
    hide: (botId) => { hidePetWindow(botId); },
    skinLabel: (botId) => {
      const b = store.getBot(botId);
      if (!b) return "默认";
      return petSkins.get(b.skinId)?.name || b.skinId || "默认";
    },
    isShown: (botId) => isPetShown(botId),
    xp: (botId) => store.listPets().find((p) => p.botId === botId)?.xp ?? 0,
    listSkins: () => petSkins.list().map((s) => ({ id: s.id, name: s.name })),
    setSkin: (botId, skinId) => {
      try {
        const next = applyBotSkin(botId, skinId);
        const label = petSkins.get(next.skinId)?.name || next.skinId || skinId;
        return { ok: true as const, label };
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
      }
    },
    searchCatalog: async (query) => {
      const q = (query || "").trim();
      if (!q) {
        return RECOMMENDED_PETDEX.slice(0, 12).map((r) => ({
          slug: r.slug, name: r.name, id: petdexSkinId(r.slug),
          installed: !!petSkins.list().find((s) => s.id === petdexSkinId(r.slug)),
        }));
      }
      const pets = await fetchPetdexManifest(join(assetsDir, "skins"));
      return searchPetdex(pets, q, 15).map((p) => ({
        slug: p.slug,
        name: RECOMMENDED_PETDEX.find((r) => r.slug === p.slug)?.name || p.displayName,
        id: petdexSkinId(p.slug),
        installed: !!petSkins.list().find((s) => s.id === petdexSkinId(p.slug)),
      }));
    },
    installCatalog: async (slug, opts) => {
      try {
        const pets = await fetchPetdexManifest(join(assetsDir, "skins"));
        let entry = pets.find((p) => p.slug === slug);
        if (!entry) {
          const hit = searchPetdex(pets, slug, 1)[0];
          entry = hit;
        }
        if (!entry) {
          const rec = RECOMMENDED_PETDEX.find((r) => r.slug === slug || r.name === slug || r.name.includes(slug));
          if (rec) entry = pets.find((p) => p.slug === rec.slug);
        }
        if (!entry) return { ok: false as const, error: `petdex 上找不到「${slug}」（需能访问 petdex.dev）` };
        const id = petdexSkinId(entry.slug);
        const label = opts?.name || RECOMMENDED_PETDEX.find((r) => r.slug === entry!.slug)?.name || entry.displayName;
        if (!petSkins.list().find((s) => s.id === id)) {
          const skin = await installPetdex(entry, assetsDir, label);
          petSkins.register(skin);
        }
        let worn = false;
        if (opts?.wearBotId) {
          applyBotSkin(opts.wearBotId, id, label);
          worn = true;
        }
        if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("app:changed", "skins");
        for (const w of petWins.values()) if (!w.isDestroyed()) w.webContents.send("app:changed", "skins");
        return { ok: true as const, id, label, worn };
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
      }
    },
    maySpawn: () => readPetPrefs().agentMaySpawn,
    mayVisit: () => readPetPrefs().petVisit,
    act: (botId, action, holdSec) => {
      const allowed = new Set(["idle", "walk", "jump", "sleep", "celebrate", "work", "think"]);
      const a = String(action || "").toLowerCase();
      if (!allowed.has(a)) return { ok: false as const, error: `动作仅支持 ${[...allowed].join("/")}` };
      const bot = store.getBot(botId);
      if (!bot) return { ok: false as const, error: "bot 不存在" };
      const plan = resolveMotion(a as PetActName, { holdSec, traits: { blob: traitsBlob(bot) } });
      pushPetEvent(botId, { type: "action", action: plan.action, hold: plan.holdSec, motion: plan });
      return { ok: true as const, action: plan.action };
    },
    mind: (botId) => {
      const mind = loadPetMindFor(botId);
      if (!mind) return { ok: false as const, error: "bot 不存在" };
      return { ok: true as const, mind, prompt: formatMindForPrompt(mind) };
    },
    activity: (botId, limit) => listPetActivity(home, { botId: botId || undefined, limit: limit ?? 20 }),
    playScript: (botId, beats) => {
      if (!store.getBot(botId)) return { ok: false as const, error: "bot 不存在" };
      if (!Array.isArray(beats) || !beats.length) return { ok: false as const, error: "beats 为空" };
      schedulePetScript(botId, beats as PetBeat[]);
      return { ok: true as const, ms: estimateScriptMs(beats as PetBeat[]) };
    },
    say: (botId, text, opts) => {
      if (!store.getBot(botId)) return { ok: false as const, error: "bot 不存在" };
      const t = String(text || "").trim();
      if (!t) return { ok: false as const, error: "要说的话不能为空" };
      pushPetEvent(botId, {
        type: "say",
        text: t.slice(0, 200),
        title: opts?.title || store.getBot(botId)?.name,
        action: opts?.action,
        hold: opts?.holdSec,
      });
      return { ok: true as const };
    },
    fx: async (botId, args) => {
      if (!store.getBot(botId)) return { ok: false as const, error: "bot 不存在" };
      const action = (args.action || "play").toLowerCase();
      if (action === "list") {
        const list = petEffects.list().map((e) => ({
          id: e.id, name: e.name, kind: e.kind, sticky: e.sticky, useCount: e.useCount,
        }));
        return {
          ok: true as const,
          message: `共 ${list.length} 个特效（自定义会过期回收，钉住除外）`,
          list,
        };
      }
      if (action === "gc") {
        const { removed } = petEffects.gc(false);
        return { ok: true as const, message: removed.length ? `已回收：${removed.join("、")}` : "没有需要回收的特效" };
      }
      if (action === "pin" || action === "unpin") {
        const key = args.name || args.phrase || "";
        if (!key) return { ok: false as const, error: "pin/unpin 需要 name" };
        const e = petEffects.pin(key, action === "pin");
        if (!e) return { ok: false as const, error: `找不到自定义特效「${key}」（内置无需钉住）` };
        return { ok: true as const, message: action === "pin" ? `已钉住「${e.name}」，不会自动回收` : `已取消钉住「${e.name}」`, effect: { id: e.id, name: e.name, kind: e.kind } };
      }
      if (action === "forget" || action === "delete") {
        const key = args.name || args.phrase || "";
        if (!key) return { ok: false as const, error: "forget 需要 name" };
        if (!petEffects.remove(key)) return { ok: false as const, error: `删不了「${key}」（内置或未找到）` };
        return { ok: true as const, message: `已忘掉自定义特效「${key}」` };
      }
      // play：有相近则复用并告知；否则模型现场发明；失败才规则兜底。
      // 用户只说「发明特效」没起名时，自动取一个有画面感的即兴名，避免空参失败。
      const IMPROV = ["星屑雨", "即兴光晕", "彩纸风暴", "涟漪脉冲", "萤火旋涡", "虹彩冲击", "泡泡烟花"];
      const given = (args.phrase || args.name || "").trim();
      const phrase = given || IMPROV[Math.floor(Math.random() * IMPROV.length)]!;
      const { effect, mode, message } = await resolveAndPlayFx(botId, phrase);
      const improvised = !given ? `（你没起名，我用了「${phrase}」）` : "";
      return {
        ok: true as const,
        message: `${message}${improvised}`,
        effect: { id: effect.id, name: effect.name, kind: effect.kind, created: mode === "invent" || mode === "fallback" },
      };
    },
    visit: async (fromId, toId) => {
      if (!readPetPrefs().petVisit) return { ok: false as const, error: "用户已关闭「多宠互访」" };
      const rec = await runPetVisit(fromId, toId, true);
      if (!rec) return { ok: false as const, error: "现在去不了（对方未出台或太频繁）" };
      return { ok: true as const, line: rec.lineFrom };
    },
    visitHistory: (botId, limit = 20) =>
      petVisit.list(botId, limit).map((v) => ({
        fromId: v.fromId, toId: v.toId, fromName: v.fromName, toName: v.toName,
        lineFrom: v.lineFrom, lineTo: v.lineTo, at: v.at,
      })),
    revertSkin: (botId) => {
      const b = store.getBot(botId);
      if (!b?.prevSkinId) return { ok: false as const, error: "没有可恢复的上一套形象" };
      const next = applyBotSkin(botId, b.prevSkinId);
      const label = petSkins.get(next.skinId)?.name || next.skinId || "上一套";
      return { ok: true as const, label };
    },
    generatePersona: async (botId, desc, style) => {
      const b = store.getBot(botId);
      if (!b) return { ok: false as const, error: "bot 不存在" };
      try {
        const result = await resolveAppearance(botId, desc, style as "default" | "pixel" | "cute" | undefined);
        return {
          ok: true as const,
          name: result.card?.name || b.name,
          message: result.message,
          imaged: result.imaged,
          codeDrawn: result.codeDrawn,
          skin: result.appliedSkin?.name,
          suggestions: result.suggestions.slice(0, 5).map((s) => ({ kind: s.kind, id: s.id, name: s.name })),
        };
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
      }
    },
    disable: (botId) => {
      const b = store.getBot(botId);
      if (!b) return;
      store.saveBot({ ...b, petEnabled: false });
      const w = petWins.get(botId);
      if (w && !w.isDestroyed()) w.close();
      petWins.delete(botId);
      persistPetVisible(botId, false);
      updateTrayIcon();
    },
    prefs: (botId) => {
      const p = readPetPrefs(botId);
      return {
        companionChat: p.companionChat, proactiveFollowup: p.proactiveFollowup,
        idleWork: p.idleWork, autoAppearance: p.autoAppearance,
        agentMaySpawn: p.agentMaySpawn, selfEvolve: p.selfEvolve,
        autoEvolve: p.autoEvolve, petVisit: p.petVisit,
        idleMinutes: p.idleMinutes, maxChatPerDay: p.maxChatPerDay,
        maxWorkPerDay: p.maxWorkPerDay, maxAppearPerWeek: p.maxAppearPerWeek,
      };
    },
    setPrefs: (botId, patch) => {
      const all = store.readConfig();
      const prev = (all.prefs as Record<string, unknown> | undefined) || {};
      const next = patchPetBotPrefs(prev, botId, patch as Partial<PetPrefs>);
      store.writeConfig({ ...all, prefs: next });
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("app:changed", "pet-prefs");
      const w = petWins.get(botId);
      if (w && !w.isDestroyed()) w.webContents.send("app:changed", "pet-prefs");
      return readPetPrefs(botId) as unknown as Record<string, unknown>;
    },
    evolveList: (botId, mode) => {
      const rows = mode === "pending" ? petEvolve.listPending(botId) : petEvolve.listHistory(botId);
      return rows.map((p) => ({
        id: p.id, title: p.title, detail: p.detail, status: p.status, kind: p.kind, createdAt: p.createdAt,
      }));
    },
    evolveDecide: (botId, action, id) => {
      if (id && !petEvolve.listPending(botId).some((x) => x.id === id)) {
        return { ok: false as const, error: "没有这条待确认提议（或已处理）" };
      }
      const p = id
        ? (action === "accept" ? petEvolve.accept(id) : petEvolve.reject(id))
        : (action === "accept" ? petEvolve.acceptLatest(botId) : petEvolve.rejectLatest(botId));
      if (!p) return { ok: false as const, error: "没有待确认的进化提议" };
      return { ok: true as const, title: p.title, status: p.status };
    },
    remind: (botId, delayMs, text) => {
      if (!store.getBot(botId)) return { ok: false as const, error: "bot 不存在" };
      const at = Date.now() + Math.max(5_000, delayMs);
      scheduler.create({
        botId,
        name: text.slice(0, 40) || "提醒",
        cron: "0 0 1 1 *",
        kind: "once",
        alarmAt: at,
        notifyPet: true,
        runPrompt: false,
        deleteAfterRun: true,
        prompt: text,
      });
      return { ok: true as const, at };
    },
  };

const demoSkills = new DemoSkillEngine();
const runtime: BotRuntime = new BotRuntime({
  store, providers, memory, skills, system, systemAccess, executor, offline: new OfflinePersona(), mcp, mcpManage, askBot, tasks: scheduler, notifyCheck,
  groups, secrets, env, workspaceRoot: workspace, harnessHome: home, demo: demoSkills, vault, connectors, codingThreads, codingPresence,
  groupPost: async (from, name, message, signal) => {
    const all = groups.list();
    const g = all.find((x) => x.name === name) ?? all.find((x) => x.name.includes(name) || name.includes(x.name));
    if (!g) return { ok: false, error: `没有叫「${name}」的群聊。现有群聊：${all.map((x) => x.name).join("、") || "无"}` };
    if (!g.members.includes(from.id)) return { ok: false, error: `你不在群聊「${g.name}」里，发不进去。你所在的群：${groups.list(from.id).map((x) => x.name).join("、") || "无"}` };
    const sid = pickGroupSession(g.id, {
      gazed: groupGaze.get(g.id),
      live: groupSessions.liveSession(g.id),
      sessions: store.listSessions().map((s) => ({ id: s.id, updatedAt: s.updatedAt })),
    });
    if (groupSessions.isLive(sid)) {
      const joined = await groupSessions.speakInto(g.id, from, message, sid);
      if (!joined.ok) return { ok: false, error: `群聊「${g.name}」这轮接力刚刚结束` };
      return { ok: true, group: g.name, replies: [], reason: "插进正在进行的接力", joined: true };
    }
    const ctrl = new AbortController();
    signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
    inflight.set(sid, ctrl);
    try {
      const r = await groupSessions.post(g.id, from, message, groupHooks(sid, ctrl));
      return { ok: true, group: r.groupName, replies: r.replies, reason: r.reasonText, joined: r.joined };
    } finally {
      if (inflight.get(sid) === ctrl) inflight.delete(sid);
    }
  },
  appFacts: () => ({ projects: projects.list().map((x) => ({ name: x.name })) }), consent, audit,
  imageConfig: () => {
    const c = store.readConfig().imageGen as ImageGenConfig | undefined;
    if (!c?.baseUrl || !c.model) return null;
    return { ...c, apiKey: openStoredKey(c.apiKey) };
  },
  onAppChanged: (what) => {
    if (what === "bots") registerAll();
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("app:changed", what);
  },
  onBotCreated: ({ botId, sessionId }) => {
    registerAll();
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send("app:changed", "bots");
      mainWin.webContents.send("bot:created", { botId, sessionId });
    }
  },
  onUsage: (u) => usage.record(u),
  recall: (bot, query, excludeSession) => semantic.recall(bot, query, excludeSession),
});

// 桌宠 = 娱乐侧车：不进入 Bot 完整设计；未挂载则无 pet.* 工具与桌宠提示词
attachPetEntertainment(runtime, {
  store,
  host: petHost,
  onAppChanged: (what) => {
    if (what === "bots") registerAll();
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("app:changed", what);
  },
});


ipcMain.handle("usage:summary", () => usage.summary());
ipcMain.handle("embedding:get", () => semantic.getConfig());
ipcMain.handle("embedding:set", (_e, value: EmbeddingConfig) => semantic.setConfig(value));
ipcMain.handle("embedding:status", () => semantic.status());

const projects = new ProjectRegistry(home);
migration.attachExtras({ env, secrets, projects, consent });
const groupGaze = new Map<string, string>();
function forgetGaze(sessionId: string) {
  for (const [gid, sid] of groupGaze) if (sid === sessionId) groupGaze.delete(gid);
}
const groupSessions: GroupSessionRunner = new GroupSessionRunner({ store, groups, runtime, providers });
/** 全局自定义指令 + 会话所属项目的指令和资料 */
function instructionsFor(sessionId?: string, projectId?: string | null): string {
  const pid = projectId !== undefined ? projectId : sessionId ? store.getSession(sessionId)?.projectId : null;
  return instructionsPrompt(store.readConfig().instructions as GlobalInstructions | undefined, projects.get(pid));
}

/** 群聊 IPC → core GroupSessionRunner 的宿主桥接（UI / 状态 / 中止） */
function groupHooks(sessionId: string, ctrl: AbortController): GroupSessionHooks {
  return {
    onProgress: (p: GroupProgress) => sendUi("group:progress", p),
    onStream: (ev) => sendUi("chat:stream", { ...ev.block, sessionId: ev.sessionId, botId: ev.botId, turn: ev.turn }),
    setRunning: (botId, sid, task) => {
      statuses.set(botId, { botId, state: "running", lastRunAt: Date.now(), currentTask: task, sessionId: sid });
      activeSession.set(botId, sid);
    },
    setIdle: (botId) => {
      activeSession.delete(botId);
      statuses.set(botId, { botId, state: "idle", lastRunAt: Date.now() });
    },
    extraSystem: instructionsFor(sessionId),
    signal: ctrl.signal,
  };
}

/** 这个 bot 当前在哪个会话里干活（授权卡片显示到那个会话） */
const activeSession = new Map<string, string>();
const pendingConsent = new Map<string, (d: ConsentDecision) => void>();
/** 单聊的用户消息在回复结束时才落盘：期间的授权记录先攒着，回复写完再补上，保证顺序 */
const consentNotes = new Map<string, string[]>();
/** shell 解析不出命令名时 head 记为 "$()"，不能原文展示给用户 */
const opaqueConsentCmd = (cmd?: string) => {
  const c = String(cmd ?? "").trim();
  return !c || c === "$()";
};
/** 授权结果条里写什么动作：优先可读命令名，其次 description 里的原文，最后能力名 */
const consentActionLabel = (req: { command?: string; description?: string }, capLabel: string) => {
  if (!opaqueConsentCmd(req.command)) return `执行 ${String(req.command).trim()}`;
  const desc = String(req.description ?? "").replace(/^执行命令:\s*/i, "").trim().replace(/\s+/g, " ");
  if (desc) return `执行 ${desc.length > 100 ? `${desc.slice(0, 100)}…` : desc}`;
  return `使用「${capLabel}」`;
};
const pushConsentNote = (sid: string, note: string) => {
  const held = consentNotes.get(sid);
  if (held) {
    if (held.at(-1) !== note) held.push(note);
    return;
  }
  const last = store.listMessages(sid).at(-1);
  if (last?.kind === "event" && last.content === note) return;
  store.addMessage({ sessionId: sid, from: "system", to: "user", role: "assistant", content: note, kind: "event", createdAt: Date.now() });
};
const flushConsentNotes = (sid: string) => {
  const notes = consentNotes.get(sid) ?? [];
  consentNotes.delete(sid);
  const uniq: string[] = [];
  for (const n of notes) if (uniq.at(-1) !== n) uniq.push(n);
  let last = store.listMessages(sid).at(-1);
  for (const content of uniq) {
    if (last?.kind === "event" && last.content === content) continue;
    last = store.addMessage({ sessionId: sid, from: "system", to: "user", role: "assistant", content, kind: "event", createdAt: Date.now() });
  }
};
const sendUi = (channel: string, payload: unknown) => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload); };
ipcMain.handle("consent:respond", (_e, id: string, decision: ConsentDecision) => { pendingConsent.get(id)?.(decision); });

/** bot 间会话：同一对 bot 固定复用一个会话，被问方能接着之前的问答 */
const isB2bSession = (sid: string) => sid.startsWith("b2b-");
/** 同一 b2b 会话串行：并行 handleStream 会抢同一 live 草稿，正文拼成两遍、偶发整轮失败 */
const b2bChain = new Map<string, Promise<unknown>>();

async function askBot(from: Bot, target: string, message: string, depth: number, parentSessionId?: string, signal?: AbortSignal): Promise<string> {
  const all = store.listBots().filter((b) => b.id !== from.id);
  const to = all.find((b) => b.name === target) ?? all.find((b) => b.name.includes(target) || target.includes(b.name));
  if (!to) return `找不到名为「${target}」的 bot。现有成员：${all.map((b) => b.name).join("、")}`;
  const sid = `b2b-${from.id}-${to.id}`;
  const prev = b2bChain.get(sid) ?? Promise.resolve();
  const job = (async () => {
    await prev.catch(() => {});
    statuses.set(to.id, { botId: to.id, state: "running", lastRunAt: Date.now(), currentTask: `${from.name} 的提问` });
    const parentActive = parentSessionId ?? activeSession.get(from.id);
    if (parentActive) activeSession.set(to.id, parentActive);
    try {
      const r = await runtime.handleStream(
        { bot: to, from: from.id, text: message, sessionId: sid, history: store.listMessages(sid).slice(-200) },
        {
          depth,
          extraSystem: instructionsFor(parentActive),
          signal: signal ?? (parentSessionId ? inflight.get(parentSessionId)?.signal : undefined),
          onBlock: (block) => {
            if (parentSessionId && mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("chat:b2b", { parentSessionId, botId: to.id, block });
          },
        },
      );
      pushPetEvent(to.id, { type: "reply", text: r.text.slice(0, 120) });
      return `${to.name} 回复：${r.text}`;
    } finally {
      if (parentActive && activeSession.get(to.id) === parentActive) activeSession.delete(to.id);
      statuses.set(to.id, { botId: to.id, state: "idle", lastRunAt: Date.now() });
    }
  })();
  b2bChain.set(sid, job.then(() => {}, () => {}));
  return job;
}

/** 冷启动：用最近一次用户消息时间；没有则视为「刚活跃」，避免 idle 闸门 fail-open */
function seedLastUserAt(): number {
  let latest = 0;
  for (const s of store.listSessions()) {
    for (const m of store.listMessages(s.id)) {
      if (m.role === "user" && m.from === "user" && m.createdAt > latest) latest = m.createdAt;
    }
  }
  return latest || Date.now();
}
let lastUserAt = seedLastUserAt();
function touchUserActivity() { lastUserAt = Date.now(); }
function readPetPrefs(botId?: string): PetPrefs {
  return resolvePetPrefs(store.readConfig() as Record<string, unknown>, botId);
}

/** 窗口当前是否在桌面可见（藏起来 ≠ 关宠） */
function isPetShown(botId: string): boolean {
  const w = petWins.get(botId);
  return !!(w && !w.isDestroyed() && w.isVisible());
}

/** 持久化 PetState.visible，并与窗口 show/hide 对齐 */
function persistPetVisible(botId: string, visible: boolean, pos?: { x: number; y: number; displayId?: number }) {
  const cur = store.listPets().find((p) => p.botId === botId) || { botId, x: 0, y: 0, visible: true };
  store.savePet({
    ...cur,
    visible,
    ...(pos ? { x: pos.x, y: pos.y, displayId: pos.displayId ?? cur.displayId } : {}),
  });
}

function hidePetWindow(botId?: string) {
  const ids = botId ? [botId] : [...petWins.keys()];
  for (const id of ids) {
    const w = petWins.get(id);
    if (w && !w.isDestroyed()) {
      w.hide();
      const [x, y] = w.getPosition();
      persistPetVisible(id, false, { x, y, displayId: screen.getDisplayNearestPoint({ x, y }).id });
    } else {
      persistPetVisible(id, false);
    }
  }
}

function showPetWindow(botId?: string) {
  const targets = botId
    ? [botId].filter((id) => store.getBot(id)?.petEnabled)
    : store.listBots().filter((b) => b.petEnabled).map((b) => b.id);
  for (const id of targets) {
    createPetWindow(id, { forceShow: true });
    persistPetVisible(id, true);
  }
  updateTrayIcon();
}

function applyBotSkin(botId: string, skinId: string, label?: string) {
  const bot = store.getBot(botId);
  if (!bot) throw new Error("bot 不存在");
  const prev = bot.skinId;
  const next = { ...bot, skinId, prevSkinId: prev && prev !== skinId ? prev : bot.prevSkinId };
  store.saveBot(next);
  pushPetEvent(botId, { type: "skin-updated", text: `皮肤已切换为「${label || skinId}」` });
  updateTrayIcon();
  return next;
}
const proactive = new ProactiveEngine(home, {
  collect: () => collectSignals({
    sessions: store.listSessions(),
    messages: (sid) => store.listMessages(sid),
    tasks: scheduler.list(),
    masterId: store.listBots().find((b) => b.isMaster)?.id,
    nameOf: (id) => store.getBot(id)?.name ?? id,
    now: Date.now(),
  }),
  lastUserActivity: () => lastUserAt,
  idleMs: () => readPetPrefs().idleMinutes * 60_000,
  phrase: async (sig) => {
    const bot = store.getBot(sig.botId);
    const provider = (bot && providers.get(bot.providerId)) || providers.getDefault();
    if (!bot || !provider || statuses.get(bot.id)?.state === "running") return null;
    const r = await providers.complete(provider, {
      model: providers.get(bot.providerId) ? bot.model : undefined,
      system: `${bot.systemPrompt || `你是 ${bot.name}（${bot.role}）`}\n\n现在由你主动跟用户跟进一件没完成的事。用一两句口语说清是哪件事，再给一个具体的下一步提议（比如「要我重跑一遍吗？」「选好了告诉我，我接着做」）。不寒暄、不道歉、不编造事实，不超过 80 字。`,
      user: `事情：${sig.fact}`,
      signal: AbortSignal.timeout(30_000),
    });
    return r.text.replace(/```[\s\S]*?```/g, "").trim();
  },
  deliver: (sig, text) => {
    const bot = store.getBot(sig.botId);
    // 跟进只服务已上台桌宠；气泡仅对当前可见窗
    if (!bot?.petEnabled) return;
    if (!readPetPrefs(sig.botId).proactiveFollowup) return;
    const sid = sig.sessionId ?? store.listSessions(sig.botId).filter((s) => /^s-/.test(s.id)).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id;
    if (!sid) return;
    store.addMessage({ sessionId: sid, from: sig.botId, to: "user", role: "assistant", content: [{ type: "text", text }], kind: "chat", createdAt: Date.now(), meta: { proactive: true } });
    if (isPetShown(sig.botId)) pushPetEvent(sig.botId, { type: "proactive", title: "跟进", text, sessionId: sid });
    void deliverNotification({
      title: `${bot.name} · 跟进`,
      body: text.slice(0, 120),
      sessionId: sid,
      onClick: () => focusMainPanel(sid),
    });
    console.log(`[proactive] ${sig.kind} → ${bot.name}：${text.slice(0, 60)}`);
  },
});
const companion = new CompanionEngine(home, {
  bots: () => store.listBots(),
  memory: (id) => memory.list(id),
  lastUserActivity: () => lastUserAt,
  isBusy: (id) => statuses.get(id)?.state === "running",
  prefs: (botId) => {
    const p = readPetPrefs(botId);
    return {
      companionChat: p.companionChat,
      idleWork: p.idleWork,
      autoAppearance: p.autoAppearance,
      idleMs: p.idleMinutes * 60_000,
      maxChatPerDay: p.maxChatPerDay,
      maxWorkPerDay: p.maxWorkPerDay,
      maxAppearPerWeek: p.maxAppearPerWeek,
    };
  },
  isShown: (id) => isPetShown(id),
  work: async (bot) => {
    if (statuses.get(bot.id)?.state === "running") return null;
    const sid = `s-pet-idle-${bot.id}`;
    const signals = collectSignals({
      sessions: store.listSessions(bot.id),
      messages: (id) => store.listMessages(id),
      tasks: scheduler.list().filter((t) => t.botId === bot.id),
      masterId: bot.id,
      nameOf: (id) => store.getBot(id)?.name ?? id,
      now: Date.now(),
    }).slice(0, 5);
    const fact = signals.map((s) => s.fact).join("；") || "最近没有明显未完成事项";
    const mind = loadPetMindFor(bot.id);
    statuses.set(bot.id, { botId: bot.id, state: "running", lastRunAt: Date.now(), currentTask: "空闲小事" });
    try {
      const provider = providers.get(bot.providerId) || providers.getDefault();
      let text = "";
      let via: "model" | "rule" = "rule";
      if (provider) {
        const r = await providers.complete(provider, {
          model: providers.get(bot.providerId) ? bot.model : undefined,
          system: `${bot.systemPrompt || `你是 ${bot.name}`}\n你是桌宠，空闲时做一件只读观察并汇报。禁止假装已执行操作/改文件。要具体、有用，引用心智里的记忆或信号，不超过 80 字。`,
          user: `${mind ? formatMindForPrompt(mind) + "\n\n" : ""}未完成信号：${fact}\n给一句真正有用的观察或下一步提议。`,
          signal: AbortSignal.timeout(30_000),
        });
        text = (r.text || "").replace(/```[\s\S]*?```/g, "").replace(/\s+/g, " ").trim().slice(0, 160);
        if (text) via = "model";
      }
      if (!text && signals[0]?.fact) {
        text = `对了，还有件事：${signals[0].fact.slice(0, 60)}…需要的话叫我。`;
      }
      if (!text) {
        notePetDecision(home, { botId: bot.id, kind: "idleWork", via: "system", note: "无信号可汇报", blocked: true });
        return null;
      }
      store.addMessage({
        sessionId: sid, from: bot.id, to: "user", role: "assistant",
        content: [{ type: "text", text }], kind: "chat", createdAt: Date.now(),
        meta: { petIdleWork: true, via },
      });
      notePetDecision(home, { botId: bot.id, kind: "idleWork", via, note: text.slice(0, 80) });
      return { text, title: "空闲小事" };
    } catch (e) {
      console.error("[companion.work]", e);
      notePetDecision(home, { botId: bot.id, kind: "idleWork", via: "system", note: String(e).slice(0, 80), blocked: true });
      return null;
    } finally {
      statuses.set(bot.id, { botId: bot.id, state: "idle", lastRunAt: Date.now() });
    }
  },
  appear: async (bot) => {
    if (statuses.get(bot.id)?.state === "running") return null;
    statuses.set(bot.id, { botId: bot.id, state: "running", lastRunAt: Date.now(), currentTask: "自动换装" });
    try {
      const msgs = store.listSessions(bot.id)
        .filter((s) => /^s-/.test(s.id))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 2)
        .flatMap((s) => store.listMessages(s.id).filter((m) => m.role === "user").slice(-2));
      const hint = msgs.map((m) => contentText(m.content)).join(" ").replace(/\s+/g, " ").slice(0, 120);
      const pets = await fetchPetdexManifest(join(assetsDir, "skins"));
      const local = petSkins.list().filter((s) => s.id !== bot.skinId).slice(0, 12)
        .map((s) => ({ slug: s.id, name: s.name, installed: true }));
      const searched = searchPetdex(pets, hint.slice(0, 24) || bot.role || "cute", 8)
        .map((p) => ({
          slug: p.slug,
          name: RECOMMENDED_PETDEX.find((r) => r.slug === p.slug)?.name || p.displayName,
          installed: !!petSkins.list().find((s) => s.id === petdexSkinId(p.slug)),
        }));
      const candidates = [...local, ...searched].filter((c, i, arr) => arr.findIndex((x) => x.slug === c.slug) === i).slice(0, 16);
      if (!candidates.length) return null;

      let pick = candidates[0];
      let reason = "";
      let via: "model" | "rule" = "rule";
      const mind = loadPetMindFor(bot.id);
      const provider = providers.get(bot.providerId) || providers.getDefault();
      if (provider) {
        try {
          const r = await providers.complete(provider, {
            model: providers.get(bot.providerId) ? bot.model : undefined,
            system: `你是桌宠 ${bot.name}。根据心智与近期话题从候选里选一个形象。只输出 JSON：{"slug":"...","name":"...","why":"≤40字"}。必须选候选里有的 slug；对不上就选最不突兀的。`,
            user: `${mind ? formatMindForPrompt(mind) + "\n\n" : ""}近期话题：${hint || "（无）"}\n候选：\n${candidates.map((c) => `- ${c.slug}｜${c.name}`).join("\n")}`,
            signal: AbortSignal.timeout(20_000),
          });
          const m = (r.text || "").match(/\{[\s\S]*\}/);
          if (m) {
            const j = JSON.parse(m[0]) as { slug?: string; name?: string; why?: string };
            const hit = candidates.find((c) => c.slug === j.slug || c.name === j.name);
            if (hit) { pick = hit; reason = String(j.why || "").trim().slice(0, 40); via = "model"; }
          }
        } catch (e) {
          console.error("[companion.appear.invent]", e);
        }
      }

      let skinId = pick.slug;
      let label = pick.name;
      if (!petSkins.get(skinId)) {
        const entry = pets.find((p) => p.slug === pick.slug) || searchPetdex(pets, pick.slug, 1)[0];
        if (!entry) {
          notePetDecision(home, { botId: bot.id, kind: "autoAppearance", via, note: "候选无法安装", blocked: true });
          return null;
        }
        skinId = petdexSkinId(entry.slug);
        label = RECOMMENDED_PETDEX.find((r) => r.slug === entry.slug)?.name || entry.displayName;
        if (!petSkins.get(skinId)) {
          const skin = await installPetdex(entry, assetsDir, label);
          petSkins.register(skin);
        }
      }
      if (bot.skinId === skinId) {
        notePetDecision(home, { botId: bot.id, kind: "autoAppearance", via, note: "已是当前皮，跳过", blocked: true });
        return null;
      }
      applyBotSkin(bot.id, skinId, label);
      const line = reason
        ? `我换上了「${label}」——${reason}。不喜欢就说「换回去」。`
        : `我换上了「${label}」。不喜欢就说「换回去」。`;
      notePetDecision(home, { botId: bot.id, kind: "autoAppearance", via, note: `→ ${label}` });
      return { text: line, title: "自动换装" };
    } catch (e) {
      console.error("[companion.appear]", e);
      return null;
    } finally {
      statuses.set(bot.id, { botId: bot.id, state: "idle", lastRunAt: Date.now() });
    }
  },
  chat: async (bot) => {
    if (statuses.get(bot.id)?.state === "running") return null;
    const provider = providers.get(bot.providerId) || providers.getDefault();
    if (!provider) return null;
    const mind = loadPetMindFor(bot.id);
    const hour = new Date().getHours();
    const slot = hour < 6 ? "深夜" : hour < 12 ? "上午" : hour < 18 ? "下午" : "晚上";
    try {
      const r = await providers.complete(provider, {
        model: providers.get(bot.providerId) ? bot.model : undefined,
        system: `${bot.systemPrompt || `你是 ${bot.name}`}\n你是桌宠，空闲时主动说一句。要像记得对方的事：优先引用心智里的记忆或最近用户话；不要命令式、不编造刚做完的事，不超过 60 字。`,
        user: `${mind ? formatMindForPrompt(mind) + "\n\n" : ""}现在是${slot}。说一句自然、有记忆感的搭话。`,
        signal: AbortSignal.timeout(20_000),
      });
      const text = (r.text || "").replace(/```[\s\S]*?```/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
      if (!text) return null;
      notePetDecision(home, { botId: bot.id, kind: "companionChat", via: "model", note: text.slice(0, 80) });
      return { text, title: "搭话" };
    } catch (e) {
      console.error("[companion.chat]", e);
      return null;
    }
  },
  deliver: (botId, line) => {
    const bot = store.getBot(botId);
    const sid = store.listSessions(botId).filter((s) => /^s-/.test(s.id)).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id
      || `s-pet-companion-${botId}`;
    try {
      store.ensureSession(sid, botId, "桌宠陪伴");
      store.addMessage({
        sessionId: sid, from: botId, to: "user", role: "assistant",
        content: [{ type: "text", text: line.text }], kind: "chat", createdAt: Date.now(),
        meta: { companion: line.kind || "chat" },
      });
    } catch (e) {
      console.error("[companion.persist]", e);
    }
    // 显著句沉淀进记忆，下次搭话/互访能引用
    const fact = extractCompanionFact(line.text);
    if (fact) {
      try {
        memory.add(botId, { kind: "fact", content: fact, source: `pet-${line.kind || "chat"}` });
      } catch { /* ignore */ }
    }
    const title = line.title || (line.kind === "work" ? "空闲小事" : line.kind === "appear" ? "自动换装" : bot?.name || "陪伴");
    const evType = line.kind === "work" ? "companion-work" : line.kind === "appear" ? "companion-appear" : "companion";
    pushPetEvent(botId, {
      type: evType,
      title,
      text: line.text,
      sessionId: sid,
      action: line.kind === "work" ? "work" : line.kind === "appear" ? "celebrate" : "think",
      hold: 3,
    });
    console.log(`[companion] ${bot?.name}：${line.text.slice(0, 60)}`);
  },
});
const petVisit = new PetVisitEngine(home, {
  bots: () => store.listBots(),
  enabled: () => readPetPrefs().petVisit,
  isShown: (id) => isPetShown(id),
  isBusy: (id) => statuses.get(id)?.state === "running",
  inventLines: async (from, to) => {
    const provider = providers.get(from.providerId) || providers.get(to.providerId) || providers.getDefault();
    if (!provider) return null;
    try {
      const fromMind = loadPetMindFor(from.id);
      const toMind = loadPetMindFor(to.id);
      const warm = fromMind?.bond.affinity[to.id] ?? 0;
      const r = await providers.complete(provider, {
        model: undefined,
        system: "两个桌宠见面打招呼。只输出 JSON：{\"from\":\"访客说的一句≤40字\",\"to\":\"主人回应≤40字\"}。要贴合人设与关系温度，口语有趣，可点到共同记忆，不要解释。",
        user: `关系温度：${warm}\n访客心智：\n${fromMind ? formatMindForPrompt(fromMind) : from.name}\n\n主人心智：\n${toMind ? formatMindForPrompt(toMind) : to.name}`,
        signal: AbortSignal.timeout(15_000),
      });
      const lines = parseVisitLines(r.text || "");
      if (lines) notePetDecision(home, { botId: from.id, kind: "visit", via: "model", note: `→ ${to.name}` });
      return lines;
    } catch (e) {
      console.error("[pet-visit.invent]", e);
      return null;
    }
  },
});
/** 叠加特效库：复用 / 模型现场发明 / 规则兜底；不改皮肤；TTL/LRU 回收 */
const petEffects = new PetEffectRegistry(home);

async function inventFxWithModel(botId: string, phrase: string): Promise<{ name: string; aliases: string[]; recipe: FxRecipe } | null> {
  const bot = store.getBot(botId);
  const provider = (bot?.providerId && providers.get(bot.providerId)) || providers.getDefault();
  if (!provider) return null;
  const model = (bot?.providerId && providers.get(bot.providerId) && bot.model) || provider.model;
  try {
    const r = await providers.complete(provider, {
      model,
      system: fxInventSystemPrompt(),
      user: fxInventUserPrompt(phrase),
      signal: AbortSignal.timeout(12_000),
    });
    const drafted = parseInventedEffect(r.text || "");
    if (drafted) return drafted;
    // 再钉一句，减少「解释一堆但不给 JSON」
    const r2 = await providers.complete(provider, {
      model,
      system: fxInventSystemPrompt(),
      user: `${fxInventUserPrompt(phrase)}\n上一次输出无效。只回一行 JSON，overlay 必须是 ${["beam", "aura", "burst", "rings", "spark", "hearts", "zzz", "sweat", "shake"].join("|")} 之一。`,
      signal: AbortSignal.timeout(10_000),
    });
    return parseInventedEffect(r2.text || "");
  } catch (e) {
    console.error("[fx.invent]", e instanceof Error ? e.message : e);
    return null;
  }
}

function fxUserMessage(mode: "reuse" | "invent" | "fallback", name: string): string {
  if (mode === "reuse") return `复用已有「${name}」——喝！`;
  if (mode === "invent") return `现场做了「${name}」并记住了（叠加层，不改形象；久不用会回收，可钉住）。`;
  // 规则配方也是正经产出，别跟用户说「模型没空」
  return `已放出「${name}」并记下了（下次可复用；可钉住防回收）。`;
}

function playPetEffect(
  botId: string,
  effect: { id: string; name: string; recipe: FxRecipe },
  mode: "reuse" | "invent" | "fallback" = "reuse",
) {
  const r = effect.recipe;
  pushPetEvent(botId, {
    type: "fx",
    title: effect.name,
    text: fxUserMessage(mode, effect.name),
    action: r.motion,
    hold: r.holdSec ?? 2,
    fx: {
      id: effect.id,
      overlay: r.overlay,
      color: r.color,
      durationMs: r.durationMs ?? 1800,
      label: r.label,
      dir: r.dir,
    },
  });
}

async function resolveAndPlayFx(botId: string, phrase: string) {
  const { effect, mode } = await petEffects.resolveSmart(phrase, (p) => inventFxWithModel(botId, p));
  playPetEffect(botId, effect, mode);
  return { effect, mode, message: fxUserMessage(mode, effect.name) };
}

/** 把已记录的互访演出来：访客走过去 → 双方庆祝对白 → 走回家 */
function stagePetVisit(
  rec: { fromId: string; toId: string; fromName: string; toName: string; lineFrom: string; lineTo: string },
  opts?: { forceShow?: boolean },
) {
  if (opts?.forceShow) {
    createPetWindow(rec.fromId, { forceShow: true });
    createPetWindow(rec.toId, { forceShow: true });
  }
  const guest = petWins.get(rec.fromId);
  const host = petWins.get(rec.toId);
  // 出门：走路
  pushPetEvent(rec.fromId, { type: "action", action: "walk", hold: 2 });
  if (guest && host && !guest.isDestroyed() && !host.isDestroyed()) {
    if (opts?.forceShow || guest.isVisible()) guest.show();
    if (opts?.forceShow || host.isVisible()) host.show();
    if (guest.isVisible() && host.isVisible()) {
      const [hx, hy] = host.getPosition();
      const [gx, gy] = guest.getPosition();
      const homePos = { x: gx, y: gy };
      // 稍晚再挪窗，让 walk 先播一点
      setTimeout(() => {
        if (guest.isDestroyed()) return;
        guest.setPosition(hx - 120, hy);
        pushPetEvent(rec.fromId, {
          type: "visit", title: `去找 ${rec.toName}`, text: rec.lineFrom,
          peerId: rec.toId, peerName: rec.toName, role: "guest", action: "celebrate", hold: 4,
        });
        pushPetEvent(rec.toId, {
          type: "visit", title: `${rec.fromName} 来串门`, text: rec.lineTo,
          peerId: rec.fromId, peerName: rec.fromName, role: "host", action: "celebrate", hold: 4,
        });
      }, 600);
      setTimeout(() => {
        if (guest.isDestroyed()) return;
        pushPetEvent(rec.fromId, { type: "action", action: "walk", hold: 2 });
        guest.setPosition(homePos.x, homePos.y);
        setTimeout(() => pushPetEvent(rec.fromId, { type: "action", action: "idle", hold: 0 }), 1800);
      }, 8_000);
      grantPetXp(rec.fromId, 3);
      grantPetXp(rec.toId, 3);
      return rec;
    }
  }
  // 窗口不可见时仍推气泡，不演位置
  pushPetEvent(rec.fromId, {
    type: "visit", title: `去找 ${rec.toName}`, text: rec.lineFrom,
    peerId: rec.toId, peerName: rec.toName, role: "guest", action: "celebrate", hold: 3,
  });
  pushPetEvent(rec.toId, {
    type: "visit", title: `${rec.fromName} 来串门`, text: rec.lineTo,
    peerId: rec.fromId, peerName: rec.fromName, role: "host", action: "celebrate", hold: 3,
  });
  grantPetXp(rec.fromId, 3);
  grantPetXp(rec.toId, 3);
  try {
    memory.add(rec.fromId, { kind: "event", content: `去找 ${rec.toName} 串门：${rec.lineFrom}`, source: "pet-visit" });
    memory.add(rec.toId, { kind: "event", content: `${rec.fromName} 来串门：${rec.lineTo}`, source: "pet-visit" });
  } catch { /* ignore */ }
  notePetDecision(home, { botId: rec.fromId, kind: "visit", via: "system", note: `串门 ${rec.toName}` });
  return rec;
}

/** 发起互访（用户/工具）；force 忽略冷却并强制亮窗；台词优先模型 */
async function runPetVisit(fromId: string, toId: string, force = false) {
  const from = store.getBot(fromId);
  const to = store.getBot(toId);
  if (!from || !to) return null;
  const rec = await petVisit.visitSmart(from, to, { force });
  if (!rec) return null;
  return stagePetVisit(rec, { forceShow: force });
}

const petEvolve = new PetEvolveEngine(home, {
  bots: () => store.listBots(),
  memory: (id) => memory.list(id),
  recentUserMessages: (botId, limit = 12) => {
    const sessions = store.listSessions(botId).filter((s) => /^s-/.test(s.id)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3);
    const out: import("../core/types").ChatMessage[] = [];
    for (const s of sessions) {
      for (const m of store.listMessages(s.id)) {
        if (m.role === "user" && m.from === "user") out.push(m);
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  },
  petXp: (botId) => store.listPets().find((p) => p.botId === botId)?.xp ?? 0,
  enabled: () => readPetPrefs().selfEvolve,
  autoApply: () => readPetPrefs().autoEvolve,
  isBusy: (id) => statuses.get(id)?.state === "running",
  invent: async (bot, ctx) => {
    const provider = providers.get(bot.providerId) || providers.getDefault();
    if (!provider) return null;
    try {
      const mind = loadPetMindFor(bot.id);
      const r = await providers.complete(provider, {
        model: providers.get(bot.providerId) ? bot.model : undefined,
        system: `你是桌宠 ${bot.name}，观察相处后提出一条自进化小提议。只输出 JSON：{"kind":"play"|"work_style"|"habit"|"skill_hint","title":"≤20字问句","detail":"≤80字说明","personaAppend":"可选","memory":{"kind":"fact"|"rule","content":"可选"}}。要具体、可拒绝，贴合心智里已有记忆，不要重复已有规矩。`,
        user: `${mind ? formatMindForPrompt(mind) + "\n\n" : ""}等级：Lv.${ctx.level}\n最近用户话：\n${ctx.messages.map((t) => `- ${t.slice(0, 60)}`).join("\n") || "（无）"}`,
        signal: AbortSignal.timeout(20_000),
      });
      return parseEvolveInvent(r.text || "");
    } catch (e) {
      console.error("[pet-evolve.invent]", e);
      return null;
    }
  },
  apply: (botId, proposal) => {
    const bot = store.getBot(botId);
    if (!bot) return;
    if (proposal.personaAppend) {
      const persona = `${bot.persona || ""}${bot.persona ? "\n" : ""}${proposal.personaAppend}`.trim();
      store.saveBot({ ...bot, persona });
    }
    if (proposal.memory) {
      memory.add(botId, { kind: proposal.memory.kind, content: proposal.memory.content, source: "pet-evolve" });
    }
    notePetDecision(home, { botId, kind: "evolveAccept", via: "user", note: proposal.title });
    pushPetEvent(botId, { type: "proactive", title: "进化生效", text: `好，我记下了：${proposal.title}` });
  },
  deliver: (botId, proposal) => {
    notePetDecision(home, { botId, kind: "evolvePropose", via: "model", note: proposal.title });
    pushPetEvent(botId, {
      type: "proactive",
      title: "进化提议",
      text: `${proposal.title}\n${proposal.detail}\n\n回「好」接受，回「不要」算了。`,
    });
  },
});

/** 聚合一只宠的心智投影（须在 companion/visit/evolve 之后定义） */
function loadPetMindFor(botId: string): PetMind | null {
  const bot = store.getBot(botId);
  if (!bot) return null;
  const sessions = store.listSessions(botId).filter((s) => /^s-/.test(s.id)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3);
  const recentUserLines: string[] = [];
  for (const s of sessions) {
    for (const m of store.listMessages(s.id).filter((x) => x.role === "user").slice(-4)) {
      const t = contentText(m.content).trim();
      if (t) recentUserLines.push(t);
    }
  }
  const q = companion.snapshotQuotas();
  const pending = petEvolve.listPending(botId)[0];
  return buildPetMind({
    bot,
    xp: store.listPets().find((p) => p.botId === botId)?.xp ?? 0,
    prefs: readPetPrefs(botId),
    memories: memory.list(botId),
    recentUserLines: recentUserLines.reverse().slice(0, 8),
    affinity: petVisit.affinityOf(botId),
    pendingEvolveTitle: pending?.title,
    companionQuotas: { dayCount: q.dayCount, workCount: q.workCount, appearCount: q.appearCount },
  });
}

function forgetPetSideState(botId: string) {
  try { petEvolve.forgetBot(botId); } catch { /* ignore */ }
  try { petVisit.forgetBot(botId); } catch { /* ignore */ }
  try { companion.forgetBot(botId); } catch { /* ignore */ }
  const all = store.readConfig();
  const prev = (all.prefs as Record<string, unknown> | undefined) || {};
  store.writeConfig({ ...all, prefs: clearPetBotPrefs(prev, botId) });
}

store.onMessageAdded((m) => {
  if (m.role === "user" && m.from === "user") lastUserAt = m.createdAt;
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("messages:new", m);
  notifyReply(m);
});

/**
 * 通知投递：先走 Electron UNNotification；开发态即使系统设置里 Electron 已开，
 * 也常报 UNErrorDomain 1 —— 再降级 osascript `display notification`（本机已验证可用）。
 * blocked 持久化；notifyMuted = 用户点「不再提醒」。
 */
let notifyState: "unknown" | "ok" | "blocked" = store.readConfig().notifyBlocked ? "blocked" : "unknown";
let notifyMuted = !!store.readConfig().notifyMuted;
let notifyProbePending = notifyState === "blocked" && !notifyMuted;
let notifyProbeInflight: Promise<"ok" | "blocked" | "unknown"> | null = null;
let notifyProbedThisSession = false;
const notifyAppLabel = () => (app.isPackaged ? "harness-bot" : "Electron");
function pushNotifyUi(reason?: string) {
  sendUi("notify:state", { state: notifyState, reason, muted: notifyMuted, appLabel: notifyAppLabel() });
}
function setNotifyState(next: "ok" | "blocked", reason?: string) {
  if (next === "ok" && notifyMuted) {
    notifyMuted = false;
    store.writeConfig({ ...store.readConfig(), notifyMuted: false });
  }
  if (next === notifyState) {
    pushNotifyUi(reason);
    return;
  }
  notifyState = next;
  store.writeConfig({ ...store.readConfig(), notifyBlocked: next === "blocked" });
  pushNotifyUi(reason);
}

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** osascript 兜底：不依赖 Electron 的 UNNotification 授权 */
async function notifyOsascript(title: string, body: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile(
      "osascript",
      ["-e", `display notification "${escapeAppleScript(body.slice(0, 180))}" with title "${escapeAppleScript(title.slice(0, 80))}"`],
      { timeout: 8000 },
      (err) => {
        if (err) {
          console.log(`[notify] osascript failed：${err.message}`);
          resolve(false);
        } else {
          console.log("[notify] ok：osascript");
          resolve(true);
        }
      },
    );
  });
}

/** 只测 Electron 通道，不改全局状态 */
function showElectronNotification(opts: { title: string; body: string; silent?: boolean; onClick?: () => void }): Promise<boolean> {
  return new Promise((resolve) => {
    if (!Notification.isSupported()) return resolve(false);
    let settled = false;
    const done = (ok: boolean, reason?: string) => {
      if (settled) return;
      settled = true;
      console.log(`[notify] electron ${ok ? "ok" : "failed"}${reason ? `：${reason}` : ""}`);
      resolve(ok);
    };
    try {
      const n = new Notification({ title: opts.title, body: opts.body, silent: !!opts.silent });
      if (opts.onClick) n.on("click", opts.onClick);
      n.once("show", () => done(true));
      n.once("failed", (_e, err) => {
        const msg = String(err ?? "");
        if (/UNErrorDomain/i.test(msg) && !app.isPackaged) {
          console.log("[notify] 开发态 Electron 未正确签名（linker-signed）。跑 bun run sign:electron 后重启；点通知才能进会话。");
        }
        done(false, msg);
      });
      n.show();
      // 开发态常既不 show 也不 failed；超时后走 osascript 兜底，不要误报成功
      setTimeout(() => done(false, "超时未回调"), 2000);
    } catch (e) {
      done(false, e instanceof Error ? e.message : String(e));
    }
  });
}

/** Electron → osascript；两者都失败才记 blocked。osascript 点不了 onClick，靠 pendingNotifySession + activate。 */
async function deliverNotification(opts: {
  title: string;
  body: string;
  silent?: boolean;
  onClick?: () => void;
  sessionId?: string | null;
  updateState?: boolean;
}): Promise<boolean> {
  if (opts.sessionId) pendingNotifySession = opts.sessionId;
  const update = opts.updateState !== false;
  const click = opts.onClick ?? (opts.sessionId ? () => focusMainPanel(opts.sessionId) : undefined);
  let ok = await showElectronNotification({ ...opts, onClick: click });
  if (!ok) ok = await notifyOsascript(opts.title, opts.body);
  if (update) setNotifyState(ok ? "ok" : "blocked", ok ? undefined : "Electron 与系统通知均失败");
  return ok;
}

/** 探测：每会话默认一次；重新检测 force=true */
async function probeNotify(force = false): Promise<"ok" | "blocked" | "unknown"> {
  if (notifyState === "ok" && !force) return "ok";
  if (notifyProbedThisSession && !force && notifyState === "blocked") {
    pushNotifyUi("本会话已测过");
    return notifyState;
  }
  if (notifyProbeInflight) return notifyProbeInflight;
  notifyProbeInflight = (async () => {
    try {
      notifyProbedThisSession = true;
      await deliverNotification({ title: "Harness Bot", body: "通知已就绪 ✓", silent: false });
      return notifyState;
    } finally {
      notifyProbeInflight = null;
    }
  })();
  return notifyProbeInflight;
}

/** 设提醒时确认通知能弹 */
async function notifyCheck(title: string, body: string): Promise<boolean> {
  if (notifyState === "ok") return true;
  return deliverNotification({ title, body });
}

/** 窗口不在前台时 Dock 图标跳动 + 任务栏闪烁（系统通知被拦时也能注意到） */
function attention() {
  if (mainWin && !mainWin.isDestroyed() && mainWin.isFocused()) return;
  if (process.platform === "darwin") app.dock?.bounce("critical");
  else mainWin?.flashFrame(true);
}

/** 窗口不在前台时，bot 的新回复（含定时任务）弹系统通知，点一下跳到那个会话 */
const lastNotified = new Map<string, number>();
function notifyReply(m: import("../core/types").ChatMessage) {
  if (m.meta?.partial) return;
  if (m.role !== "assistant" || m.kind === "bot-to-bot" || m.kind === "event" || isB2bSession(m.sessionId) || m.sessionId.startsWith("group-")) return;
  // 定时提醒到点：窗口在前台也要弹
  if (!m.meta?.scheduled && mainWin && !mainWin.isDestroyed() && mainWin.isFocused()) return;
  if (Date.now() - (lastNotified.get(m.sessionId) ?? 0) < 4000) return;
  lastNotified.set(m.sessionId, Date.now());
  const bot = store.getBot(m.from);
  const body = contentText(m.content).replace(/```tool[\s\S]*?```/g, "").replace(/\s+/g, " ").trim().slice(0, 90) || "发来了新内容";
  void deliverNotification({
    title: bot?.name ?? "Harness Bot",
    body,
    sessionId: m.sessionId,
    onClick: () => focusMainPanel(m.sessionId),
  });
}

// 形象生成：有图像 provider 时用真 API，否则降级
function personaWithImage() {
  const imgProv = providers.list().find((p) => p.kind === "openai-compat" && (p.model?.startsWith("dall") || p.model?.startsWith("gpt-image")));
  // 也认设置页单独配的 imageGen
  const cfg = store.readConfig().imageGen as { baseUrl?: string; model?: string; apiKey?: string } | undefined;
  if (cfg?.baseUrl && cfg.model) {
    return new PersonaGenerator(store, assetsDir, new OpenAICompatImageGen({
      kind: "openai-compat",
      id: "image-gen",
      name: "图片",
      baseUrl: cfg.baseUrl,
      apiKey: openStoredKey(cfg.apiKey),
      model: cfg.model,
      createdAt: 0,
    } as any));
  }
  if (imgProv) return new PersonaGenerator(store, assetsDir, new OpenAICompatImageGen(imgProv));
  return persona;
}

/**
 * 智能形象（模型优先）：
 * AI 生图 → 真图；否则代码画头像，并由模型/规则决定 keep / shape / 换本地皮；
 * 无本地强匹配时再尝试 petdex。绝不写字母渐变假 PNG，不无脑硬切形状色块。
 */
async function resolveAppearance(botId: string, desc: string, style?: "default" | "pixel" | "cute") {
  const bot = store.getBot(botId);
  if (!bot) throw new Error("bot 不存在");
  const localSkins = petSkins.list().map((s) => ({ id: s.id, name: s.name, desc: s.desc }));
  const gen = personaWithImage();

  const pickSmart = async (ctx: {
    description: string;
    suggestions: import("../core/persona").AppearanceSuggestion[];
    currentSkinId?: string;
  }): Promise<AppearancePick | null> => {
    const provider = providers.get(bot.providerId) || providers.getDefault();
    if (!provider) return null;
    const locals = ctx.suggestions.filter((s) => s.kind === "live2d" || s.kind === "local");
    try {
      const r = await providers.complete(provider, {
        model: providers.get(bot.providerId) ? bot.model : undefined,
        system: `你是桌宠形象导演。用户一句话要改形象。在候选里选最合适的落地方式。只输出 JSON：
{"action":"keep"|"shape"|"skin","id":"仅 skin 时填候选 id","why":"≤30字"}
规则：几何/简单色块（球/心/星/色块）→ shape；有明显匹配的 Live2D/本地皮 → skin；写实复杂但候选对不上 → keep（只改聊天头像，桌宠保持原皮）。禁止编造不在候选里的 id。`,
        user: `描述：${ctx.description}\n当前皮：${ctx.currentSkinId || "无"}\n候选：\n${locals.map((s) => `- ${s.id}｜${s.name}｜分${s.score}｜${s.why}`).join("\n") || "（无）"}`,
        signal: AbortSignal.timeout(15_000),
      });
      return parseAppearancePick(r.text || "", ctx.suggestions);
    } catch (e) {
      console.error("[appear.pickSmart]", e);
      return null;
    }
  };

  let result = await gen.generate(bot, desc, style, { localSkins, preferSkin: true, pickSmart });

  if (result.appliedSkin) {
    applyBotSkin(botId, result.appliedSkin.id, result.appliedSkin.name);
  } else if (!result.imaged) {
    // keep：高分 petdex 再尝试装社区皮；失败则头像已写好、桌宠保持原皮
    const pd = result.suggestions.find((s) => s.kind === "petdex" && s.score >= 50);
    if (pd) {
      try {
        const pets = await fetchPetdexManifest(join(assetsDir, "skins"));
        const entry = pets.find((p) => p.slug === pd.id) || searchPetdex(pets, pd.id, 1)[0];
        if (entry) {
          const id = petdexSkinId(entry.slug);
          if (!petSkins.list().find((s) => s.id === id)) {
            const skin = await installPetdex(entry, assetsDir, pd.name);
            petSkins.register(skin);
          }
          applyBotSkin(botId, id, pd.name);
          result = {
            ...result,
            appliedSkin: { id, name: pd.name },
            message: `${result.message} 已从社区库装上「${pd.name}」。`,
          };
        }
      } catch {
        // 网络失败：保留代码形状头像 + 原皮
      }
    }
  }

  const title = result.imaged
    ? (result.card?.name || bot.name)
    : (result.codeDrawn ? "代码形状头像" : (result.appliedSkin?.name || "角色卡已更新"));
  pushPetEvent(botId, {
    type: result.imaged || result.codeDrawn || result.appliedSkin ? "avatar-updated" : "proactive",
    text: result.message,
    title,
  });
  return result;
}

function loadMcpServers(): McpServerConfig[] {
  const cfg = store.readConfig();
  const servers = ((cfg as { mcpServers?: McpServerConfig[] }).mcpServers ?? []) as McpServerConfig[];
  const ensured = ensureBuiltinMcpServers(servers, home);
  const needWrite = !servers.some((s) => s.id === COMPUTER_MCP_ID && s.builtin)
    || servers.length !== ensured.length
    || servers.find((s) => s.id === COMPUTER_MCP_ID)?.command !== ensured.find((s) => s.id === COMPUTER_MCP_ID)?.command
    || servers.find((s) => s.id === COMPUTER_MCP_ID)?.enabled !== ensured.find((s) => s.id === COMPUTER_MCP_ID)?.enabled;
  if (needWrite) store.writeConfig({ ...cfg, mcpServers: ensured });
  return mcpServersForClient(ensured, home);
}
function allMcpServers(): McpServerConfig[] {
  return ensureBuiltinMcpServers((store.readConfig().mcpServers as McpServerConfig[] | undefined) ?? [], home);
}
let computerDoctorNote = "";
let computerPrefsPending = false;
function computerUseStatus(): ComputerUseStatus {
  if (process.platform !== "darwin") {
    return { platformOk: false, enabled: false, runtimeReady: false, tools: 0, permissions: { accessibility: false, screen: false }, needsPermission: false, error: "仅支持 macOS", steps: [] };
  }
  const all = allMcpServers();
  const row = all.find((s) => s.id === COMPUTER_MCP_ID);
  const enabled = !!(row && row.enabled !== false);
  const st = mcp.status().find((s) => s.id === COMPUTER_MCP_ID);
  const perms = tccStatus();
  const tools = st?.tools ?? 0;
  const rawErr = enabled ? st?.error : undefined;
  const runtimeReady = !!(row?.command && (!row.command.startsWith("/") || existsSync(row.command)) && (tools > 0 || !rawErr));
  const error = humanizeComputerError(rawErr);
  const base = { enabled, runtimeReady: runtimeReady || tools > 0, tools, permissions: perms, error };
  return {
    platformOk: true,
    ...base,
    needsPermission: !perms.accessibility || !perms.screen,
    uvx: row?.command,
    steps: buildComputerSteps(base),
    doctor: computerDoctorNote || undefined,
  };
}
async function probeComputerDoctor(): Promise<string> {
  try {
    const out = await mcp.callTool(COMPUTER_MCP_ID, "macos_doctor", {});
    computerDoctorNote = String(out).replace(/\s+/g, " ").slice(0, 280);
    return computerDoctorNote;
  } catch (e) {
    computerDoctorNote = humanizeComputerError(e instanceof Error ? e.message : String(e)) ?? "";
    return computerDoctorNote;
  }
}
async function setComputerUseEnabled(on: boolean, onProgress?: (msg: string) => void): Promise<ComputerUseStatus> {
  if (process.platform !== "darwin") throw new Error("仅支持 macOS");
  let next = allMcpServers();
  if (on) {
    const { uvx } = await ensureManagedUv(home, onProgress);
    await warmComputerUseKit(uvx, onProgress);
    const ready = computerMcpConfig(home);
    next = ensureBuiltinMcpServers([...next.filter((s) => s.id !== COMPUTER_MCP_ID), { ...ready, enabled: true }], home);
    onProgress?.("正在连接电脑操控…");
  } else {
    next = next.map((s) => (s.id === COMPUTER_MCP_ID ? { ...s, enabled: false } : s));
    computerDoctorNote = "";
  }
  store.writeConfig({ ...store.readConfig(), mcpServers: next });
  await mcp.reload(mcpServersForClient(next, home));
  if (on) {
    onProgress?.("正在自检权限与能力…");
    await probeComputerDoctor();
    const st = computerUseStatus();
    if (st.needsPermission) computerPrefsPending = true;
  }
  return computerUseStatus();
}

// 为所有 bot 注册默认消息处理器：调用其绑定的 provider 生成回复
/** 总线 handler：用户消息已由 MessageBus 落盘，runtime 只记回复；返回 recorded 避免总线再写一遍 */
async function defaultHandler(from: any, to: any, text: string, ctx: any): Promise<{ text: string; recorded: true }> {
  const bot = store.getBot(to.id);
  if (!bot) return { text: "bot 不存在", recorded: true };
  statuses.set(bot.id, { botId: bot.id, state: "running", lastRunAt: Date.now(), currentTask: text.slice(0, 60) });
  try {
    const r = await runtime.handle(
      { bot, from: from.id || "user", text, sessionId: ctx.sessionId, history: store.listMessages(ctx.sessionId).slice(-200) },
      { skipUserRecord: true, extraSystem: instructionsFor(ctx.sessionId) },
    );
    settleBotStatus(bot.id, r.content, ctx.sessionId);
    if (bot.petEnabled) {
      const xp = grantPetXp(bot.id, 10);
      pushPetEvent(bot.id, { type: "reply", text: r.text.slice(0, 120), rich: r.content, model: bot.model || providers.get(bot.providerId)?.model || providers.getDefault()?.model, xp });
    } else {
      pushPetEvent(bot.id, { type: "reply", text: r.text.slice(0, 120), rich: r.content });
    }
    return { text: r.text, recorded: true };
  } catch (e) {
    statuses.set(bot.id, { botId: bot.id, state: "error", lastRunAt: Date.now(), lastError: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

// 注册已有 bot + 新 bot 时自动注册
function registerAll() {
  for (const b of store.listBots()) {
    const patched = withDefaultAvatar(b);
    if (patched) store.saveBot(patched);
    bus.register(b.id, defaultHandler);
  }
}
registerAll();

let tray: Tray | null = null;
let mainWin: BrowserWindow | null = null;
const petWins = new Map<string, BrowserWindow>();
const PET_WIN_W = 360, PET_WIN_H = 700;

// Live2D 视线跟随：定时把全局鼠标位置（换算为窗口内坐标）推给宠物窗口
let lastCursor = "";
setInterval(() => {
  if (!petWins.size) return;
  const p = screen.getCursorScreenPoint();
  const key = `${p.x},${p.y}`;
  if (key === lastCursor) return;
  lastCursor = key;
  for (const w of petWins.values()) {
    if (w.isDestroyed() || !w.isVisible()) continue;
    const [wx, wy] = w.getPosition();
    w.webContents.send("pet:cursor", { x: p.x - wx, y: p.y - wy });
  }
}, 80);

ipcMain.on("pet:setIgnoreMouse", (e, ignore: boolean) => {
  BrowserWindow.fromWebContents(e.sender)?.setIgnoreMouseEvents(ignore, { forward: true });
});

// 宠物拖动：主进程按全局鼠标位置移动窗口（-webkit-app-region 与鼠标穿透在 macOS 上冲突）
const petDrags = new Map<number, { timer: ReturnType<typeof setInterval>; dx: number; dy: number }>();
ipcMain.on("pet:drag", (e, phase: "start" | "end") => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  const prev = petDrags.get(win.id);
  if (prev) { clearInterval(prev.timer); petDrags.delete(win.id); }
  if (phase === "end") {
    const botId = [...petWins.entries()].find(([, w]) => w === win)?.[0];
    if (botId) {
      const [bx, by] = win.getPosition();
      persistPetVisible(botId, !win.isDestroyed() && win.isVisible(), {
        x: bx, y: by, displayId: screen.getDisplayNearestPoint({ x: bx, y: by }).id,
      });
    }
    return;
  }
  const c = screen.getCursorScreenPoint();
  const [wx, wy] = win.getPosition();
  const drag = { dx: c.x - wx, dy: c.y - wy, timer: setInterval(() => {
    if (win.isDestroyed()) { clearInterval(drag.timer); petDrags.delete(win.id); return; }
    const p = screen.getCursorScreenPoint();
    win.setPosition(p.x - drag.dx, p.y - drag.dy);
  }, 16) };
  petDrags.set(win.id, drag);
});

/** G5.5：宠物成长经验 +n（落盘 pets.json，返回新 xp） */
function grantPetXp(botId: string, n: number): number {
  const pet = store.listPets().find((p) => p.botId === botId) || { botId, x: 0, y: 0, visible: true };
  const prevXp = pet.xp || 0;
  const xp = prevXp + n;
  store.savePet({ ...pet, xp });
  const prevLv = levelFromXp(prevXp);
  const nextLv = levelFromXp(xp);
  // 娱乐成长：跨级可顺带提议（不打断工作回合；关 selfEvolve 则只涨 XP/称号）
  if (nextLv > prevLv) {
    notePetDecision(home, { botId, kind: "xpLevelUp", via: "system", note: `Lv.${prevLv}→${nextLv}（娱乐成长）` });
    if (readPetPrefs(botId).selfEvolve && statuses.get(botId)?.state !== "running") {
      void petEvolve.onLevelUp(botId, nextLv).catch((e) => console.error("[pet-evolve.levelup]", e));
    }
  }
  return xp;
}

/** 娱乐节拍：异步推事件，绝不把 bot 标成 running */
function schedulePetScript(botId: string, beats: PetBeat[]) {
  notePetDecision(home, { botId, kind: "script", via: "user", note: `${beats.length} 拍` });
  void (async () => {
    const bot = store.getBot(botId);
    for (const b of beats.slice(0, 6)) {
      if (b.type === "wait") {
        await new Promise((r) => setTimeout(r, b.ms));
        continue;
      }
      if (b.type === "action") {
        const plan = resolveMotion(b.action, {
          holdSec: b.hold,
          traits: { blob: bot ? traitsBlob(bot) : "" },
        });
        pushPetEvent(botId, { type: "action", action: plan.action, hold: plan.holdSec, motion: plan });
        await new Promise((r) => setTimeout(r, Math.max(400, (plan.holdSec || 1) * 700)));
        continue;
      }
      if (b.type === "fx") {
        try { await resolveAndPlayFx(botId, b.phrase); } catch (e) { console.error("[pet-script.fx]", e); }
        await new Promise((r) => setTimeout(r, 900));
        continue;
      }
      if (b.type === "say") {
        pushPetEvent(botId, {
          type: "say",
          text: b.text,
          title: b.title || bot?.name || "表演",
          action: "celebrate",
          hold: 2,
        });
        await new Promise((r) => setTimeout(r, 1100));
      }
    }
  })();
}

/** 向某 bot 的宠物窗口推送事件（不存在则跳过） */
function pushPetEvent(botId: string, event: {
  type: string; text?: string; title?: string; rich?: import("../core/types").ContentBlock[];
  sessionId?: string; model?: string; xp?: number;
  peerId?: string; peerName?: string; role?: string;
  action?: string; hold?: number;
  motion?: ReturnType<typeof resolveMotion>;
  fx?: { id?: string; overlay: string; color?: string; durationMs?: number; label?: string; dir?: string };
}) {
  const win = petWins.get(botId);
  if (win && !win.isDestroyed()) {
    win.webContents.send("pet:event", event);
  }
}

// G5：macOS 辅助功能 / 屏幕录制 TCC 权限检测
// 必须查 Electron 本进程（AXIsProcessTrusted），不能用子进程 osascript——那会误报未授权。
// 注意：系统设置里同名「Electron」可能是另一份签名；开发态本进程常是 Apple Development 重签的 com.github.Electron。
const ELECTRON_APP_PATH = process.platform === "darwin"
  ? join(process.execPath, "..", "..", "..") // .../Electron.app/Contents/MacOS/Electron → Electron.app
  : "";
function tccStatus() {
  if (process.platform !== "darwin") {
    return { accessibility: false, screen: false, electronAppPath: "", hint: undefined as string | undefined };
  }
  const accessibility = systemPreferences.isTrustedAccessibilityClient(false);
  const screen = systemPreferences.getMediaAccessStatus("screen") === "granted";
  let hint: string | undefined;
  if (!accessibility) {
    // 必须以 execPath 判断：app.getAppPath() 在开发态常是项目目录，外置盘项目会误报。
    const electronOnExternal = /^\/Volumes\//.test(process.execPath);
    hint = electronOnExternal
      ? "当前 Electron 在外置盘上，macOS 辅助功能经常勾了也不认。请复制到 /Applications 或 ~/Library/Application Support/harness-bot/runtime/ 后再启动，删掉旧条目，用「+」添加这份，打开开关并完全退出再开。"
      : `系统列表开着也可能不是当前这份（重签后 CDHash 会变）。请删掉「Harness-Electron / Electron」，用「+」添加：${ELECTRON_APP_PATH || "当前 Electron.app"}，打开开关后完全退出再开。`;
  }
  return { accessibility, screen, electronAppPath: ELECTRON_APP_PATH, hint };
}

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 860,
    minHeight: 600,
    title: "Harness Bot",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#ffffff",
    show: false,
    webPreferences: {
      preload: join(DIST_DIR, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWin.loadURL(pathToFileURL(join(DIST_DIR, "renderer", "index.html")).toString());
  // 用户从「系统设置 → 通知 / 电脑操控权限」回来时重测
  mainWin.on("focus", () => {
    if (notifyProbePending) {
      notifyProbePending = false;
      void probeNotify(true);
    }
    if (computerPrefsPending) {
      computerPrefsPending = false;
      const st = computerUseStatus();
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send("app:changed", "mcp");
        mainWin.webContents.send("computerUse:status", st);
      }
      if (st.needsPermission) computerPrefsPending = true; // 还没勾完，下次再看
    }
  });
  // 消息里的链接（来源引用等）用系统浏览器打开，面板本身不跳走
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWin.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith("file:") && url.includes("/renderer/index.html")) return;
    e.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
  // 主进程卡住时页面可能既不完成也不报失败：30 秒没加载完就重新加载
  const loadWatchdog = setTimeout(() => {
    if (!mainWin || mainWin.isDestroyed()) return;
    console.error("[harness] 主面板 30 秒没加载完，重新加载");
    mainWin.reload();
  }, 30_000);
  mainWin.webContents.on("did-finish-load", () => {
    clearTimeout(loadWatchdog);
    console.log("[harness] 主控面板渲染完成 ✅");
    for (const s of pendingImports.splice(0)) mainWin?.webContents.send("bots:importLink", s);
    if (pendingAbout) {
      pendingAbout = false;
      mainWin?.webContents.send("app:openAbout");
    }
    mainWin?.webContents.executeJavaScript("typeof window.harness !== 'undefined' ? 'bridge-ok' : 'bridge-missing'")
      .then((r) => console.log("[harness] preload bridge:", r))
      .catch(() => console.log("[harness] bridge check skipped"));
  });
  mainWin.once("ready-to-show", () => mainWin?.show());
  mainWin.on("closed", () => { mainWin = null; });
  mainWin.webContents.on("console-message", (e) => {
    if (e.level === "error") logger.write("error", `[renderer] ${e.message} (${e.sourceId.split("/").pop()}:${e.lineNumber})`);
  });
  mainWin.webContents.on("render-process-gone", (_e, d) => {
    console.error(`[harness] 主面板渲染进程退出：${d.reason}`);
    if (d.reason !== "clean-exit" && mainWin && !mainWin.isDestroyed()) mainWin.reload();
  });
  // 启动时主进程被卡住（如等钥匙串授权）会让页面加载失败、窗口白屏：失败就重新加载
  mainWin.webContents.on("did-fail-load", (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    console.error(`[harness] 主面板加载失败（${code} ${desc}），重新加载`);
    setTimeout(() => { if (mainWin && !mainWin.isDestroyed()) mainWin.reload(); }, 1000);
  });
}

/**
 * 创建/复用宠物窗口。
 * - 仅 petEnabled 可建窗
 * - forceShow：强制亮出来（托盘「显示」、手动拜访）
 * - 否则尊重 PetState.visible（启动恢复可保持隐藏）
 */
function createPetWindow(botId: string, opts?: { forceShow?: boolean }) {
  const bot = store.getBot(botId);
  if (!bot?.petEnabled) return;
  const saved = store.listPets().find((p) => p.botId === botId);
  const wantShow = opts?.forceShow || saved?.visible !== false;

  const existing = petWins.get(botId);
  if (existing && !existing.isDestroyed()) {
    if (wantShow && !existing.isVisible()) existing.show();
    if (!wantShow && existing.isVisible()) existing.hide();
    return existing;
  }

  // 宠物固定在窗口底部，上方透明区留给气泡/HUD；透明区域鼠标穿透（pet:setIgnoreMouse）
  const PW = PET_WIN_W, PH = PET_WIN_H;
  let x: number, y: number;
  if (saved) {
    // 多显示器记忆：优先恢复到记录所在显示器（displayId），越界时夹回屏内而不是重置到角落
    const disp = (saved.displayId != null ? screen.getAllDisplays().find((d) => d.id === saved.displayId) : undefined)
      ?? screen.getDisplayNearestPoint({ x: saved.x, y: saved.y });
    const wa = disp.workArea;
    x = Math.min(Math.max(saved.x, wa.x), wa.x + wa.width - PW);
    y = Math.min(Math.max(saved.y, wa.y), wa.y + wa.height - PH);
  } else {
    const wa = screen.getPrimaryDisplay().workArea;
    x = wa.x + wa.width - PW - 8;
    y = wa.y + wa.height - PH - 8;
  }
  const win = new BrowserWindow({
    width: PW,
    height: PH,
    x, y,
    show: wantShow,
    transparent: true,
    // 不设透明底色时，macOS 激活/点通知后常把透明区刷成白块
    backgroundColor: "#00000000",
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: join(DIST_DIR, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(pathToFileURL(join(DIST_DIR, "renderer", "pet.html")).toString() + `?botId=${botId}`);
  win.webContents.on("did-finish-load", () => {
    console.log(`[harness] 宠物窗口渲染完成 🐾 ${bot.name}`);
    win?.webContents.executeJavaScript("typeof window.harness !== 'undefined' ? 'pet-bridge-ok' : 'pet-bridge-missing'")
      .then((r) => console.log("[harness] pet preload bridge:", r))
      .catch(() => console.log("[harness] pet bridge check skipped"));
  });
  win.on("closed", () => petWins.delete(botId));
  win.on("moved", () => {
    const [bx, by] = win.getPosition();
    const displayId = screen.getDisplayNearestPoint({ x: bx, y: by }).id;
    persistPetVisible(botId, !win.isDestroyed() && win.isVisible(), { x: bx, y: by, displayId });
  });
  petWins.set(botId, win);
  if (!saved) persistPetVisible(botId, wantShow, { x, y });
  return win;
}

/** 托盘图标：优先用当前启用宠物的 sprite 首帧，否则用默认粉团子 */
function trayIconFromSkin(): Electron.NativeImage {
  const fallback = () => {
    const p2 = join(DIST_DIR, "..", "assets", "tray@2x.png");
    const p1 = join(DIST_DIR, "..", "assets", "tray.png");
    const hi = nativeImage.createFromPath(p2);
    if (!hi.isEmpty()) return hi.resize({ width: 22, height: 22 });
    const lo = nativeImage.createFromPath(p1);
    return lo.isEmpty() ? nativeImage.createEmpty() : lo.resize({ width: 22, height: 22 });
  };
  const bot = store.listBots().find((b) => b.petEnabled && b.skinId);
  if (!bot?.skinId) return fallback();
  const skin = petSkins.get(bot.skinId);
  const sp = skin?.sprite;
  if (!sp?.path || !existsSync(sp.path)) return fallback();
  try {
    const sheet = nativeImage.createFromPath(sp.path);
    if (sheet.isEmpty()) return fallback();
    const { width, height } = sheet.getSize();
    const cols = Math.max(1, sp.cols || 8);
    const rows = Math.max(1, sp.rows || 9);
    const cellW = sp.cellW || Math.floor(width / cols);
    const cellH = sp.cellH || Math.floor(height / rows);
    if (cellW < 4 || cellH < 4) return fallback();
    // idle 首帧通常在 (0,0)
    const frame = sheet.crop({ x: 0, y: 0, width: Math.min(cellW, width), height: Math.min(cellH, height) });
    return frame.resize({ width: 22, height: 22, quality: "best" });
  } catch {
    return fallback();
  }
}

function updateTrayIcon() {
  if (!tray) return;
  try {
    const icon = trayIconFromSkin();
    if (!icon.isEmpty()) tray.setImage(icon);
  } catch { /* tray 已销毁时忽略 */ }
}

function refreshTray() {
  const menu = Menu.buildFromTemplate([
    { label: "打开主控面板", click: () => { if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.focus(); } else createMainWindow(); } },
    { type: "separator" },
    { label: "宠物：全部显示", click: () => showPetWindow() },
    { label: "宠物：全部隐藏", click: () => hidePetWindow() },
    { type: "separator" },
    { label: "打开日志文件夹", click: () => void shell.openPath(logger.dir) },
    { type: "separator" },
    { label: "GitHub 仓库", click: () => void shell.openExternal("https://github.com/zjyzhj/harness-system") },
    { label: "关于与开源声明…", click: () => openAboutInApp() },
    { label: "退出", click: () => app.quit() },
  ]);
  tray?.setContextMenu(menu);
  updateTrayIcon();
}

/** 别人分享的 bot 模板：harnessbot:// 链接或 .harnessbot 文件，交给界面预览后导入 */
const pendingImports: string[] = [];
let pendingAbout = false;
function deliverImport(payload: string) {
  if (mainWin && !mainWin.webContents.isLoading()) {
    mainWin.show();
    mainWin.webContents.send("bots:importLink", payload);
  } else pendingImports.push(payload);
}
function openAboutInApp() {
  if (mainWin && !mainWin.isDestroyed() && !mainWin.webContents.isLoading()) {
    mainWin.show();
    mainWin.focus();
    mainWin.webContents.send("app:openAbout");
    return;
  }
  pendingAbout = true;
  if (!mainWin || mainWin.isDestroyed()) createMainWindow();
  else { mainWin.show(); mainWin.focus(); }
}
if (process.defaultApp && process.argv[1]) app.setAsDefaultProtocolClient(TEMPLATE_SCHEME, process.execPath, [resolve(process.argv[1])]);
else app.setAsDefaultProtocolClient(TEMPLATE_SCHEME);
app.on("open-url", (e, url) => {
  e.preventDefault();
  if (url.toLowerCase().startsWith(`${TEMPLATE_SCHEME}://`)) deliverImport(url);
});
app.on("open-file", (e, path) => {
  if (extname(path).toLowerCase() !== `.${TEMPLATE_EXT}`) return;
  e.preventDefault();
  try { deliverImport(readFileSync(path, "utf8")); } catch { /* 读不了就忽略 */ }
});

app.whenReady().then(() => {
  // 先碰一次钥匙串：签名变了 macOS 会弹授权框并卡住主进程；放在建窗口之前，免得页面加载到一半超时白屏
  try { if (safeStorage.isEncryptionAvailable()) safeStorage.decryptString(safeStorage.encryptString("probe")); } catch (e) { console.error("[harness] 钥匙串不可用", e); }
  store.setKeyCipher(keyCipher);
  try { encryptLegacyConfigKeys(); } catch (e) { console.error("[harness] 加密旧配置 key 失败", e); }
  semantic.setup();
  setInterval(() => semantic.schedule(0), 10 * 60_000).unref();
  setTimeout(() => {
    try {
      const n = store.offloadInlineImages();
      if (n) console.log(`[harness] ${n} 个会话里的内嵌图片已改存为文件`);
    } catch (e) { console.error("[harness] 整理会话失败", e); }
  }, 3000);
  if (!EVAL_MODE) {
    tray = new Tray(trayIconFromSkin());
    tray.setToolTip("Harness Bot");
    refreshTray();
    createMainWindow();
    // G3：启动时恢复已启用的宠物窗口（多显示器记忆位置）
    for (const b of store.listBots().filter((x) => x.petEnabled)) createPetWindow(b.id);
    updateTrayIcon();
  }

  // G5：授权请求以卡片形式出现在 bot 正在干活的会话里（没有窗口时退回系统弹窗）
  consent.decider = async (req) => {
    const bot = store.getBot(req.botId);
    const name = bot?.name || req.botId;
    const capLabel = capLabelOf(req.cap);
    const strong = !!req.requiresStrongConsent;
    if (!mainWin || mainWin.isDestroyed()) {
      const choices: [string, ConsentDecision][] = [["批准一次", "allow-once"]];
      if (req.rememberPath) choices.push(["总是允许此目录", "allow-command"]);
      else if (!strong && !req.onceOnly && req.command) choices.push([`总是允许 ${req.command}`, "allow-command"]);
      if (!strong && !req.command && !req.rememberPath && req.cap !== "bash:other") choices.push(["长期批准", "allow"]);
      choices.push(["拒绝", "deny"]);
      const detail = `${req.description}${req.reasons?.length ? `\n\n需要注意：${req.reasons.join("；")}` : ""}`;
      const btn = dialog.showMessageBoxSync({ type: "question", title: `系统授权请求 — ${name}`, message: `${name} 请求使用「${capLabel}」`, detail, buttons: choices.map((c) => c[0]), defaultId: choices.length - 1, cancelId: choices.length - 1, noLink: true });
      return choices[btn]?.[1] ?? "deny";
    }
    const id = `c-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const sessionId = activeSession.get(req.botId) ?? null;
    const signal = sessionId ? inflight.get(sessionId)?.signal : undefined;
    const decision = await new Promise<ConsentDecision>((resolve) => {
      const done = (d: ConsentDecision) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); pendingConsent.delete(id); resolve(d); };
      const timer = setTimeout(() => done("deny"), 10 * 60_000);
      const onAbort = () => done("deny");
      signal?.addEventListener("abort", onAbort);
      pendingConsent.set(id, done);
      sendUi("consent:request", { id, botId: req.botId, botName: name, cap: req.cap, capLabel, description: req.description, danger: strong, command: req.command, onceOnly: !!req.onceOnly, rememberPath: req.rememberPath, reasons: req.reasons ?? [], sessionId });
    });
    if (sessionId) {
      const action = consentActionLabel(req, capLabel);
      const note = decision === "allow-command"
        ? (req.rememberPath
          ? `🔐 你允许 ${name} 以后在目录「${req.rememberPath}」${req.cap === "term:open" ? "直接打开终端" : "直接派 Coding CLI"}`
          : opaqueConsentCmd(req.command)
            ? `🔐 你允许 ${name} 以后直接${action}`
            : `🔐 你允许 ${name} 以后直接执行 ${String(req.command).trim()}`)
        : `🔐 你${decision === "allow-once" ? "批准了一次" : decision === "allow" ? "长期批准了" : "拒绝了"} ${name} ${action}`;
      pushConsentNote(sessionId, note);
    }
    sendUi("consent:resolved", { id, decision });
    return decision;
  };

  if (!EVAL_MODE) void startGatewayFromConfig();

  /** 云端入站：短链桥 POST /w/:token → 本机轮询入队（pull 与执行解耦，urgent 可插队） */
  let inboundPollBusy = false;
  const inboundDedupe = new InboundDedupe();
  /** 已接过、尚未记入 dedupe 的云端事件。pull 不删队列，不占上这个集合就会在 bot 回复期间被下一次轮询再开一轮 */
  const inboundQueued = new Set<string>();
  const pendingInboundAcks = new Set<string>();
  const inboundJobQ: InboundJob[] = [];
  let inboundPumpBusy = false;
  /** 每会话入站串行，避免两个 normal 同时过 waitSessionIdle */
  const sessionInboundTail = new Map<string, Promise<void>>();

  async function flushInboundAcks(creds: NonNullable<ReturnType<typeof shareBridgeCreds>>) {
    if (!pendingInboundAcks.size) return;
    const keys = [...pendingInboundAcks];
    try {
      await ackCloudInboundEvents(keys, creds);
      for (const k of keys) pendingInboundAcks.delete(k);
    } catch (e) {
      console.warn("[harness] cloud inbound ack failed:", e instanceof Error ? e.message : e);
    }
  }

  function resolveInboundSession(task: ScheduledTask): string {
    const pinned = task.sessionId;
    if (pinned && store.getSession(pinned) && !pinned.startsWith("group-") && !isB2bSession(pinned)) return pinned;
    const gazed = activeSession.get(task.botId);
    if (gazed && store.getSession(gazed) && !gazed.startsWith("group-") && !isB2bSession(gazed)) return gazed;
    const sid = `wh-${task.id}`;
    store.ensureSession(sid, task.botId, task.name || "Webhook");
    return sid;
  }

  async function withSessionInboundChain<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = sessionInboundTail.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const held = prev.then(() => gate);
    sessionInboundTail.set(sessionId, held.then(() => undefined, () => undefined));
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (sessionInboundTail.get(sessionId) === held.then(() => undefined, () => undefined)) {
        /* keep map tidy only when no successor — skip; GC via overwrite */
      }
    }
  }

  enqueueInboundJob = (job) => {
    const claim = claimInboundEvent(job.eventId, { done: inboundDedupe, queued: inboundQueued });
    if (claim === "done") {
      if (job.kvKey) {
        pendingInboundAcks.add(job.kvKey);
        const c = shareBridgeCreds();
        if (c) void flushInboundAcks(c);
      }
      return;
    }
    if (claim === "queued") return;
    if (job.parsed.priority === "urgent") {
      const i = inboundJobQ.findIndex((j) => j.parsed.priority !== "urgent");
      if (i < 0) inboundJobQ.push(job);
      else inboundJobQ.splice(i, 0, job);
    } else {
      inboundJobQ.push(job);
    }
    void pumpInboundJobs();
  };

  async function pumpInboundJobs() {
    if (inboundPumpBusy) return;
    inboundPumpBusy = true;
    try {
      while (inboundJobQ.length) {
        inboundJobQ.sort((a, b) => {
          const au = a.parsed.priority === "urgent" ? 0 : 1;
          const bu = b.parsed.priority === "urgent" ? 0 : 1;
          return au - bu;
        });
        const job = inboundJobQ.shift()!;
        if (job.eventId && inboundDedupe.has(job.eventId)) {
          inboundQueued.delete(job.eventId);
          if (job.kvKey) pendingInboundAcks.add(job.kvKey);
          continue;
        }
        try {
          if (!deliverInboundWebhook) throw new Error("runtime not ready");
          await deliverInboundWebhook(job.task, job.parsed);
          if (job.eventId) {
            inboundDedupe.add(job.eventId);
            inboundQueued.delete(job.eventId);
          }
        } catch (e) {
          console.error("[harness] inbound deliver failed:", e instanceof Error ? e.message : e);
          try {
            const sid = resolveInboundSession(job.task);
            const bot = store.getBot(job.task.botId);
            store.addMessage({
              sessionId: sid,
              from: bot?.id || "system",
              to: "user",
              role: "assistant",
              content: `❌ 入站 Webhook「${job.task.name}」投递失败：${e instanceof Error ? e.message : String(e)}`,
              kind: "event",
              createdAt: Date.now(),
              meta: { webhook: true },
            });
          } catch { /* ignore */ }
          if (job.eventId) {
            inboundDedupe.add(job.eventId);
            inboundQueued.delete(job.eventId);
          }
        } finally {
          if (job.kvKey) {
            pendingInboundAcks.add(job.kvKey);
            const creds = shareBridgeCreds();
            if (creds) await flushInboundAcks(creds);
          }
        }
      }
    } finally {
      inboundPumpBusy = false;
      if (inboundJobQ.length) void pumpInboundJobs();
    }
  }

  async function pollCloudInboundOnce() {
    if (inboundPollBusy) return;
    const creds = shareBridgeCreds();
    if (!creds) return;
    // 只拉启用中的令牌，避免暂停例行占满 pull 窗口
    const tokens = scheduler.list()
      .filter((t) => t.enabled && t.webhookToken && t.webhookToken.length >= 8)
      .map((t) => t.webhookToken!);
    if (!tokens.length && !pendingInboundAcks.size) return;
    inboundPollBusy = true;
    try {
      await flushInboundAcks(creds);
      if (!tokens.length) return;
      const items = sortInboundEventsByPriority(await pullCloudInboundEvents(tokens, creds));
      for (const ev of items) {
        if (ev.id && (inboundDedupe.has(ev.id) || inboundQueued.has(ev.id))) {
          if (inboundDedupe.has(ev.id) && ev.kvKey) pendingInboundAcks.add(ev.kvKey);
          continue;
        }
        const task = scheduler.findByWebhookToken(ev.token);
        if (!task || !task.enabled) {
          // 令牌作废或不该拉到：ack 丢掉；暂停例行本不在 tokens 里
          if (ev.kvKey) pendingInboundAcks.add(ev.kvKey);
          if (ev.id) inboundDedupe.add(ev.id);
          continue;
        }
        const parsed = parseInboundWebhookBody(ev.body, { priority: ev.priority });
        enqueueInboundJob!({
          task,
          parsed,
          source: "cloud",
          eventId: ev.id,
          kvKey: ev.kvKey,
        });
      }
      await flushInboundAcks(creds);
    } catch (e) {
      if (Math.random() < 0.05) console.warn("[harness] cloud inbound poll:", e instanceof Error ? e.message : e);
    } finally {
      inboundPollBusy = false;
    }
  }

  async function syncCloudInboundRegistrations() {
    const creds = shareBridgeCreds();
    if (!creds) return;
    const tokens = scheduler.list()
      .map((t) => t.webhookToken)
      .filter((t): t is string => !!t && t.length >= 8);
    if (!tokens.length) return;
    try {
      await registerCloudInboundTokens(tokens, creds);
    } catch (e) {
      console.warn("[harness] cloud inbound register:", e instanceof Error ? e.message : e);
    }
  }

  /** 入站 Webhook：解析 message 注入用户会话；普通等空闲，紧急打断本会话 */
  async function waitSessionIdle(sessionId: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (inflight.has(sessionId)) {
      if (Date.now() - start > timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 200));
    }
    return true;
  }

  deliverInboundWebhook = async function runInboundWebhook(
    task: ScheduledTask,
    parsed: ReturnType<typeof parseInboundWebhookBody>,
  ) {
    const bot = store.getBot(task.botId);
    if (!bot) throw new Error(`例行所属 bot 已删除（${task.botId}）`);
    const priority: InboundPriority = parsed.priority;
    const sid = resolveInboundSession(task);
    store.ensureSession(sid, bot.id, task.name || "Webhook");

    await withSessionInboundChain(sid, async () => {
      if (priority === "urgent") {
        const mine = inflight.get(sid);
        if (mine) mine.abort();
        await new Promise((r) => setTimeout(r, 50));
        void deliverNotification({
          title: parsed.title || `🚨 ${bot.name}`,
          body: "正在处理紧急 Webhook…",
          sessionId: sid,
        });
        focusMainPanel(sid);
      } else {
        const ok = await waitSessionIdle(sid, 120_000);
        if (!ok) {
          store.addMessage({
            sessionId: sid,
            from: "system",
            to: "user",
            role: "assistant",
            content: `⚠️ 入站 Webhook「${task.name}」在等待当前回复时超时，已放弃本轮（普通优先级不会打断）。紧急任务请带 \`"priority":"urgent"\` 或头 \`X-Harness-Priority: urgent\`。`,
            kind: "event",
            createdAt: Date.now(),
            meta: { webhook: true, priority: "normal" },
          });
          return;
        }
      }

      const { userText, usedMessage } = buildInboundUserText(parsed, task.prompt ?? task.name);
      const extra = buildInboundExtraSystem(parsed, task.prompt ?? "", usedMessage);
      // from=webhook：UI 左侧入站卡（不是用户绿泡）；role=user：模型仍当作用户当面请求
      store.addMessage({
        sessionId: sid,
        from: "webhook",
        to: bot.id,
        role: "user",
        content: userText,
        kind: "chat",
        createdAt: Date.now(),
        meta: { webhook: true, priority },
      });
      const ctrl = new AbortController();
      const prev = inflight.get(sid);
      if (prev && prev !== ctrl) prev.abort();
      inflight.set(sid, ctrl);
      activeSession.set(bot.id, sid);
      statuses.set(bot.id, {
        botId: bot.id,
        state: "running",
        lastRunAt: Date.now(),
        currentTask: `🪝 ${priority === "urgent" ? "紧急 · " : ""}${userText.slice(0, 48)}`,
        sessionId: sid,
      });

      try {
        const timeout = AbortSignal.timeout(15 * 60_000);
        const onTimeout = () => ctrl.abort();
        timeout.addEventListener("abort", onTimeout, { once: true });
        const r = await runtime.handle(
          { bot, from: "user", text: userText, sessionId: sid, history: store.listMessages(sid).slice(-200) },
          {
            signal: ctrl.signal,
            skipUserRecord: true,
            extraSystem: `${extra}\n\n${instructionsFor(sid)}`,
            meta: { webhook: true, priority },
          },
        );
        statuses.set(bot.id, { botId: bot.id, state: "idle", lastRunAt: Date.now() });
        attention();
        const preview = (r.text || userText).replace(/```tool[\s\S]*?```/g, "").trim().slice(0, 120);
        if (priority === "urgent") {
          void deliverNotification({
            title: parsed.title || `🚨 ${bot.name}`,
            body: preview || "紧急 Webhook 已完成",
            sessionId: sid,
          });
          pushPetEvent(bot.id, {
            type: "task-done",
            title: parsed.title || `紧急 · ${task.name}`,
            text: preview,
            rich: r.content,
            sessionId: sid,
          });
        } else {
          pushPetEvent(bot.id, {
            type: "task-done",
            title: task.name,
            text: preview,
            rich: r.content,
            sessionId: sid,
          });
        }
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        if (!/abort|停止/i.test(err)) {
          statuses.set(bot.id, { botId: bot.id, state: "error", lastError: err });
          store.addMessage({
            sessionId: sid,
            from: bot.id,
            to: "user",
            role: "assistant",
            content: `❌ 入站 Webhook 处理失败：${err}`,
            kind: "chat",
            createdAt: Date.now(),
            meta: { webhook: true, priority },
          });
          if (priority === "urgent") {
            void deliverNotification({ title: `${bot.name} · Webhook 失败`, body: err.slice(0, 120), sessionId: sid });
          }
        }
      } finally {
        if (activeSession.get(bot.id) === sid) activeSession.delete(bot.id);
        if (inflight.get(sid) === ctrl) inflight.delete(sid);
      }
    });
  };

  if (!EVAL_MODE) {
    void syncCloudInboundRegistrations();
    setInterval(() => { void pollCloudInboundOnce(); }, 2500);
    setTimeout(() => { void pollCloudInboundOnce(); }, 1500);
    setInterval(() => { void syncCloudInboundRegistrations(); }, 6 * 60 * 60_000);
  }

  /** 例行结果写入该 bot 可见单聊（Grok Routines in transcript）；执行历史仍在 sched-* */
  function resolveRoutineTranscript(task: ScheduledTask): string {
    const picked = pickRoutineTranscriptSessionId({
      pinned: task.sessionId,
      gazed: activeSession.get(task.botId),
      sessionExists: (id) => !!store.getSession(id),
      recentSessions: store.listSessionsPage({ botId: task.botId, limit: 20 }).sessions,
    });
    if (picked) return picked;
    const sid = `s-routine-${task.botId}`;
    store.ensureSession(sid, task.botId, "例行");
    return sid;
  }

  // 定时任务：到期时唤醒对应 bot（走运行时）
  scheduler.onRun = async (task) => {
    const bot = store.getBot(task.botId);
    if (!bot) throw new Error(`例行所属 bot 已删除（${task.botId}）`);
    // 同一个任务每次运行都记在同一个会话里，不会每跑一次多一个会话
    const sid = `sched-${task.id}`;
    // 结果一定进该 bot 对话（钉死会话 / 注视会话 / 最近单聊 / 兜底「例行」会话）
    const replySid = resolveRoutineTranscript(task);
    try {
      statuses.set(task.botId, { botId: task.botId, state: "running", lastRunAt: Date.now(), currentTask: `⏰ ${task.name}` });
      const limit = AbortSignal.timeout(15 * 60_000);
      const text = `${task.prompt ?? task.name}\n\n（这是例行「${task.name}」，现在到点了。你的回复会直接显示在和用户的聊天里：直接对用户说要提醒的内容或任务结果，不要说「我来发通知」之类的过程话，也不用调用 notify，系统会自动弹通知。）`;
      const r = await runtime.handle(
        { bot, from: "scheduler", text, sessionId: sid, history: store.listMessages(sid).slice(-20) },
        { signal: limit, unattended: true },
      );
      if (limit.aborted) throw new Error("运行超过 15 分钟，已停止");
      statuses.set(task.botId, { botId: task.botId, state: "idle", lastRunAt: Date.now() });
      const reply = r.text.replace(/```tool[\s\S]*?```/g, "").trim() || task.name;
      store.addMessage({
        sessionId: replySid,
        from: "system",
        to: "user",
        role: "assistant",
        content: `⏰ 例行「${task.name}」已跑完`,
        kind: "event",
        createdAt: Date.now(),
        meta: { scheduled: task.name },
      });
      store.addMessage({
        sessionId: replySid,
        from: bot.id,
        to: "user",
        role: "assistant",
        content: [{ type: "text", text: reply }],
        kind: "chat",
        createdAt: Date.now(),
        meta: { scheduled: task.name },
      });
      attention();
      const xp = bot.petEnabled ? grantPetXp(task.botId, 20) : undefined;
      pushPetEvent(task.botId, { type: "task-done", title: task.name, text: r.text.slice(0, 120), rich: r.content, sessionId: replySid, model: bot.model || providers.get(bot.providerId)?.model || providers.getDefault()?.model, xp });
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      statuses.set(task.botId, { botId: task.botId, state: "error", lastError: err });
      store.addMessage({
        sessionId: replySid,
        from: "system",
        to: "user",
        role: "assistant",
        content: `❌ 例行「${task.name}」失败：${err.slice(0, 200)}`,
        kind: "event",
        createdAt: Date.now(),
        meta: { scheduled: task.name },
      });
      attention();
      pushPetEvent(task.botId, { type: "task-error", title: task.name, text: err.slice(0, 120), sessionId: replySid });
      throw e;
    }
  };
  scheduler.onAlarm = (task) => {
    const bot = store.getBot(task.botId);
    if (!bot) return;
    // 要执行 prompt 的任务由 onRun 发结果，这里不重复弹
    if (!task.runPrompt) void system.notify(`⏰ ${bot.name} 提醒`, task.name);
    pushPetEvent(task.botId, {
      type: "alarm",
      title: task.name,
      text: task.prompt ?? "时间到啦！⏰",
      sessionId: task.sessionId,
    });
  };
  // 创建 / 删除 / 到期自动删 后刷新右栏定时任务列表
  scheduler.onChange = () => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("app:changed", "tasks");
  };
  if (EVAL_MODE) { void runEvalMode({ home, store, groups, providers, runtime, consent, exit: (code) => app.exit(code) }); return; }
  scheduler.start();

  // 主动跟进：有真实的悬而未决的事才开口（prefs.pet.proactiveFollowup 可关）
  const tickProactive = () => {
    if (!readPetPrefs().proactiveFollowup) return;
    void proactive.tick().catch((e) => console.error("[proactive]", e));
  };
  setTimeout(tickProactive, 2 * 60_000);
  setInterval(tickProactive, 5 * 60_000);
  // 轻量陪伴 / 空闲做事 / 自动换装（由 prefs.pet 闸门）
  const tickCompanion = () => { void companion.tick().catch((e) => console.error("[companion]", e)); };
  setTimeout(tickCompanion, 3 * 60_000);
  setInterval(tickCompanion, 10 * 60_000);
  // 自进化：低频观察 → 模型提议（失败规则兜底）或 autoEvolve 自动接受
  setTimeout(() => { void petEvolve.tick().catch((e) => console.error("[pet-evolve]", e)); }, 8 * 60_000);
  setInterval(() => { void petEvolve.tick().catch((e) => console.error("[pet-evolve]", e)); }, 30 * 60_000);
  // 多宠互访：约每 15 分钟试一次（台词优先模型）
  setTimeout(() => { void petVisit.tick().then((r) => { if (r) stagePetVisit(r); }).catch((e) => console.error("[pet-visit]", e)); }, 12 * 60_000);
  setInterval(() => { void petVisit.tick().then((r) => { if (r) stagePetVisit(r); }).catch((e) => console.error("[pet-visit]", e)); }, 15 * 60_000);

  // Dock / 点系统通知（含 osascript 兜底）都会 activate：打开主面板，别只露出宠物白窗
  app.on("activate", () => focusMainPanel());
});

// ---- IPC：主控面板 / 宠物调用 core ----
ipcMain.handle("bots:list", () => store.listBots());
ipcMain.handle("bots:previews", () => {
  const out: Record<string, { text: string; at: number; running: boolean }> = {};
  for (const b of store.listBots()) {
    const s = store.listSessionsPage({ botId: b.id, limit: 20 }).sessions.find((x) => isB2bSession(x.id) ? x.id.endsWith(`-${b.id}`) : !/^(plan|sched)-/.test(x.id));
    const last = s ? store.listMessages(s.id).findLast((m) => m.kind !== "event") : undefined;
    const asker = s && isB2bSession(s.id) ? store.getBot(s.id.slice(4, -(b.id.length + 1)))?.name ?? "另一个 bot" : null;
    const raw = (asker ? `🤝 ${asker}：` : "") + (last ? (typeof last.content === "string" ? last.content : last.content.map((c: any) => c.text ?? "").join(" ")) : "");
    out[b.id] = { text: raw.replace(/\[([^\]]+)\]\((?:app:|https?:)[^)]*\)/g, "$1").replace(/\s+/g, " ").slice(0, 60), at: last?.createdAt ?? s?.updatedAt ?? 0, running: statuses.get(b.id)?.state === "running" };
  }
  return out;
});
ipcMain.handle("bots:draft", async (_e, text: string) => registry.draftFromText(text));
ipcMain.handle("bots:create", async (_e, text: string, opts?: { name?: string; role?: string; persona?: string; systemPrompt?: string; avatar?: Bot["avatar"] }) => {
  let bot = await registry.createBotFromText(text, { defaultProviderId: providers.getDefault()?.id });
  const taken = new Set(store.listBots().filter((b) => b.id !== bot.id).map((b) => b.name));
  let name = opts?.name?.trim() || bot.name;
  for (let i = 2; taken.has(name); i++) name = `${(opts?.name?.trim() || bot.name)} ${i}`;
  const patch: Partial<Bot> = {};
  if (name !== bot.name) patch.name = name;
  if (opts?.avatar) patch.avatar = opts.avatar;
  if (opts?.role?.trim()) patch.role = opts.role.trim();
  if (opts?.persona?.trim()) patch.persona = opts.persona.trim();
  if (opts?.systemPrompt?.trim()) patch.systemPrompt = opts.systemPrompt.trim();
  if (Object.keys(patch).length) bot = registry.updateBot(bot.id, patch) ?? bot;
  bus.register(bot.id, defaultHandler);
  const welcomeSessionId = seedBotWelcome(store, bot);
  // 默认出台：创建完就现身，不用再开关「打开宠物」
  if (bot.petEnabled && !EVAL_MODE) createPetWindow(bot.id);
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("bot:created", { botId: bot.id, sessionId: welcomeSessionId });
  return { ...bot, welcomeSessionId };
});
ipcMain.handle("bots:update", (_e, id: string, patch: {
  name?: string; role?: string; persona?: string; providerId?: string; isMaster?: boolean; order?: number;
  pinned?: boolean; hidden?: boolean; section?: string | null; disabledSkills?: string[] | null;
  avatar?: Bot["avatar"]; reasoning?: Bot["reasoning"]; agentCwd?: string | null; dropAgentCwd?: string | null;
  agentCli?: Bot["agentCli"] | null; agentResume?: Bot["agentResume"] | null;
}) => {
  const bot = store.getBot(id);
  if (!bot) throw new Error("bot 不存在");
  if (patch.isMaster) {
    for (const b of store.listBots()) if (b.id !== id && b.isMaster) store.saveBot({ ...b, isMaster: false });
  }
  const next = { ...bot };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error("名字不能为空");
    const clash = store.listBots().find((b) => b.id !== id && b.name === name);
    if (clash) throw new Error(`已经有叫「${name}」的 bot`);
    next.name = name;
  }
  if (patch.role !== undefined) next.role = patch.role.trim();
  if (patch.persona !== undefined) next.persona = patch.persona.trim();
  if (patch.providerId !== undefined) next.providerId = patch.providerId;
  if (patch.isMaster !== undefined) next.isMaster = patch.isMaster;
  if (patch.order !== undefined) next.order = patch.order;
  if (patch.pinned !== undefined) {
    if (patch.pinned) next.pinned = true;
    else delete next.pinned;
  }
  if (patch.hidden !== undefined) {
    if (patch.hidden) next.hidden = true;
    else delete next.hidden;
  }
  if (patch.section !== undefined) {
    const s = typeof patch.section === "string" ? patch.section.trim() : "";
    if (s) next.section = s;
    else delete next.section;
  }
  if (patch.disabledSkills !== undefined) {
    const keys = Array.isArray(patch.disabledSkills) ? [...new Set(patch.disabledSkills.map(String).filter(Boolean))] : [];
    if (keys.length) next.disabledSkills = keys;
    else delete next.disabledSkills;
  }
  if (patch.reasoning && ["auto", "always", "off"].includes(patch.reasoning)) next.reasoning = patch.reasoning;
  if (patch.avatar) { next.avatar = patch.avatar; delete next.avatarPath; }
  if (typeof patch.dropAgentCwd === "string" && patch.dropAgentCwd.trim()) {
    const dropped = dropCodingDir(next, patch.dropAgentCwd);
    if (dropped.agentCwd) next.agentCwd = dropped.agentCwd;
    else delete next.agentCwd;
    if (dropped.agentDirs?.length) next.agentDirs = dropped.agentDirs;
    else delete next.agentDirs;
  } else if (typeof patch.agentCwd === "string" && patch.agentCwd.trim()) {
    const gazed = gazeCodingDir(next, patch.agentCwd);
    next.agentCwd = gazed.agentCwd;
    next.agentDirs = gazed.agentDirs;
  }
  if (patch.agentCli !== undefined) {
    if (!patch.agentCli) delete next.agentCli;
    else {
      const id = String(patch.agentCli).trim().toLowerCase();
      if (id) next.agentCli = id;
      else delete next.agentCli;
    }
  }
  if (patch.agentResume !== undefined) {
    if (!patch.agentResume || patch.agentResume === "auto") delete next.agentResume;
    else if (patch.agentResume === "always" || patch.agentResume === "once") next.agentResume = patch.agentResume;
  }
  store.saveBot(next);
  return next;
});
function avatarDataUrl(path: string | undefined, maxSide?: number): string | undefined {
  if (!path) return undefined;
  if (path.startsWith("data:")) return path;
  if (!existsSync(path)) return undefined;
  const img = nativeImage.createFromPath(path);
  if (img.isEmpty()) return undefined;
  if (!maxSide) return `data:image/png;base64,${img.toPNG().toString("base64")}`;
  const { width, height } = img.getSize();
  const scaled = width > maxSide || height > maxSide ? img.resize(width >= height ? { width: maxSide, quality: "best" } : { height: maxSide, quality: "best" }) : img;
  return `data:image/jpeg;base64,${scaled.toJPEG(85).toString("base64")}`;
}
function localNeedsReady(botId?: string) {
  return {
    secretNames: secrets.list(botId).map((s) => s.name),
    envKeys: (botId ? env.visibleTo(botId) : env.list()).map((e) => e.key),
    mcpNames: mcpManage.list().map((m) => m.name),
    skills: skills.list().flatMap((s) => [s.name, s.key]),
  };
}

function needsForBot(bot: Bot) {
  const privateSkills = skills.list().filter((k) => k.owner === bot.id);
  const sharedSkills = skills.list().filter((k) => !k.owner);
  return collectNeeds({
    privateSkills,
    sharedSkills,
    vault: {
      secrets: secrets.list(bot.id),
      env: env.visibleTo(bot.id),
      mcp: mcpManage.list().map((m) => ({ id: m.id, name: m.name })),
    },
    // 账号级保险库：botId 已不作 ACL；用 savedBy 归因「谁收录」进分享 needs
    ownedSecrets: secrets.list(bot.id).filter((s) => s.savedBy === bot.id).map((s) => ({ name: s.name, label: s.label, note: s.note })),
    ownedEnv: env.visibleTo(bot.id).filter((e) => e.botId === bot.id),
  });
}

function botTemplate(id: string, avatarSide?: number): BotTemplate {
  const bot = store.getBot(id);
  if (!bot) throw new Error("bot 不存在");
  const own = skills.list().filter((k) => k.owner === bot.id).map((k) => ({ name: k.name, description: k.description, body: k.body }));
  return templateOf(bot, own, avatarDataUrl(bot.avatarPath, avatarSide), needsForBot(bot));
}
function createFromTemplate(t: BotTemplate, name = t.name, opts?: { onboard?: boolean }): Bot {
  const id = randomUUID();
  let avatarPath: string | undefined;
  const m = t.avatar?.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/);
  if (m) {
    mkdirSync(assetsDir, { recursive: true });
    avatarPath = join(assetsDir, `${id}.${m[1] === "jpeg" ? "jpg" : m[1]}`);
    writeFileSync(avatarPath, Buffer.from(m[2], "base64"));
  }
  const needs = t.needs;
  const doOnboard = opts?.onboard !== false;
  const bot: Bot = {
    id, name: uniqueBotName(name, store.listBots().map((b) => b.name)), role: t.role, persona: t.persona, systemPrompt: t.systemPrompt,
    personaCard: t.personaCard, skinId: t.skinId, avatarPath, providerId: "", petEnabled: false, createdAt: Date.now(),
    shareOnboard: doOnboard && hasNeeds(needs) ? needs : undefined,
  };
  if (!avatarPath) bot.avatar = t.shape ?? defaultAvatar(id);
  store.saveBot(bot);
  for (const k of t.skills) skills.save({ ...k, owner: id });
  bus.register(bot.id, defaultHandler);
  if (doOnboard) {
    const diff = diffNeeds(needs, localNeedsReady(id));
    const sid = `s-${Date.now()}`;
    store.ensureSession(sid, bot.id, "开箱");
    store.addMessage({
      sessionId: sid,
      from: "system",
      to: "user",
      role: "assistant",
      content: [{ type: "text", text: onboardGreeting(bot.name, needs ?? { secrets: [], env: [] }, diff) }],
      kind: "event",
      createdAt: Date.now(),
    });
  }
  return bot;
}
ipcMain.handle("bots:duplicate", (_e, id: string) => {
  const t = botTemplate(id);
  // 本机副本：不带开箱会话（依赖已在本机）
  return createFromTemplate(t, `${t.name} 副本`, { onboard: false });
});
/** 分享链接复制到剪贴板，同时在「下载」里存一份 .harnessbot 文件（链接太长发不出去时发文件） */
ipcMain.handle("bots:share", async (_e, id: string) => {
  const t = botTemplate(id, 192);
  const link = templateLink(t);
  const file = join(app.getPath("downloads"), `${t.name.replace(/[\\/:*?"<>|]/g, "_")}.${TEMPLATE_EXT}`);
  writeFileSync(file, JSON.stringify(t, null, 2), "utf8");
  let shortUrl: string | undefined;
  let shortError: string | undefined;
  if (shareBridgeCreds()) {
    try {
      const short = await putHarnessShortLink(link, { name: t.name, role: t.role });
      shortUrl = short.url;
      clipboard.writeText(short.url);
    } catch (e) {
      shortError = e instanceof Error ? e.message : String(e);
      clipboard.writeText(link);
    }
  } else {
    clipboard.writeText(link);
  }
  return {
    link,
    shortUrl,
    shortError,
    file,
    skills: t.skills.length,
    chars: link.length,
    needs: t.needs ?? null,
    needCounts: {
      secrets: t.needs?.secrets.length ?? 0,
      env: t.needs?.env.length ?? 0,
      commands: t.needs?.commands?.length ?? 0,
      mcp: t.needs?.mcp?.length ?? 0,
      sharedSkills: t.needs?.sharedSkills?.length ?? 0,
    },
  };
});
ipcMain.handle("bots:parseTemplate", async (_e, input: string) => parseTemplate(await resolveTemplateInput(input)));
ipcMain.handle("bots:diffNeeds", (_e, needs: unknown): NeedsDiff => {
  const t = normalizeTemplate({ v: 2, name: "_", role: "", persona: "", skills: [], needs });
  return diffNeeds(t.needs, localNeedsReady());
});
ipcMain.handle("bots:pickTemplate", async () => {
  const r = await dialog.showOpenDialog(mainWin!, { title: "导入 bot 模板", properties: ["openFile"], filters: [{ name: "Harness Bot 模板", extensions: [TEMPLATE_EXT, "json"] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  return parseTemplate(readFileSync(r.filePaths[0], "utf8"));
});
ipcMain.handle("bots:importTemplate", (_e, raw: unknown) => createFromTemplate(normalizeTemplate(raw), undefined, { onboard: true }));

ipcMain.handle("bots:delete", (_e, id: string) => {
  registry.deleteBot(id);
  bus.unregister(id);
  petWins.get(id)?.close();
  petWins.delete(id);
  forgetPetSideState(id);
  updateTrayIcon();
});
ipcMain.handle("bots:setPet", (_e, id: string, enabled: boolean) => {
  registry.setPetEnabled(id, enabled);
  if (enabled) {
    createPetWindow(id, { forceShow: true });
    persistPetVisible(id, true);
  } else {
    const w = petWins.get(id);
    if (w && !w.isDestroyed()) w.close();
    petWins.delete(id);
    persistPetVisible(id, false);
  }
  updateTrayIcon();
});
/** 暂时藏起来：只 hide 窗口并记 visible=false，不关 petEnabled——托盘「全部显示」即可回来 */
ipcMain.handle("pets:hide", (_e, botId?: string) => { hidePetWindow(botId); });
ipcMain.handle("pets:show", (_e, botId?: string) => { showPetWindow(botId); });
ipcMain.handle("pets:visit", async (_e, fromId: string, toId: string) => {
  if (!readPetPrefs().petVisit) throw new Error("已关闭多宠互访。可在「桌面宠物智能」里打开。");
  const rec = await runPetVisit(fromId, toId, true);
  if (!rec) throw new Error("拜访失败（对方需已开启桌宠）");
  return rec;
});
ipcMain.handle("pets:visitHistory", (_e, botId?: string) => petVisit.list(botId));
ipcMain.handle("pet:evolveHistory", (_e, botId?: string) =>
  petEvolve.listHistory(botId).map((p) => ({
    id: p.id, botId: p.botId, kind: p.kind, title: p.title, detail: p.detail,
    status: p.status, createdAt: p.createdAt,
  })));
ipcMain.handle("pets:peers", (_e, botId: string) =>
  store.listBots().filter((b) => b.id !== botId && b.petEnabled).map((b) => ({ id: b.id, name: b.name })));
registerSkinsIpc({ petSkins, assetsDir });
ipcMain.handle("bots:setSkin", (_e, id: string, skinId: string) => applyBotSkin(id, skinId));

async function executePetIntent(botId: string, intent: PetIntent): Promise<{ handled: boolean; message?: string; chat?: boolean }> {
  const bot = store.getBot(botId);
  if (!bot) throw new Error("bot 不存在");
  switch (intent.type) {
    case "chat":
      return { handled: false, chat: true };
    case "setSkin": {
      applyBotSkin(botId, intent.skinId, intent.label);
      return { handled: true, message: `已换上「${intent.label}」。` };
    }
    case "installPetdex": {
      const pets = await fetchPetdexManifest(join(assetsDir, "skins"));
      const entry = pets.find((p) => p.slug === intent.slug);
      if (!entry) throw new Error(`petdex 上找不到 ${intent.slug}`);
      const id = petdexSkinId(entry.slug);
      if (!petSkins.get(id)) {
        const skin = await installPetdex(entry, assetsDir, intent.name);
        petSkins.register(skin);
      }
      applyBotSkin(botId, id, intent.name);
      return { handled: true, message: `已从形象库换上「${intent.name}」。` };
    }
    case "generatePersona": {
      const result = await resolveAppearance(botId, intent.desc, intent.style);
      return { handled: true, message: result.message };
    }
    case "updatePersona": {
      store.saveBot({ ...bot, persona: intent.persona });
      return { handled: true, message: `人设已更新：${intent.persona.slice(0, 60)}` };
    }
    case "setPace": {
      // 单宠口令只改该宠覆盖，避免一只「安静」拖垮全体
      const all = store.readConfig();
      const prev = (all.prefs as Record<string, unknown> | undefined) || {};
      const patch: Partial<PetPrefs> = {};
      if (intent.companionChat !== undefined) patch.companionChat = intent.companionChat;
      if (intent.idleWork !== undefined) patch.idleWork = intent.idleWork;
      if (intent.autoAppearance !== undefined) patch.autoAppearance = intent.autoAppearance;
      store.writeConfig({ ...all, prefs: patchPetBotPrefs(prev, botId, patch) });
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("app:changed", "pet-prefs");
      const w = petWins.get(botId);
      if (w && !w.isDestroyed()) w.webContents.send("app:changed", "pet-prefs");
      return { handled: true, message: intent.note };
    }
    case "remind": {
      const at = Date.now() + Math.max(5_000, intent.delayMs);
      scheduler.create({
        botId,
        name: intent.text.slice(0, 40) || "提醒",
        cron: "0 0 1 1 *",
        kind: "once",
        alarmAt: at,
        notifyPet: true,
        runPrompt: false,
        deleteAfterRun: true,
        prompt: intent.text,
      });
      const mins = Math.round(intent.delayMs / 60_000);
      return { handled: true, message: `好，大约 ${mins < 1 ? "不到 1 分钟" : mins + " 分钟"}后提醒你：${intent.text}` };
    }
    case "revertSkin": {
      if (!bot.prevSkinId) return { handled: true, message: "没有可恢复的上一套形象。" };
      const back = bot.prevSkinId;
      applyBotSkin(botId, back);
      return { handled: true, message: "已换回上一套形象。" };
    }
    case "evolveAccept": {
      const p = petEvolve.acceptLatest(botId);
      if (!p) return { handled: false, chat: true }; // 没有待确认提议时，「好」走普通对话
      return { handled: true, message: `好，已接受：${p.title}` };
    }
    case "evolveReject": {
      const p = petEvolve.rejectLatest(botId);
      if (!p) return { handled: false, chat: true };
      return { handled: true, message: `好，先不改：${p.title}` };
    }
    case "act": {
      const plan = resolveMotion(intent.action, {
        holdSec: intent.holdSec,
        traits: { blob: traitsBlob(bot) },
      });
      pushPetEvent(botId, { type: "action", action: plan.action, hold: plan.holdSec, motion: plan });
      return { handled: true, message: intent.note };
    }
    case "script": {
      schedulePetScript(botId, intent.beats);
      return { handled: true, message: intent.note };
    }
    case "fx": {
      const beats = expandPhraseToBeats(intent.phrase);
      if (beats && beats.length > 1) {
        schedulePetScript(botId, beats);
        return { handled: true, message: `好，来一段「${intent.phrase.slice(0, 16)}」～` };
      }
      const { message } = await resolveAndPlayFx(botId, intent.phrase);
      return { handled: true, message };
    }
    case "visit": {
      if (!readPetPrefs().petVisit) return { handled: true, message: "多宠互访还没打开，去设置里开一下。" };
      const peer = store.listBots().find((b) => b.name === intent.peerName || b.name.includes(intent.peerName));
      if (!peer) return { handled: true, message: `找不到伙伴「${intent.peerName}」。` };
      const rec = await runPetVisit(botId, peer.id, true);
      if (!rec) return { handled: true, message: "现在去不了，稍后再试。" };
      return { handled: true, message: rec.lineFrom };
    }
    default:
      return { handled: false, chat: true };
  }
}

async function resolvePetIntents(botId: string, text: string): Promise<{ intents: PetIntent[]; via: "rule" | "model" | "chat" }> {
  const bot = store.getBot(botId);
  if (!bot) throw new Error("bot 不存在");
  const ctx = {
    text: String(text || "").trim(),
    skins: petSkins.list().map((s) => ({ id: s.id, name: s.name })),
    skinId: bot.skinId,
    prevSkinId: bot.prevSkinId,
    peers: store.listBots().filter((b) => b.id !== botId && b.petEnabled).map((b) => ({ id: b.id, name: b.name })),
  };
  if (!ctx.text) return { intents: [{ type: "chat", text: "" }], via: "chat" };

  const rule = parsePetIntentsRule(ctx);
  if (rule?.length) return { intents: rule, via: "rule" };

  if (shouldUseDirectorModel(ctx.text, rule)) {
    const provider = providers.get(bot.providerId) || providers.getDefault();
    if (provider) {
      try {
        const r = await providers.complete(provider, {
          model: providers.get(bot.providerId) ? bot.model : undefined,
          system: directorSystemPrompt(ctx),
          user: directorUserPrompt(ctx.text),
          signal: AbortSignal.timeout(18_000),
        });
        const parsed = parseDirectorIntents(r.text || "", ctx);
        if (parsed?.length) {
          const actions = parsed.filter((i) => i.type !== "chat");
          if (actions.length) return { intents: actions, via: "model" };
          return { intents: [{ type: "chat", text: ctx.text }], via: "chat" };
        }
      } catch (e) {
        console.error("[pet.direct.model]", e);
      }
    }
  }

  const one = parsePetIntent(ctx);
  return { intents: [one], via: one.type === "chat" ? "chat" : "rule" };
}

async function executePetIntents(botId: string, intents: PetIntent[]): Promise<{ handled: boolean; message?: string; chat?: boolean; intent: string }> {
  const actionable = intents.filter((i) => i.type !== "chat");
  if (!actionable.length) {
    return { handled: false, chat: true, intent: "chat" };
  }
  const notes: string[] = [];
  let anyHandled = false;
  for (const intent of actionable) {
    const r = await executePetIntent(botId, intent);
    if (r.handled) {
      anyHandled = true;
      if (r.message) notes.push(r.message);
    } else if (r.chat && actionable.length === 1) {
      return { handled: false, chat: true, intent: intent.type };
    }
  }
  return {
    handled: anyHandled,
    message: notes.join(" ") || "好的。",
    intent: actionable.map((i) => i.type).join("+"),
  };
}

ipcMain.handle("pet:direct", async (_e, botId: string, text: string) => {
  const { intents, via } = await resolvePetIntents(botId, text);
  const r = await executePetIntents(botId, intents);
  if (r.handled || via !== "chat") touchUserActivity();
  return { ...r, via };
});
ipcMain.handle("persona:generate", async (_e, id: string, desc: string, style?: "default" | "pixel" | "cute") => {
  if (!store.getBot(id)) throw new Error("bot 不存在");
  return resolveAppearance(id, desc, style);
});
ipcMain.handle("chat:send", async (_e, botId: string, text: string, sessionId?: string) => {
  const bot = store.getBot(botId);
  if (!bot) throw new Error("bot 不存在");
  return bus.chat(bot, text, sessionId);
});
ipcMain.handle("chat:sendStream", async (_e, botId: string, content: string | import("../core/types").ContentBlock[], sessionId?: string, opts?: { think?: boolean; projectId?: string | null }) => {
  const bot = store.getBot(botId);
  if (!bot) throw new Error("bot 不存在");
  const sid = sessionId || `s-${Date.now()}`;
  const projectId = opts?.projectId !== undefined ? opts.projectId : store.getSession(sid)?.projectId ?? null;
  const text = typeof content === "string" ? content : (content.filter((b) => b.type === "text").map((b) => (b as any).text ?? "").join(""));
  statuses.set(botId, { botId, state: "running", lastRunAt: Date.now(), currentTask: text.slice(0, 60) });
  const push = (b: import("../core/types").ContentBlock) => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("chat:stream", { ...b, sessionId: sid, botId });
  };
  const ctrl = new AbortController();
  const prev = inflight.get(sid);
  if (prev && prev !== ctrl) prev.abort();
  inflight.set(sid, ctrl);
  activeSession.set(botId, sid);
  consentNotes.set(sid, []);
  try {
    const r = await runtime.handleStream(
      { bot, from: "user", text, content: content as any, sessionId: sid, history: store.listMessages(sid).slice(-200) },
      { onBlock: push, signal: ctrl.signal, think: !!opts?.think, extraSystem: instructionsFor(sid, projectId) },
    );
    if (opts?.projectId !== undefined) store.setSessionProject(sid, projectId);
    settleBotStatus(botId, r.content, sid);
    if (!ctrl.signal.aborted) void suggestFollowUps(sid, botId, text, r.text);
    if (bot.petEnabled) {
      const xp = grantPetXp(botId, 10);
      pushPetEvent(botId, { type: "reply", text: r.text.slice(0, 120), rich: r.content, sessionId: sid, model: bot.model || providers.get(bot.providerId)?.model || providers.getDefault()?.model, xp });
    } else {
      pushPetEvent(botId, { type: "reply", text: r.text.slice(0, 120), rich: r.content, sessionId: sid });
    }
    return { ok: true, sessionId: sid, result: r };
  } catch (e) {
    statuses.set(botId, { botId, state: "error", lastRunAt: Date.now(), lastError: e instanceof Error ? e.message : String(e) });
    const err = e instanceof Error ? e.message : String(e);
    const liveTerm = codingPresence.snapshot(botId);
    const termNote = liveTerm && liveTerm.phase !== "exited"
      ? `\n编码终端还开着（${liveTerm.cwd}），这轮只是对话断了，终端没有关掉。`
      : "";
    if (!runtime.failLive(botId, sid, `❌ 回复失败：${err}${termNote}`)) {
      store.addMessage({ sessionId: sid, from: "user", to: botId, role: "user", content: content as any, kind: "chat", createdAt: Date.now() });
      store.addMessage({ sessionId: sid, from: botId, to: "user", role: "assistant", content: `❌ 回复失败：${err}${termNote}`, kind: "chat", createdAt: Date.now() });
    }
    throw e;
  } finally {
    flushConsentNotes(sid);
    if (activeSession.get(botId) === sid) activeSession.delete(botId);
    if (inflight.get(sid) === ctrl) inflight.delete(sid);
  }
});
ipcMain.handle("chat:cancel", (_e, sessionId: string) => { inflight.get(sessionId)?.abort(); });

/** 回复结束后挂软选项 / 追问建议。优先用正文里已写清的方案列表，避免和硬卡重复 */
async function suggestFollowUps(sid: string, botId: string, question: string, answer: string) {
  if ((store.readConfig().prefs as { suggestions?: boolean } | undefined)?.suggestions === false) return;
  if (sid.startsWith("group-") || sid.startsWith("b2b-")) return;
  const reply = answer.replace(/```tool[\s\S]*?```/g, "").trim();
  if (reply.length < 12 || reply.startsWith("❌") || reply.includes("（已停止生成）")) return;
  const msg = store.listMessages(sid).findLast((m) => m.from === botId && m.role === "assistant");
  if (!msg?.id || (Array.isArray(msg.content) && msg.content.some((b) => b.type === "choice" || b.type === "secret" || b.type === "form"))) return;
  // runtime 层 2 已写入方案芯片：只补推 UI，不再用模型另造追问盖掉
  const existing = msg.meta?.suggestions?.filter(Boolean) ?? [];
  if (existing.length >= 2) {
    sendUi("chat:suggestions", { sessionId: sid, msgId: msg.id, suggestions: existing.slice(0, 4) });
    return;
  }
  const offer = detectChoiceOffer(reply);
  if (offer?.kind === "soft") {
    const suggestions = offer.options;
    store.updateMessage(sid, msg.id, (m) => ({ ...m, meta: { ...m.meta, suggestions } }));
    sendUi("chat:suggestions", { sessionId: sid, msgId: msg.id, suggestions });
    return;
  }
  if (offer?.kind === "hard") return; // 应已走 ui.ask；勿再挂软条干扰
  const bound = providers.get(store.getBot(botId)?.providerId ?? "");
  const p = bound?.kind === "openai-compat" ? bound : providers.list().find((x) => x.kind === "openai-compat" && x.isDefault) ?? providers.list().find((x) => x.kind === "openai-compat");
  if (!p) return; // CLI-only：无兼容端点时宁可不造追问，避免乱猜
  try {
    const r = await providers.complete(p, {
      system: "根据这轮对话，站在用户角度写 3 个最可能的下一步追问，每个不超过 22 个字，具体、不重复、不要客套。用对话的语言。只输出 JSON 字符串数组。不要复述回答里已经列过的方案选项。",
      user: `用户：${question.slice(0, 1500)}\n\n回答：${reply.slice(0, 3000)}`,
      temperature: 0.6,
    });
    const arr = JSON.parse(r.text.match(/\[[\s\S]*\]/)?.[0] ?? "[]");
    const suggestions = (Array.isArray(arr) ? arr : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 3);
    if (!suggestions.length) return;
    // 仍以最新消息为准，避免异步到达时盖掉用户已点选后的新回复
    const latest = store.listMessages(sid).findLast((m) => m.from === botId && m.role === "assistant");
    if (!latest?.id || latest.id !== msg.id) return;
    if (latest.meta?.suggestions?.length) return;
    store.updateMessage(sid, msg.id, (m) => ({ ...m, meta: { ...m.meta, suggestions } }));
    sendUi("chat:suggestions", { sessionId: sid, msgId: msg.id, suggestions });
  } catch {
    // 追问建议只是锦上添花，失败不提示
  }
}

/* ================= 附件 / 工作台 / 项目 / 自定义指令 / 分享 ================= */
const attachDir = join(workspace, "attachments");
ipcMain.handle("files:ingest", (_e, paths: string[]) => ingestFiles(paths, attachDir));
ipcMain.handle("files:pickAttachments", async () => {
  const r = await dialog.showOpenDialog(mainWin!, {
    title: "添加附件",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "支持的文件", extensions: ["png", "jpg", "jpeg", "gif", "webp", "heic", "pdf", "doc", "docx", "rtf", "odt", "xlsx", "xlsm", "csv", "tsv", "pptx", "md", "txt", "json", "yaml", "yml", "html", "xml", "js", "ts", "tsx", "jsx", "py", "swift", "go", "rs", "java", "kt", "c", "cpp", "h", "rb", "php", "sh", "sql", "log"] },
      { name: "所有文件", extensions: ["*"] },
    ],
  });
  return r.canceled ? [] : ingestFiles(r.filePaths, attachDir);
});
/** 工作台只能改 bot 工作区和附件里的文件 */
ipcMain.handle("files:save", (_e, path: string, content: string) => {
  const abs = join(path);
  if (!abs.startsWith(workspace + "/")) throw new Error("只能编辑 bot 工作区里的文件");
  writeFileSync(abs, content, "utf8");
  return { ok: true, size: Buffer.byteLength(content) };
});
const watchers = new Map<string, import("node:fs").FSWatcher>();
ipcMain.handle("files:watch", (_e, path: string, on: boolean) => {
  watchers.get(path)?.close();
  watchers.delete(path);
  if (!on || !existsSync(path)) return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  watchers.set(path, watch(path, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => sendUi("files:changed", path), 150);
  }));
});

ipcMain.handle("projects:list", () => projects.list());
ipcMain.handle("projects:create", (_e, name: string, instructions?: string) => projects.create(name, instructions));
ipcMain.handle("projects:update", (_e, id: string, patch: { name?: string; instructions?: string }) => projects.update(id, patch));
ipcMain.handle("projects:remove", (_e, id: string) => {
  projects.remove(id);
  for (const s of store.listSessionsPage({ limit: 10000 }).sessions) if (s.projectId === id) store.setSessionProject(s.id, null);
});
ipcMain.handle("projects:addFiles", async (_e, id: string) => {
  const r = await dialog.showOpenDialog(mainWin!, { title: "添加项目资料", properties: ["openFile", "multiSelections"] });
  return r.canceled ? projects.get(id) : projects.addFiles(id, r.filePaths);
});
ipcMain.handle("projects:removeFile", (_e, id: string, path: string) => projects.removeFile(id, path));
ipcMain.handle("sessions:setProject", (_e, sid: string, projectId: string | null) => store.setSessionProject(sid, projectId));

const UI_CONFIG_KEYS = new Set(["instructions", "imageGen", "prefs"]);
ipcMain.handle("config:get", (_e, key: "instructions" | "imageGen" | "prefs") => {
  if (!UI_CONFIG_KEYS.has(key)) throw new Error(`不支持的配置项：${key}`);
  const v = store.readConfig()[key] as Record<string, unknown> | undefined;
  return key === "imageGen" && v ? { ...v, apiKey: v.apiKey ? "***" : "" } : v ?? null;
});
ipcMain.handle("config:set", (_e, key: "instructions" | "imageGen" | "prefs", value: Record<string, unknown>) => {
  if (!UI_CONFIG_KEYS.has(key)) throw new Error(`不支持的配置项：${key}`);
  const all = store.readConfig();
  const prev = all[key] as Record<string, unknown> | undefined;
  let next: Record<string, unknown>;
  if (key === "prefs") next = mergePrefs(prev, value || {});
  else if (key === "imageGen" && value) {
    next = { ...value, apiKey: value.apiKey === "__keep__" ? prev?.apiKey ?? "" : value.apiKey ? keyCipher.encrypt(String(value.apiKey)) : "" };
  } else next = value;
  store.writeConfig({ ...all, [key]: next });
  if (key === "prefs") {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("app:changed", "pet-prefs");
    for (const w of petWins.values()) if (!w.isDestroyed()) w.webContents.send("app:changed", "pet-prefs");
  }
  return key === "prefs" ? next : undefined;
});

ipcMain.handle("pet:prefs", () => readPetPrefs());
ipcMain.handle("pet:activity", (_e, botId?: string, limit?: number) =>
  listPetActivity(home, { botId: botId || undefined, limit: limit ?? 30 }));
ipcMain.handle("pet:mind", (_e, botId: string) => {
  const mind = loadPetMindFor(botId);
  return mind ? { ...mind, prompt: formatMindForPrompt(mind) } : null;
});
/** 设置页「立即试跑」：忽略空闲/间隔，按已开开关跑一轮陪伴或互访 */
ipcMain.handle("pet:trial", async (_e, kind?: string) => {
  const k = kind || "auto";
  if (k === "visit" || (k === "auto" && readPetPrefs().petVisit)) {
    const pets = store.listBots().filter((b) => b.petEnabled && isPetShown(b.id));
    if (pets.length >= 2) {
      const rec = await runPetVisit(pets[0].id, pets[1].id, true);
      if (rec) return { ok: true, kind: "visit", message: `${rec.fromName} → ${rec.toName}` };
    }
    if (k === "visit") return { ok: false, message: "需要至少两只可见桌宠才能互访" };
  }
  if (k === "evolve" || (k === "auto" && readPetPrefs().selfEvolve)) {
    const p = await petEvolve.tick();
    if (p) return { ok: true, kind: "evolve", message: p.title };
    if (k === "evolve") return { ok: false, message: "暂无合适进化提议（可能今天已提过或缺少聊天）" };
  }
  const id = await companion.tick({ force: true });
  if (id) {
    const b = store.getBot(id);
    return { ok: true, kind: "companion", message: `${b?.name || id} 已行动` };
  }
  return { ok: false, message: "没有可行动的宠（需上台可见，且至少开一项：搭话/做事/换装）" };
});

registerShareIpc({ appRoot: APP_ROOT, store, groups });

/* ================= 群聊（逻辑在 core/group-session，这里只做宿主桥接） ================= */
ipcMain.handle("groups:chat", async (_e, groupId: string, content: string | ContentBlock[], sessionId?: string) => {
  const sid = sessionId || `group-${groupId}`;
  if (groupSessions.isLive(sid)) {
    const joined = await groupSessions.interject(groupId, sid, content);
    return { ok: joined.ok, sessionId: sid, joined: true, turns: 0, rounds: 0, reason: joined.ok ? "插进正在进行的接力" : "这段对话没有正在进行的接力" };
  }
  const ctrl = new AbortController();
  inflight.set(sid, ctrl);
  try {
    const r = await groupSessions.chat(groupId, content, sid, groupHooks(sid, ctrl));
    if (mainWin && !mainWin.isDestroyed() && !mainWin.isFocused()) {
      const body = r.conclusion && r.conclusion.type === "conclusion" ? r.conclusion.summary : contentText(r.lastText).replace(/\s+/g, " ").slice(0, 80);
      void deliverNotification({
        title: `群聊「${r.groupName}」讨论结束 · ${r.turns} 次发言`,
        body: body || r.reasonText,
        sessionId: sid,
        onClick: () => focusMainPanel(sid),
      });
    }
    return { ok: true, sessionId: r.sessionId, turns: r.turns, rounds: r.rounds, reason: r.reason };
  } finally {
    if (inflight.get(sid) === ctrl) inflight.delete(sid);
  }
});

ipcMain.handle("groups:interject", (_e, groupId: string, sessionId: string, content: string | ContentBlock[]) =>
  groupSessions.interject(groupId, sessionId, content));
ipcMain.handle("groups:gaze", (_e, groupId: string, sessionId: string | null) => {
  if (sessionId) groupGaze.set(groupId, sessionId);
  else groupGaze.delete(groupId);
});
ipcMain.handle("groups:peek", (_e, sessionId: string) => groupSessions.peek(sessionId));
ipcMain.handle("groups:board", (_e, sessionId: string) => groupSessions.boardOf(sessionId));

ipcMain.handle("groups:update", (_e, groupId: string, patch: { name?: string; members?: string[]; settings?: import("../core/group-registry").GroupSettings }) => groups.update(groupId, patch));

ipcMain.handle("groups:taskDone", (_e, sessionId: string, msgId: number, index: number, done: boolean) =>
  store.updateMessage(sessionId, msgId, (m) => ({
    ...m,
    content: Array.isArray(m.content) ? m.content.map((b) => (b.type === "conclusion" ? { ...b, tasks: b.tasks.map((t, i) => (i === index ? { ...t, done } : t)) } : b)) : m.content,
  })));

ipcMain.handle("groups:dispatch", async (_e, groupId: string, sessionId: string, msgId: number, indexes: number[]) => {
  if (groupSessions.isLive(sessionId)) return { ok: false as const, error: "这段对话还在接力，等它结束再执行分派" };
  const ctrl = new AbortController();
  inflight.set(sessionId, ctrl);
  try {
    return await groupSessions.dispatch(groupId, sessionId, msgId, indexes, groupHooks(sessionId, ctrl));
  } finally {
    if (inflight.get(sessionId) === ctrl) inflight.delete(sessionId);
  }
});

ipcMain.handle("bus:send", async (_e, fromId: string, toId: string, text: string) => {
  const from = store.getBot(fromId), to = store.getBot(toId);
  if (!from || !to) throw new Error("bot 不存在");
  return bus.send(from, to, text);
});
// G4：群组
ipcMain.handle("groups:list", (_e, botId?: string) => groups.list(botId));
ipcMain.handle("groups:create", (_e, name: string, members: string[], opts?: { settings?: import("../core/group-registry").GroupSettings; starterId?: string }) => {
  let g = groups.create(name, "user", members);
  if (opts?.settings) g = groups.update(g.id, { settings: opts.settings }) ?? g;
  const names = g.members.map((id) => store.getBot(id)?.name).filter((n): n is string => !!n);
  const welcomeSessionId = seedGroupWelcome(store, g, names, { starterId: opts?.starterId });
  return { ...g, welcomeSessionId };
});
ipcMain.handle("groups:join", (_e, groupId: string, botId: string) => groups.join(groupId, botId));
ipcMain.handle("groups:leave", (_e, groupId: string, botId: string) => groups.leave(groupId, botId));
ipcMain.handle("groups:remove", (_e, groupId: string) => {
  groupGaze.delete(groupId);
  return groups.remove(groupId);
});
ipcMain.handle("groups:broadcast", async (_e, groupId: string, fromId: string, text: string) => {
  const from = store.getBot(fromId);
  if (!from) throw new Error("发起 bot 不存在");
  return bus.broadcast(groupId, from, text);
});
// G5：授权 + 审计 + TCC
registerSecurityIpc({
  store, consent, audit, secrets, env, scheduler,
  gatewayInfo: () => gatewaySnapshot(),
});
ipcMain.handle("system:tcc", () => tccStatus());

const observeIconCache = new Map<string, string>();
async function fileIconDataUrl(path?: string | null): Promise<string | undefined> {
  if (!path || !existsSync(path)) return undefined;
  const hit = observeIconCache.get(path);
  if (hit) return hit;
  try {
    const img = await app.getFileIcon(path, { size: "normal" });
    if (img.isEmpty()) return undefined;
    const url = img.resize({ width: 64, height: 64 }).toDataURL();
    if (observeIconCache.size > 80) observeIconCache.clear();
    observeIconCache.set(path, url);
    return url;
  } catch {
    return undefined;
  }
}
async function decorateIdentityIcon(id: AppIdentity): Promise<AppIdentity & { iconDataUrl?: string }> {
  const iconDataUrl = await fileIconDataUrl(id.iconPath || id.bundlePath);
  return iconDataUrl ? { ...id, iconDataUrl } : id;
}

async function decorateProcessList(procs: ProcessHit[], lim = 16): Promise<ProcessHit[]> {
  const out: ProcessHit[] = [];
  for (const p of procs.slice(0, lim)) {
    const id = await decorateIdentityIcon(p.identity);
    out.push({ ...p, identity: id, iconDataUrl: id.iconDataUrl });
  }
  return out;
}

/** 全局快照（设置页备用）；bot 侧栏用 systemWatch:status */
ipcMain.handle("systemObserve:status", async () => {
  const snap = observeSystem(home, { includeCoding: true });
  const tcc = tccStatus();
  const servers = ((store.readConfig().mcpServers as Array<{ id?: string; enabled?: boolean }> | undefined) || []);
  const computerOn = servers.some((s) => s.id === COMPUTER_MCP_ID && s.enabled !== false);
  if (snap.frontmost.identity) {
    const id = await decorateIdentityIcon(snap.frontmost.identity);
    snap.frontmost.identity = id;
    snap.frontmost.iconDataUrl = id.iconDataUrl;
  }
  snap.processes = await decorateProcessList(snap.processes, 12);
  return {
    snap,
    text: formatObserveText(snap),
    caps: {
      observe: true,
      accessibility: !!tcc.accessibility,
      screen: !!tcc.screen,
      computerUse: computerOn,
    },
    tcc,
    tools: ["sys.observe", "sys.processes", "sys.disk", "sys.activity", "sys.scan", "sys.purge", "task.create"],
    hint: "在 bot 详情里勾选要听的 App；这里只看全局权限与磁盘。",
  };
});

ipcMain.handle("systemWatch:get", (_e, botId: string) => readBotWatch(store.readConfig(), String(botId || "")));
ipcMain.handle("systemWatch:set", (_e, botId: string, patch: Partial<BotSystemWatch>) => {
  const id = String(botId || "");
  if (!id || !store.getBot(id)) throw new Error("bot 不存在");
  const all = store.readConfig();
  const prev = (all.prefs as Record<string, unknown> | undefined) || {};
  const prefs = writeBotWatch(prev, id, patch || {});
  store.writeConfig({ ...all, prefs });
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("app:changed", "system-watch");
  return readBotWatch(store.readConfig(), id);
});
ipcMain.handle("systemWatch:installedApps", async () => {
  const rows = listInstalledApps(100);
  const out = [];
  for (const r of rows) {
    const id = await decorateIdentityIcon(r.identity);
    out.push({ name: r.name, path: r.path, brand: r.brand, mark: r.mark, iconDataUrl: id.iconDataUrl });
  }
  return out;
});
/** bot 详情：监听名单 + 轻量状态（不刷全机进程）。短缓存，切 bot 时不重复扫 ps / 前台应用 */
const watchStatusCache = new Map<string, { at: number; pending: Promise<unknown> }>();
async function buildWatchStatus(botId: string) {
  const id = String(botId || "");
  const watch = readBotWatch(store.readConfig(), id);
  const tcc = tccStatus();
  const keys = watchKeywords(watch);
  const [front, diskAll, procs] = await Promise.all([
    observeFrontmostAsync(),
    observeDiskAsync(),
    keys.length ? observeProcessesAsync(keys) : Promise.resolve([] as ProcessHit[]),
  ]);
  if (front.identity) {
    const di = await decorateIdentityIcon(front.identity);
    front.identity = di;
    front.iconDataUrl = di.iconDataUrl;
  }
  const disk = diskAll.filter((d) => d.mount === "/" || d.mount.includes("Data") || d.mount.startsWith("/Volumes/")).slice(0, 4);
  const watchedLive = keys.length ? await decorateProcessList(procs, 20) : [];
  // 名单里的 App：有没有在跑
  const apps = [];
  for (const name of watch.apps) {
    const live = watchedLive.filter((p) => {
      const hay = `${p.identity?.label || ""} ${p.command}`.toLowerCase();
      return hay.includes(name.toLowerCase()) || (p.identity?.brand && name.toLowerCase().includes(p.identity.brand));
    });
    const sample = live[0];
    const decorated = sample?.identity ? null : await decorateIdentityIcon(resolveAppIdentity({ command: name, displayHint: name }));
    const idn = sample?.identity || decorated;
    apps.push({
      name,
      running: live.length > 0,
      cpu: live.reduce((n, p) => n + (p.cpu || 0), 0),
      rssMb: Math.round(live.reduce((n, p) => n + (p.rssKb || 0), 0) / 1024),
      identity: idn,
      iconDataUrl: sample?.iconDataUrl || decorated?.iconDataUrl,
    });
  }
  const frontName = front.identity?.label || front.name || "";
  const watchingFront = !!(frontName && watch.apps.some((a) => frontName.toLowerCase().includes(a.toLowerCase()) || a.toLowerCase().includes(frontName.toLowerCase())));
  return {
    watch,
    front,
    disk,
    apps,
    caps: { accessibility: !!tcc.accessibility, screen: !!tcc.screen },
    summary: !watch.enabled
      ? "监听已关"
      : !watch.apps.length
        ? "未选 App"
        : `${apps.filter((a) => a.running).length}/${watch.apps.length} 在跑${watchingFront && frontName ? ` · 前台 ${frontName}` : ""}`,
  };
}
ipcMain.handle("systemWatch:status", (_e, botId: string) => {
  const id = String(botId || "");
  const hit = watchStatusCache.get(id);
  if (hit && Date.now() - hit.at < 3000) return hit.pending;
  const pending = buildWatchStatus(id).catch((err) => {
    watchStatusCache.delete(id);
    throw err;
  });
  watchStatusCache.set(id, { at: Date.now(), pending });
  return pending;
});

const PREF_PANES: Record<string, string> = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
  notifications: "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
};
ipcMain.handle("system:notifyState", async () => {
  if (!notifyMuted && (notifyProbePending || notifyState === "unknown")) {
    notifyProbePending = false;
    await probeNotify();
  }
  return { state: notifyState, muted: notifyMuted, appLabel: notifyAppLabel() };
});
ipcMain.handle("system:notifyRecheck", async () => {
  notifyProbePending = false;
  notifyProbedThisSession = false;
  notifyMuted = false;
  store.writeConfig({ ...store.readConfig(), notifyMuted: false });
  const state = await probeNotify(true);
  return {
    state,
    muted: notifyMuted,
    appLabel: notifyAppLabel(),
    reason: state === "ok" ? "已弹出测试通知" : "Electron 与系统通知都失败了",
  };
});
ipcMain.handle("system:notifyMute", () => {
  notifyMuted = true;
  store.writeConfig({ ...store.readConfig(), notifyMuted: true });
  sendUi("notify:state", { state: notifyState, muted: true, appLabel: notifyAppLabel() });
  return { state: notifyState, muted: true, appLabel: notifyAppLabel() };
});
ipcMain.handle("system:openPrefs", (_e, pane: string) => {
  if (pane === "notifications") notifyProbePending = true; // 用户去系统设置改完回来再测
  // 辅助功能：先 prompt=true，把「当前这份」Electron 登记进 TCC（避免勾到同名另一份）
  if (pane === "accessibility" && process.platform === "darwin") {
    computerPrefsPending = true;
    try { systemPreferences.isTrustedAccessibilityClient(true); } catch { /* ignore */ }
  }
  if (pane === "screen") computerPrefsPending = true;
  return shell.openExternal(PREF_PANES[pane] ?? PREF_PANES.accessibility);
});
ipcMain.handle("system:revealElectronApp", () => {
  if (process.platform !== "darwin" || !ELECTRON_APP_PATH || !existsSync(ELECTRON_APP_PATH)) {
    return { ok: false, error: "找不到 Electron.app" };
  }
  shell.showItemInFolder(ELECTRON_APP_PATH);
  return { ok: true, path: ELECTRON_APP_PATH };
});
ipcMain.handle("system:pickFile", async (_e, opts: { save?: boolean; defaultPath?: string; title?: string }) => {
  const filters = [{ name: "JSON", extensions: ["json"] }];
  if (opts.save) {
    const r = await dialog.showSaveDialog(mainWin as BrowserWindow, { title: opts.title, defaultPath: opts.defaultPath, filters });
    return r.canceled ? null : r.filePath ?? null;
  }
  const r = await dialog.showOpenDialog(mainWin as BrowserWindow, { title: opts.title, defaultPath: opts.defaultPath, filters, properties: ["openFile"] });
  return r.canceled ? null : r.filePaths[0] ?? null;
});
/** 关于页 / 更新：版本与渠道；自动更新源尚未配置时明确返回不可用 */
ipcMain.handle("system:appInfo", () => {
  const cfg = store.readConfig() as { updateChannel?: string };
  const channel = cfg.updateChannel === "beta" ? "beta" : "stable";
  return {
    version: app.getVersion(),
    channel,
    schema: SCHEMA_VERSION,
    update: { available: false, message: "尚未配置发布源（electron-updater / latest-mac.yml）" },
  };
});
ipcMain.handle("system:checkUpdate", () => ({
  available: false,
  message: "尚未配置发布源。打包发布后可在此检查 GitHub Releases / 静态 latest-mac.yml。",
}));
ipcMain.handle("providers:list", () => providers.list());
ipcMain.handle("providers:add", (_e, input: any) => providers.addProvider(input));
ipcMain.handle("providers:test", (_e, id: string) => providers.test(id));
ipcMain.handle("providers:testConfig", (_e, input: any) => providers.testConfig(input));
ipcMain.handle("providers:update", (_e, id: string, patch: any) => providers.update(id, patch));
ipcMain.handle("providers:delete", (_e, id: string) => providers.delete(id));
ipcMain.handle("providers:setDefault", (_e, id: string) => {
  const p = providers.get(id);
  if (!p) throw new Error("provider 不存在");
  store.saveProvider({ ...p, isDefault: true });
});
ipcMain.handle("providers:capabilities", (_e, force?: boolean) => providers.capabilities(!!force));
ipcMain.handle("system:notify", (_e, title: string, body: string) => system.notify(title, body));
ipcMain.handle("system:copy", (_e, text: string) => system.copy(text));
ipcMain.handle("system:openPath", (_e, path: string) => shell.openPath(path));
ipcMain.handle("system:reveal", (_e, path: string) => { if (existsSync(path)) shell.showItemInFolder(path); });
const PREVIEW_MAX = 256 * 1024;
ipcMain.handle("files:preview", (_e, path: string) => {
  if (!existsSync(path) || !statSync(path).isFile()) return { ok: false, error: "文件不存在" };
  const size = statSync(path).size;
  const buf = Buffer.alloc(Math.min(size, PREVIEW_MAX));
  const fd = openSync(path, "r");
  try { readSync(fd, buf, 0, buf.length, 0); } finally { closeSync(fd); }
  if (buf.includes(0)) return { ok: false, error: "二进制文件，无法预览" };
  return { ok: true, text: buf.toString("utf8"), truncated: size > PREVIEW_MAX, size };
});
ipcMain.handle("system:readFile", (_e, path: string) => system.readFile(path));
ipcMain.handle("system:writeFile", (_e, path: string, content: string) => system.writeFile(path, content));
ipcMain.handle("migration:export", (_e, filePath: string, mask?: boolean) => migration.exportToFile(filePath, { maskKeys: mask }));
ipcMain.handle("migration:import", (_e, filePath: string) => { const r = migration.importFromFile(filePath); registerAll(); return r; });
ipcMain.handle("window:openSession", (_e, sessionId?: string) => {
  focusMainPanel(sessionId ?? null);
  return true;
});
ipcMain.handle("pets:list", () => store.listPets());
ipcMain.handle("pets:getLastSession", (_e, botId: string) => {
  const s = store.listSessions(botId);
  return s.length ? s[s.length - 1].id : null;
});
ipcMain.handle("pets:save", (_e, p: { botId: string; x: number; y: number; visible: boolean }) => store.savePet(p));
ipcMain.handle("pets:addXp", (_e, botId: string, n: number) => grantPetXp(botId, n));
ipcMain.handle("sessions:list", (_e, botId?: string) => store.listSessions(botId));
ipcMain.handle("sessions:page", (_e, opts?: { botId?: string; archived?: boolean; offset?: number; limit?: number }) => store.listSessionsPage(opts));
ipcMain.handle("sessions:archive", (_e, sessionId: string, archived: boolean) => {
  if (archived) forgetGaze(sessionId);
  return store.archiveSession(sessionId, archived);
});
ipcMain.handle("sessions:delete", (_e, sessionId: string) => {
  forgetGaze(sessionId);
  return store.deleteSession(sessionId);
});
ipcMain.handle("sessions:get", (_e, sessionId: string) => store.getSession(sessionId));
ipcMain.handle("sessions:rename", (_e, sessionId: string, title: string) => store.renameSession(sessionId, title));
ipcMain.handle("messages:delete", (_e, sessionId: string, ids: number[]) => store.deleteMessages(sessionId, ids));

/** 问题卡片：记下用户点了哪个选项（卡片变成已答状态） */
ipcMain.handle("messages:answer", (_e, sessionId: string, id: number, choiceId: string, answer: string) => {
  const msg = store.updateMessage(sessionId, id, (m) => ({
    ...m,
    content: Array.isArray(m.content) ? m.content.map((b) => (b.type === "choice" && b.id === choiceId ? { ...b, answer } : b)) : m.content,
  }));
  const botId = store.getSession(sessionId)?.botId;
  if (botId && statuses.get(botId)?.state === "waiting") {
    settleBotStatus(botId, Array.isArray(msg?.content) ? msg.content : undefined, sessionId);
  }
  return msg;
});
ipcMain.handle("messages:formAnswer", (_e, sessionId: string, id: number, formId: string, answer: Record<string, string>) => {
  const msg = store.updateMessage(sessionId, id, (m) => ({
    ...m,
    content: Array.isArray(m.content) ? m.content.map((b) => (b.type === "form" && b.id === formId ? { ...b, answer } : b)) : m.content,
  }));
  const botId = store.getSession(sessionId)?.botId;
  if (botId && statuses.get(botId)?.state === "waiting") {
    settleBotStatus(botId, Array.isArray(msg?.content) ? msg.content : undefined, sessionId);
  }
  return msg;
});

ipcMain.handle("vault:list", (_e, query?: string) => (query ? vault.search(query) : vault.list()));
ipcMain.handle("vault:catalog", () => vault.catalog());
ipcMain.handle("contacts:list", () => contacts.list());
ipcMain.handle("contacts:upsert", (_e, input: { id?: string; name: string; email?: string; note?: string }) => contacts.upsert(input));
ipcMain.handle("contacts:remove", (_e, id: string) => contacts.remove(id));
ipcMain.handle("connectors:listWebhooks", () => connectors.listWebhooks());
ipcMain.handle("connectors:upsertWebhook", (_e, input: { id?: string; name: string; url: string; note?: string; headers?: Record<string, string> }) =>
  connectors.upsertWebhook(input));
ipcMain.handle("connectors:removeWebhook", (_e, id: string) => connectors.removeWebhook(id));
ipcMain.handle("connect:cards", () => CONNECT_INSTALL_CARDS);
ipcMain.handle("connect:gateway", () => gatewaySnapshot());
ipcMain.handle("connect:setGateway", async (_e, input: {
  enabled: boolean;
  port?: number;
  host?: string;
  allowRemote?: boolean;
  requireHmac?: boolean;
}) => applyGatewaySettings(input ?? { enabled: false }));
ipcMain.handle("connect:probeGateway", async () => {
  const info = gatewaySnapshot();
  if (!info.running || !info.port) return { ok: false, error: "网关未在运行", info };
  try {
    const host = info.host || "127.0.0.1";
    const r = await fetch(`http://${host}:${info.port}/health`, { signal: AbortSignal.timeout(3000) });
    const j = await r.json().catch(() => ({})) as { ok?: boolean };
    return { ok: r.ok && j.ok !== false, status: r.status, info };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), info };
  }
});
ipcMain.handle("connect:gatewayMsgToken", () => copyGatewayMsgToken());
ipcMain.handle("connect:rotateGatewayMsgToken", async () => rotateGatewayMsgToken());
ipcMain.handle("connect:shareBridge", () => ({
  ...shareBridgeStatus(),
  cloudflare: cloudflareCredsStatus(),
}));
ipcMain.handle("connect:saveShareBridge", (_e, input: { base: string; putKey?: string; ttlDays?: number }) =>
  saveShareBridgeCreds(input ?? { base: "" }));
ipcMain.handle("connect:clearShareBridge", () => clearShareBridgeCreds());
ipcMain.handle("connect:probeShareBridge", async () => probeShareBridge());
ipcMain.handle("connect:cloudflare", () => cloudflareCredsStatus());
ipcMain.handle("connect:saveCloudflare", (_e, input: { apiToken?: string; accountId?: string }) =>
  saveCloudflareCreds(input ?? {}));
ipcMain.handle("connect:clearCloudflare", () => clearCloudflareCreds());
ipcMain.handle("connect:provisionShareBridge", async (_e, input?: { apiToken?: string; accountId?: string; subdomain?: string; ttlDays?: number }) =>
  provisionShareBridge({
    appRoot: APP_ROOT,
    apiToken: input?.apiToken,
    accountId: input?.accountId,
    subdomain: input?.subdomain,
    ttlDays: input?.ttlDays,
  }));
ipcMain.handle("connect:listShareLinks", async () => listShareBridgeLinks());
ipcMain.handle("connect:deleteShareLink", async (_e, id: string) => {
  await deleteShareBridgeLink(id);
  return { ok: true };
});

ipcMain.handle("demo:status", (_e, botId: string) => demoSkills.status(botId));
ipcMain.handle("demo:start", (_e, botId: string, opts?: { title?: string; sessionId?: string }) => {
  if (!store.getBot(botId)) throw new Error("bot 不存在");
  const s = demoSkills.start(botId, opts);
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("app:changed", "demo");
  return s;
});
ipcMain.handle("demo:cancel", (_e, botId: string) => {
  const s = demoSkills.cancel(botId);
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("app:changed", "demo");
  return s;
});
ipcMain.handle("demo:finish", async (_e, botId: string, opts?: {
  name?: string; description?: string; cron?: string; in?: string | number; at?: string; keep?: boolean; testNow?: boolean; webhook?: boolean; prompt?: string; taskName?: string; sessionId?: string;
}) => {
  const bot = store.getBot(botId);
  if (!bot) throw new Error("bot 不存在");
  const finished = demoSkills.finish(botId, { name: opts?.name, description: opts?.description });
  if (!finished.ok) throw new Error(finished.error);
  const { draft, session } = finished;
  let skill;
  try {
    skill = skills.save({ name: draft.name, description: draft.description, body: draft.body, owner: bot.id });
  } catch (e) {
    demoSkills.reopen(botId, session);
    throw e;
  }
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("app:changed", "skills");
  const link = `[${skill.name}](app:skill/${skill.key})`;
  let task = null as ReturnType<typeof scheduler.create> | null;
  const cron = opts?.cron?.trim();
  const runAt = parseRunAt({ in: opts?.in, at: opts?.at });
  const taskName = opts?.taskName || `重跑：${skill.name}`;
  const prompt = opts?.prompt || `请按技能 ${link} 的步骤执行一遍，按当前环境调整路径与参数，完成后汇报结果。`;
  const wantHook = !!opts?.webhook;
  if (cron || runAt) {
    if (runAt) {
      task = scheduler.create({
        botId: bot.id, name: taskName, prompt, cron: "* * * * *", kind: "once", alarmAt: runAt,
        runPrompt: true, notifyPet: false, deleteAfterRun: opts?.keep !== true,
        sessionId: opts?.sessionId, skillKey: skill.key, source: "demo", webhook: wantHook,
      });
    } else if (cron) {
      task = scheduler.create({
        botId: bot.id, name: taskName, prompt, cron, sessionId: opts?.sessionId,
        skillKey: skill.key, source: "demo", webhook: wantHook,
      });
    }
  }
  // 立刻试跑：不落 once 闹钟，避免与 tick 双触发；有例行则试跑例行，否则直接 onRun
  if (opts?.testNow) {
    if (task) void scheduler.runNow(task.id).catch(() => {});
    else if (scheduler.onRun) {
      void scheduler.onRun({
        id: `demo-test-${skill.key}`,
        botId: bot.id,
        name: `试跑：${skill.name}`,
        prompt,
        cron: "* * * * *",
        enabled: false,
        runCount: 0,
        createdAt: Date.now(),
        skillKey: skill.key,
        source: "demo",
        sessionId: opts?.sessionId,
      }).catch(() => {});
    }
  }
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("app:changed", "demo");
  return { skill, task, steps: draft.steps, webhookReady: !!task?.webhookToken };
});

/** 导出会话为 Markdown */
ipcMain.handle("sessions:export", async (_e, sessionId: string) => {
  const s = store.getSession(sessionId);
  const nameOf = (id: string) => (id === "user" ? "我" : store.getBot(id)?.name ?? id);
  const lines: string[] = [`# ${s?.title || "会话"}`, "", `导出时间：${new Date().toLocaleString("zh-CN")}`, ""];
  for (const m of store.listMessages(sessionId)) {
    const blocks: ContentBlock[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    lines.push(`### ${nameOf(m.from)} · ${new Date(m.createdAt).toLocaleString("zh-CN")}`, "");
    for (const b of blocks) {
      if (b.type === "text") lines.push(b.text.replace(/```tool[\s\S]*?```/g, "").trim());
      else if (b.type === "image") lines.push(b.path ? `![${b.alt ?? "图片"}](${pathToFileURL(b.path).toString()})` : `（图片：${b.alt ?? ""}）`);
      else if (b.type === "file") lines.push(`📎 [${b.name}](${pathToFileURL(b.path).toString()})`);
      else if (b.type === "tool_call") lines.push(`> 🛠 ${b.tool}${b.result ? `：${b.result.split("\n")[0].slice(0, 120)}` : ""}`);
      else if (b.type === "choice") lines.push(`> ❓ ${b.question}${b.mode === "confirm" ? "" : `（${b.options.join(" / ")}）`}${b.answer ? ` → ${b.answer}` : ""}`);
      else if (b.type === "secret") lines.push(`> 🔑 ${b.label}${b.saved ? "（已保存）" : ""}`);
    }
    lines.push("");
  }
  const safe = (s?.title || "会话").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
  const r = await dialog.showSaveDialog(mainWin!, { defaultPath: join(app.getPath("downloads"), `${safe}.md`), filters: [{ name: "Markdown", extensions: ["md"] }] });
  if (r.canceled || !r.filePath) return null;
  writeFileSync(r.filePath, lines.join("\n"), "utf8");
  return r.filePath;
});

/** 产出物库：bot 在所有会话里交付过的图片和文件，新的在前 */
/** 产出库：某个 bot 发出的所有图片/文件；传 groupId 时是这个群所有会话里成员发出的 */
ipcMain.handle("library:list", (_e, botId: string | null, groupId?: string) => {
  const items: (ContentBlock & { sessionId: string; createdAt: number; from: string })[] = [];
  const seen = new Set<string>();
  const sessions = [...store.listSessionsPage({ limit: 5000, botId: groupId }).sessions, ...store.listSessionsPage({ limit: 5000, archived: true, botId: groupId }).sessions]
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 300);
  for (const s of sessions) {
    for (const m of store.listMessages(s.id)) {
      if ((groupId ? m.from === "user" : m.from !== botId) || !Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b.type !== "image" && b.type !== "file") continue;
        const key = (b as any).path ?? (b as any).url ?? `${s.id}-${m.createdAt}-${items.length}`;
        if (seen.has(key)) continue;
        if ((b as any).path && !existsSync((b as any).path)) continue;
        seen.add(key);
        items.push({ ...b, sessionId: s.id, createdAt: m.createdAt, from: m.from });
      }
    }
  }
  return items.sort((a, b) => b.createdAt - a.createdAt).slice(0, 300);
});

/** 工作区：bot 的工作目录文件 + 最近的工具活动 + 当前状态 */
ipcMain.handle("workspace:info", (_e, botId: string) => {
  const bot = store.getBot(botId);
  const dir = bot ? runtime.workspaceOf(bot) : null;
  const files: { path: string; rel: string; size: number; mtime: number; dir: boolean }[] = [];
  const walk = (d: string, depth: number) => {
    if (files.length >= 300 || depth > 3) return;
    for (const name of readdirSync(d)) {
      if (name.startsWith(".")) continue;
      const p = join(d, name);
      const st = statSync(p);
      files.push({ path: p, rel: p.slice(dir!.length + 1), size: st.size, mtime: st.mtimeMs, dir: st.isDirectory() });
      if (st.isDirectory()) walk(p, depth + 1);
    }
  };
  if (dir) walk(dir, 0);
  const activity: { tool: string; args?: Record<string, unknown>; status?: string; result?: string; at: number; sessionId: string }[] = [];
  const sessions = store.listSessionsPage({ limit: 5000 }).sessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 40);
  for (const s of sessions) {
    for (const m of store.listMessages(s.id)) {
      if (m.from !== botId || !Array.isArray(m.content)) continue;
      for (const b of m.content) if (b.type === "tool_call") activity.push({ tool: b.tool, args: b.args, status: b.status, result: b.result?.slice(0, 200), at: m.createdAt, sessionId: s.id });
    }
  }
  return {
    dir,
    files: files.sort((a, b) => b.mtime - a.mtime),
    activity: activity.sort((a, b) => b.at - a.at).slice(0, 30),
    status: statuses.get(botId) ?? null,
    secrets: secrets.list(botId),
    env: env.visibleTo(botId),
  };
});

registerVoiceIpc({ store, keyCipher, openStoredKey });
registerRealmIpc({
  home,
  store,
  providers,
  keyCipher,
  openStoredKey,
  getMainWin: () => mainWin,
});
ipcMain.handle("messages:list", (_e, sessionId: string) => store.listMessages(sessionId));
ipcMain.handle("messages:page", (_e, sessionId: string, opts?: { limit?: number; beforeId?: number }) => store.listMessagesPage(sessionId, opts));
ipcMain.handle("messages:search", (_e, opts?: { q?: string; botId?: string; from?: number; to?: number; limit?: number }) => store.searchMessages(opts));
registerKnowledgeIpc({ store, memory, skills, scheduler, mcp, providers, executor, statuses, home });
ipcMain.handle("computerUse:status", () => computerUseStatus());
ipcMain.handle("computerUse:doctor", async () => {
  if (!computerUseStatus().enabled) return computerUseStatus();
  await probeComputerDoctor();
  return computerUseStatus();
});
ipcMain.handle("computerUse:setEnabled", async (_e, on: boolean) => {
  const st = await setComputerUseEnabled(!!on, (msg) => {
    try { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("computerUse:progress", msg); } catch { /* */ }
  });
  if (on && st.needsPermission) {
    if (!st.permissions.accessibility) void shell.openExternal(PREF_PANES.accessibility);
    else if (!st.permissions.screen) void shell.openExternal(PREF_PANES.screen);
  }
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("app:changed", "mcp");
  return st;
});

app.on("window-all-closed", () => {});
app.on("before-quit", () => {
  codingPresence.stopAll();
  runtime.flushInflight();
});
/** Coding 终端：仅 open→exited 记一会话，忽略 idle↔busy 抖动 */
const codingPhaseSeen = new Map<string, CodingPresenceView["phase"]>();
const codingSessionOpen = new Set<string>();
codingPresence.setScreenListener((view) => {
  const key = `${view.botId}\0${view.cwd}\0${view.cli}`;
  const prev = codingPhaseSeen.get(key);
  codingPhaseSeen.set(key, view.phase);
  const alive = view.phase === "starting" || view.phase === "busy" || view.phase === "idle";
  if (alive && !codingSessionOpen.has(key) && (!prev || prev === "exited")) {
    codingSessionOpen.add(key);
    appendCodingActivity(home, {
      kind: "start",
      botId: view.botId,
      cwd: view.cwd,
      cli: view.cli,
      program: view.program?.kind === "agent" ? "agent" : "shell",
      task: view.task,
    });
  }
  if (prev && prev !== "exited" && view.phase === "exited") {
    codingSessionOpen.delete(key);
    codingPhaseSeen.delete(key);
    appendCodingActivity(home, {
      kind: "end",
      botId: view.botId,
      cwd: view.cwd,
      cli: view.cli,
      program: view.program?.kind === "agent" ? "agent" : "shell",
      reason: view.exitReason,
      durationMs: view.startedAt ? Math.max(0, (view.lastActiveAt || Date.now()) - view.startedAt) : undefined,
    });
  }
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("coding:screen", view);
});
codingPresence.setBytesListener((e) => {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("coding:bytes", e);
});
ipcMain.handle("coding:presence", (_e, botId: string) => codingPresence.snapshot(botId) ?? null);
ipcMain.handle("coding:list", (_e, botId: string) => codingPresence.list(botId));
ipcMain.handle("coding:focus", (_e, botId: string, cwd: string) => codingPresence.focus(botId, String(cwd ?? "")) ?? null);
ipcMain.handle("coding:open", (_e, botId: string, cwd: string) => {
  // 面板「打开」只起 shell；Coding CLI 必须走 cli.agent（带授权），不能经 IPC 旁路
  const raw = String(cwd ?? "").trim();
  if (!raw) return { error: "请先选择工程目录，再点打开。" };
  let dir: string;
  try {
    dir = resolveAgentCwd(raw, { harnessHome: home });
  } catch (e) {
    return { error: e instanceof CliAgentPathError || e instanceof Error ? e.message : String(e) };
  }
  return codingPresence.openShell(botId, dir, { mode: "shell" });
});
ipcMain.handle("coding:replay", (_e, botId: string, cwd?: string) => codingPresence.replay(botId, cwd));
ipcMain.handle("coding:resize", (_e, botId: string, cols: number, rows: number, cwd?: string) => {
  codingPresence.resize(botId, Number(cols), Number(rows), cwd);
  return { ok: true as const };
});
ipcMain.handle("coding:stop", (_e, botId: string, cwd?: string) => {
  codingPresence.stop(botId, "你结束了这个终端", cwd);
  return codingPresence.snapshot(botId);
});
ipcMain.handle("coding:write", (_e, botId: string, data: string, cwd?: string) => {
  return { ok: codingPresence.writeRaw(botId, String(data ?? ""), cwd) };
});
ipcMain.handle("coding:pickDir", async () => {
  const r = await dialog.showOpenDialog(mainWin!, { title: "选择工程目录", properties: ["openDirectory"] });
  if (r.canceled || !r.filePaths[0]) return null;
  try { return realpathSync(r.filePaths[0]); } catch { return r.filePaths[0]; }
});
