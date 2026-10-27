/**
 * Harness Bot — Electron 壳
 * Tray(菜单栏) + 主控窗口 + 宠物窗口(无边框透明)
 * 核心逻辑全部在 core/（纯 TS），这里只做宿主桥接。
 */
import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, clipboard, Notification, screen, nativeImage } from "electron";
import { join } from "node:path";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

// 应用根：electron . 运行时 getAppPath() 返回项目根目录
// bun build 会把 import.meta.url / __dirname 编译成源码路径，不能用于定位运行文件。
const APP_ROOT = app.getAppPath();
const DIST_DIR = join(APP_ROOT, "dist");
import { Store } from "../core/store";
import { AgentRegistry } from "../core/agent-registry";
import { MessageBus } from "../core/message-bus";
import { ProviderCenter } from "../core/provider-center";
import { PersonaGenerator } from "../core/persona";
import { MigrationV2 } from "../core/migration-v2";
import { SystemKit } from "../core/system-kit";
import { MemorySystem } from "../core/memory-system";
import { SkillRegistry, BUILTIN_SKILL_TEMPLATES } from "../core/skill-registry";
import { Scheduler } from "../core/scheduler";
import { GroupRegistry } from "../core/group-registry";
import { Orchestrator, planFromText } from "../core/orchestrator";
import { GatewayServer } from "../core/gateway-server";
import { PetSkinRegistry, EMOJI_FALLBACK } from "../core/pet-skin";
import { ConsentCenter, CAP_LABELS } from "../core/consent-center";
import { AuditLog } from "../core/audit-log";
import { SystemAccess } from "../core/system-access";
import { BotRuntime, skillFromText } from "../core/bot-runtime";
import { OfflinePersona } from "../core/offline-persona";
import { ToolExecutor, BUILTIN_TOOL_DESCRIPTIONS } from "../core/tool-executor";
import { McpClient, type McpServerConfig } from "../core/mcp-client";
import { OpenAICompatImageGen } from "../core/adapters/image-gen";
import { AgentStatus } from "../core/types";

const home = process.env.HARNESS_HOME || join(app.getPath("userData"), "..", "harness-bot");
const store = new Store(home);
const assetsDir = join(home, "assets");
const petSkins = new PetSkinRegistry(assetsDir);
const registry = new AgentRegistry(store);
const bus = new MessageBus(store);
const providers = new ProviderCenter(store);
const persona = new PersonaGenerator(store, assetsDir);

const system = new SystemKit({
  allowedRoot: join(home, "workspace"),
  notify: (p) => new Notification({ title: p.title, body: p.body }).show() as unknown as boolean,
  clipboardWrite: (t) => clipboard.writeText(t),
  clipboardRead: () => clipboard.readText(),
});

// ---- Bot 底层运行时（持久记忆 / 技能 / 定时任务）----
const memory = new MemorySystem(home);
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
const orchestrator = new Orchestrator({ store, groups, providers }, home);
const migration = new MigrationV2(store, assetsDir, memory, skills, scheduler, groups, orchestrator);
const workspace = join(home, "workspace");
const consent = new ConsentCenter(home);
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
void mcp.init();
const statuses = new Map<string, AgentStatus>();
const runtime = new BotRuntime({ store, providers, memory, skills, system, systemAccess, executor, offline: new OfflinePersona(), mcp });

// 形象生成：有图像 provider 时用真 API，否则降级
function personaWithImage() {
  const imgProv = providers.list().find((p) => p.kind === "openai-compat" && p.model?.startsWith("dall") || p.model?.startsWith("gpt-image"));
  if (imgProv) return new PersonaGenerator(store, assetsDir, new OpenAICompatImageGen(imgProv));
  return persona;
}

function loadMcpServers(): McpServerConfig[] {
  const cfg = store.readConfig();
  const servers = (cfg as any).mcpServers ?? [];
  return servers as McpServerConfig[];
}

// 为所有 bot 注册默认消息处理器：调用其绑定的 provider 生成回复
async function defaultHandler(from: any, to: any, text: string, ctx: any): Promise<string> {
  const bot = store.getBot(to.id);
  if (!bot) return "bot 不存在";
  statuses.set(bot.id, { botId: bot.id, state: "running", lastRunAt: Date.now(), currentTask: text.slice(0, 60) });
  try {
    const r = await runtime.handle({
      bot,
      from: from.id || "user",
      text,
      sessionId: ctx.sessionId,
      history: store.listMessages(ctx.sessionId).slice(-10),
    });
    statuses.set(bot.id, { botId: bot.id, state: "idle", lastRunAt: Date.now() });
    if (bot.petEnabled) {
      const xp = grantPetXp(bot.id, 10);
      pushPetEvent(bot.id, { type: "reply", text: r.text.slice(0, 120), model: bot.model || providers.get(bot.providerId)?.model || providers.getDefault()?.model, xp });
    } else {
      pushPetEvent(bot.id, { type: "reply", text: r.text.slice(0, 120) });
    }
    return r.text;
  } catch (e) {
    statuses.set(bot.id, { botId: bot.id, state: "error", lastRunAt: Date.now(), lastError: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

// 注册已有 bot + 新 bot 时自动注册
function registerAll() {
  for (const b of store.listBots()) bus.register(b.id, defaultHandler);
}
registerAll();

let tray: Tray | null = null;
let mainWin: BrowserWindow | null = null;
const petWins = new Map<string, BrowserWindow>();

/** G5.5：宠物成长经验 +n（落盘 pets.json，返回新 xp） */
function grantPetXp(botId: string, n: number): number {
  const pet = store.listPets().find((p) => p.botId === botId) || { botId, x: 0, y: 0, visible: true };
  const xp = (pet.xp || 0) + n;
  store.savePet({ ...pet, xp });
  return xp;
}

/** 向某 bot 的宠物窗口推送事件（不存在则跳过） */
function pushPetEvent(botId: string, event: { type: string; text?: string; title?: string; rich?: import("../core/types").ContentBlock[]; sessionId?: string; model?: string; xp?: number }) {
  const win = petWins.get(botId);
  if (win && !win.isDestroyed()) {
    win.webContents.send("pet:event", event);
  }
}

// G5：macOS 辅助功能 / 屏幕录制 TCC 权限检测
function tccStatus() {
  return {
    accessibility: (() => {
      try {
        const { execFileSync } = require("node:child_process");
        const out = execFileSync("osascript", ["-e", "tell application \"System Events\" to return UI elements enabled"], { timeout: 8000 }).toString();
        return out.trim() === "true";
      } catch { return false; }
    })(),
    screen: (() => {
      try {
        const { execFileSync } = require("node:child_process");
        execFileSync("screencapture", ["-x", "/dev/null"], { timeout: 5000 });
        return true;
      } catch { return false; }
    })(),
  };
}

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1080,
    height: 780,
    minWidth: 800,
    minHeight: 600,
    title: "Harness Bot",
    backgroundColor: "#0d0d0d",
    show: false,
    webPreferences: {
      preload: join(DIST_DIR, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWin.loadURL(pathToFileURL(join(DIST_DIR, "renderer", "index.html")).toString());
  mainWin.webContents.on("did-finish-load", () => {
    console.log("[harness] 主控面板渲染完成 ✅");
    mainWin?.webContents.executeJavaScript("typeof window.harness !== 'undefined' ? 'bridge-ok' : 'bridge-missing'")
      .then((r) => console.log("[harness] preload bridge:", r))
      .catch(() => console.log("[harness] bridge check skipped"));
  });
  mainWin.once("ready-to-show", () => mainWin?.show());
  mainWin.on("closed", () => { mainWin = null; });
}

function createPetWindow(botId: string) {
  if (petWins.has(botId)) return petWins.get(botId);
  const bot = store.getBot(botId);
  if (!bot) return;
  const saved = store.listPets().find((p) => p.botId === botId);
  let x: number, y: number;
  if (saved) {
    // 多显示器记忆：优先恢复到记录所在显示器（displayId），坐标换算到该屏
    const disp = saved.displayId != null ? screen.getAllDisplays().find((d) => d.id === saved.displayId) : undefined;
    const target = disp || screen.getDisplayNearestPoint({ x: saved.x, y: saved.y });
    x = saved.x;
    y = saved.y;
    if (disp && (x < disp.workArea.x || x > disp.workArea.x + disp.workArea.width - 100 || y < disp.workArea.y || y > disp.workArea.y + disp.workArea.height - 100)) {
      x = disp.workArea.x + disp.workArea.width - 260;
      y = disp.workArea.y + disp.workArea.height - 340;
    }
    void target;
  } else {
    const wa = screen.getPrimaryDisplay().workArea;
    x = wa.x + wa.width - 260;
    y = wa.y + wa.height - 340;
  }
  const win = new BrowserWindow({
    width: 220,
    height: 240,
    x, y,
    transparent: true,
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
    store.savePet({ botId, x: bx, y: by, visible: true, displayId });
  });
  petWins.set(botId, win);
  return win;
}

function refreshTray() {
  const menu = Menu.buildFromTemplate([
    { label: "打开主控面板", click: () => mainWin ? mainWin.show() : createMainWindow() },
    { type: "separator" },
    { label: "宠物：全部显示", click: () => { for (const b of store.listBots().filter((x) => x.petEnabled)) createPetWindow(b.id); } },
    { label: "宠物：全部隐藏", click: () => { for (const w of petWins.values()) w.hide(); } },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]);
  tray?.setContextMenu(menu);
}

app.whenReady().then(() => {
  const icon = nativeImage.createFromPath(join(DIST_DIR, "..", "assets", "tray.png"));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("Harness Bot");
  refreshTray();
  createMainWindow();

  // G3：启动时恢复已启用的宠物窗口（多显示器记忆位置）
  for (const b of store.listBots().filter((x) => x.petEnabled)) createPetWindow(b.id);

  // G4：编排器阶段执行器（走 bot 运行时）
  orchestrator.stageRunner = async (stage) => {
    const bot = store.getBot(stage.botId);
    if (!bot) throw new Error(`阶段 bot 不存在: ${stage.botId}`);
    const sid = `plan-${Date.now()}-${stage.id}`;
    const r = await runtime.handle({ bot, from: "orchestrator", text: stage.prompt, sessionId: sid });
    return r.text;
  };

  // G5：授权弹窗（用户批准/一次/长期/拒绝；危险操作强确认）
  consent.decider = (req) => {
    const bot = store.getBot(req.botId);
    const name = bot?.name || req.botId;
    const danger = req.requiresStrongConsent ? "\n\n⚠️ 危险操作，请确认身份后输入 confirm 批准。" : "";
    const btn = dialog.showMessageBoxSync(mainWin as BrowserWindow, {
      type: danger ? "warning" : "question",
      title: `系统授权请求 — ${name}`,
      message: `${name} 请求使用「${req.cap}」能力`,
      detail: `${req.description}${danger}`,
      buttons: ["批准一次", "长期批准", "拒绝"],
      defaultId: 2,
      cancelId: 2,
      noLink: true,
    });
    if (danger && btn !== 2) {
      // 危险操作二次确认：输入 confirm
      const input = dialog.showMessageBoxSync(mainWin as BrowserWindow, {
        type: "warning",
        title: "危险操作二次确认",
        message: "输入 confirm 以确认执行危险操作",
        buttons: ["我输入了 confirm", "取消"],
        defaultId: 1,
      });
      if (input !== 0) return "deny" as const;
    }
    if (btn === 0) return "allow-once" as const;
    if (btn === 1) return "allow" as const;
    return "deny" as const;
  };

  // G4：HTTP 网关（config.gateway 开启时）
  void (async () => {
    try {
      const cfg = store.readConfig() as { gateway?: { port?: number; token?: string } };
      const gw = cfg.gateway;
      if (gw?.port) {
        const server = new GatewayServer(gw.port, gw.token || "harness-default-token", bus);
        const port = await server.start();
        console.log(`[harness] 网关已启动 :${port} 🕸`);
      }
    } catch (e) {
      console.log("[harness] 网关启动失败（忽略）:", e instanceof Error ? e.message : e);
    }
  })();

  // 定时任务：到期时唤醒对应 bot（走运行时）
  scheduler.onRun = async (task) => {
    const bot = store.getBot(task.botId);
    if (!bot) return;
    const sid = `sched-${task.id}-${Date.now()}`;
    try {
      statuses.set(task.botId, { botId: task.botId, state: "running", lastRunAt: Date.now(), currentTask: `⏰ ${task.name}` });
      const r = await runtime.handle({ bot, from: "scheduler", text: task.prompt ?? task.name, sessionId: sid });
      statuses.set(task.botId, { botId: task.botId, state: "idle", lastRunAt: Date.now() });
      system.notify(`⏰ ${bot.name} 定时任务`, task.name);
      const xp = bot.petEnabled ? grantPetXp(task.botId, 20) : undefined;
      pushPetEvent(task.botId, { type: "task-done", title: task.name, text: r.text.slice(0, 120), rich: r.content, sessionId: sid, model: bot.model || providers.get(bot.providerId)?.model || providers.getDefault()?.model, xp });
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      statuses.set(task.botId, { botId: task.botId, state: "error", lastError: err });
      pushPetEvent(task.botId, { type: "task-error", title: task.name, text: err.slice(0, 120), sessionId: sid });
    }
  };
  scheduler.onAlarm = (task) => {
    const bot = store.getBot(task.botId);
    if (!bot) return;
    system.notify(`⏰ ${bot.name} 提醒`, task.name);
    pushPetEvent(task.botId, {
      type: "alarm",
      title: task.name,
      text: task.prompt ?? "时间到啦！⏰",
      sessionId: task.sessionId,
    });
  };
  scheduler.start();

  // 主动搭话：有宠物模式且空闲的 bot，随机主动问候（离线人格引擎）
  setInterval(() => {
    const pets = store.listBots().filter((b) => b.petEnabled && statuses.get(b.id)?.state !== "running");
    if (!pets.length || Math.random() > 0.25) return;
    const bot = pets[Math.floor(Math.random() * pets.length)];
    const line = new OfflinePersona().proactive(bot, memory.list(bot.id));
    if (line) {
      pushPetEvent(bot.id, { type: "proactive", title: line.title, text: line.text });
    }
  }, 5 * 60_000);

  app.on("activate", () => mainWin ? mainWin.show() : createMainWindow());
});

// ---- IPC：主控面板 / 宠物调用 core ----
ipcMain.handle("bots:list", () => store.listBots());
ipcMain.handle("bots:create", async (_e, text: string) => {
  const bot = await registry.createBotFromText(text, { defaultProviderId: providers.getDefault()?.id });
  bus.register(bot.id, defaultHandler);
  return bot;
});
ipcMain.handle("bots:delete", (_e, id: string) => { registry.deleteBot(id); bus.unregister(id); petWins.get(id)?.close(); });
ipcMain.handle("bots:setPet", (_e, id: string, enabled: boolean) => {
  registry.setPetEnabled(id, enabled);
  if (enabled) createPetWindow(id); else petWins.get(id)?.close();
});
ipcMain.handle("skins:list", () => petSkins.list().map((s) => ({ id: s.id, name: s.name, color: s.color, desc: s.desc, fps: s.fps, sprite: s.sprite })));
// G5.5：下载 openpets/petdex spritesheet 皮肤 → 存本地 assets/skins/<id>/
ipcMain.handle("skins:download", async (_e, input: { id: string; name: string; url: string; rows?: number; cols?: number }) => {
  const dir = join(assetsDir, "skins", input.id);
  mkdirSync(dir, { recursive: true });
  const res = await fetch(input.url);
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const path = join(dir, "spritesheet.webp");
  writeFileSync(path, buf);
  const rows = input.rows ?? 9, cols = input.cols ?? 8;
  const dataUrl = `data:image/webp;base64,${buf.toString("base64")}`;
  // 注册为 sprite 皮肤（emoji 帧兜底 + sprite 播放）
  petSkins.register({
    id: input.id,
    name: input.name,
    color: "#888",
    desc: `openpets 社区皮肤（${rows}×${cols} 帧）`,
    fps: 8,
    sprite: { url: input.url, path, rows, cols },
    frames: EMOJI_FALLBACK,
  });
  return { ok: true, path, sprite: { path, rows, cols }, dataUrl: dataUrl.slice(0, 50) + "…" };
});
// G5.5：回写 spritesheet 每格尺寸（pet 窗口 Image 探测后持久化，重启直接播放）
ipcMain.handle("skins:setMeta", (_e, id: string, meta: { cellW: number; cellH: number }) => {
  const sk = petSkins.get(id);
  if (!sk?.sprite?.path) throw new Error("皮肤不存在或非 sprite 皮肤");
  petSkins.register({ ...sk, sprite: { ...sk.sprite, cellW: meta.cellW, cellH: meta.cellH } });
  return { ok: true };
});
ipcMain.handle("bots:setSkin", (_e, id: string, skinId: string) => {
  const bot = store.getBot(id);
  if (!bot) throw new Error("bot 不存在");
  const next = { ...bot, skinId };
  store.saveBot(next);
  pushPetEvent(id, { type: "skin-updated", text: `皮肤已切换为「${skinId}」` });
  return next;
});
ipcMain.handle("persona:generate", async (_e, id: string, desc: string, style?: "default" | "pixel" | "cute") => {
  const bot = store.getBot(id);
  if (!bot) throw new Error("bot 不存在");
  const result = await personaWithImage().generate(bot, desc, style);
  // 宠物立即刷新形象（头像 + 名字 + 性格）
  pushPetEvent(id, { type: "avatar-updated", text: desc, title: result.card?.name || bot.name });
  return result;
});
ipcMain.handle("chat:send", async (_e, botId: string, text: string, sessionId?: string) => {
  const bot = store.getBot(botId);
  if (!bot) throw new Error("bot 不存在");
  return bus.chat(bot, text, sessionId);
});
ipcMain.handle("chat:sendStream", async (_e, botId: string, content: string | import("../core/types").ContentBlock[], sessionId?: string) => {
  const bot = store.getBot(botId);
  if (!bot) throw new Error("bot 不存在");
  const sid = sessionId || `s-${Date.now()}`;
  const text = typeof content === "string" ? content : (content.filter((b) => b.type === "text").map((b) => (b as any).text ?? "").join(""));
  statuses.set(botId, { botId, state: "running", lastRunAt: Date.now(), currentTask: text.slice(0, 60) });
  const push = (b: import("../core/types").ContentBlock) => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("chat:stream", b);
  };
  try {
    const r = await runtime.handleStream({ bot, from: "user", text, content: content as any, sessionId: sid, history: store.listMessages(sid).slice(-10) }, { onBlock: push });
    statuses.set(botId, { botId, state: "idle", lastRunAt: Date.now() });
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
    store.addMessage({ sessionId: sid, from: "user", to: botId, role: "user", content: content as any, kind: "chat", createdAt: Date.now() });
    store.addMessage({ sessionId: sid, from: botId, to: "user", role: "assistant", content: `❌ 回复失败：${err}`, kind: "chat", createdAt: Date.now() });
    throw e;
  }
});
ipcMain.handle("bus:send", async (_e, fromId: string, toId: string, text: string) => {
  const from = store.getBot(fromId), to = store.getBot(toId);
  if (!from || !to) throw new Error("bot 不存在");
  return bus.send(from, to, text);
});
// G4：群组
ipcMain.handle("groups:list", (_e, botId?: string) => groups.list(botId));
ipcMain.handle("groups:create", (_e, name: string, members: string[]) => {
  const g = groups.create(name, "user", members);
  return g;
});
ipcMain.handle("groups:join", (_e, groupId: string, botId: string) => groups.join(groupId, botId));
ipcMain.handle("groups:leave", (_e, groupId: string, botId: string) => groups.leave(groupId, botId));
ipcMain.handle("groups:remove", (_e, groupId: string) => groups.remove(groupId));
ipcMain.handle("groups:broadcast", async (_e, groupId: string, fromId: string, text: string) => {
  const from = store.getBot(fromId);
  if (!from) throw new Error("发起 bot 不存在");
  return bus.broadcast(groupId, from, text);
});
// G4：编排
ipcMain.handle("plans:create", (_e, input: { ownerBotId: string; title: string; stages: Array<{ botId: string; prompt: string; mode?: string }> }) =>
  orchestrator.create({ ownerBotId: input.ownerBotId, title: input.title, stages: input.stages.map((s) => ({ botId: s.botId, prompt: s.prompt, mode: s.mode === "fan" ? "fan" as const : "seq" as const })) }));
ipcMain.handle("plans:createFromText", async (_e, text: string, ownerBotId = "user") => {
  const p = providers.getDefault();
  const complete = p ? (prov: any, req: any) => providers.complete(prov, req) : undefined;
  const stages = await planFromText(text, store.listBots(), p ? { provider: p as any, complete } : undefined);
  if (!stages.length) throw new Error("没解析出可用 bot 阶段");
  return orchestrator.create({ ownerBotId, title: text.slice(0, 30), stages });
});
ipcMain.handle("plans:list", (_e, botId?: string) => botId ? orchestrator.listForBot(botId) : orchestrator.list());
ipcMain.handle("plans:run", async (_e, planId: string) => { const plan = orchestrator.list().find((x) => x.id === planId); if (!plan) throw new Error("计划不存在"); return orchestrator.run(plan.id); });
ipcMain.handle("plans:cancel", (_e, planId: string) => orchestrator.cancel(planId));
// G5：授权 + 审计 + TCC
ipcMain.handle("consent:list", (_e, botId?: string) => consent.list(botId));
ipcMain.handle("consent:grant", (_e, botId: string, cap: string, opts?: { once?: boolean; ttlMs?: number }) => consent.grant(botId, cap as any, opts));
ipcMain.handle("consent:revoke", (_e, botId: string, cap?: string) => consent.revoke(botId, cap as any));
ipcMain.handle("consent:caps", () => Object.entries(CAP_LABELS).map(([id, label]) => ({ id, label })));
ipcMain.handle("audit:list", (_e, opts?: any) => audit.query(opts));
ipcMain.handle("audit:export", (_e, filePath: string) => {
  const events = audit.exportAll();
  writeFileSync(filePath, JSON.stringify(events, null, 2), "utf8");
  return events.length;
});
ipcMain.handle("system:tcc", () => tccStatus());
ipcMain.handle("providers:list", () => providers.list());
ipcMain.handle("providers:add", (_e, input: any) => providers.addProvider(input));
ipcMain.handle("providers:test", (_e, id: string) => providers.test(id));
ipcMain.handle("providers:delete", (_e, id: string) => providers.delete(id));
ipcMain.handle("providers:capabilities", () => providers.capabilities());
ipcMain.handle("system:notify", (_e, title: string, body: string) => system.notify(title, body));
ipcMain.handle("system:copy", (_e, text: string) => system.copy(text));
ipcMain.handle("system:readFile", (_e, path: string) => system.readFile(path));
ipcMain.handle("system:writeFile", (_e, path: string, content: string) => system.writeFile(path, content));
ipcMain.handle("migration:export", (_e, filePath: string, mask?: boolean) => migration.exportToFile(filePath, { maskKeys: mask }));
ipcMain.handle("migration:import", (_e, filePath: string) => { const r = migration.importFromFile(filePath); registerAll(); return r; });
ipcMain.handle("window:openSession", (_e, sessionId?: string) => {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.show();
    mainWin.focus();
    mainWin.webContents.send("window:open-session", sessionId ?? null);
  } else {
    createMainWindow();
    mainWin?.webContents.once("did-finish-load", () => mainWin?.webContents.send("window:open-session", sessionId ?? null));
  }
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
ipcMain.handle("sessions:archive", (_e, sessionId: string, archived: boolean) => store.archiveSession(sessionId, archived));
ipcMain.handle("sessions:delete", (_e, sessionId: string) => store.deleteSession(sessionId));
ipcMain.handle("messages:list", (_e, sessionId: string) => store.listMessages(sessionId));
ipcMain.handle("messages:page", (_e, sessionId: string, opts?: { limit?: number; beforeId?: number }) => store.listMessagesPage(sessionId, opts));
ipcMain.handle("messages:search", (_e, opts?: { q?: string; botId?: string; from?: number; to?: number; limit?: number }) => store.searchMessages(opts));
ipcMain.handle("memory:list", (_e, botId: string) => memory.list(botId));
ipcMain.handle("memory:stats", (_e, botId: string) => {
  const { memoryStats } = require("../core/memory-system");
  return memoryStats(memory.list(botId));
});
ipcMain.handle("memory:search", (_e, botId: string, q: string) => memory.search(botId, q, 10));
ipcMain.handle("memory:retrieve", async (_e, botId: string, q: string) => { const r = await memory.retrieve(botId, q, 10); return r; });
ipcMain.handle("memory:namespaces", () => memory.namespaces());
ipcMain.handle("memory:memo", (_e, ns: string) => memory.memoOf(ns));
ipcMain.handle("memory:setMemo", (_e, ns: string, text: string) => memory.setMemo(ns, text));
ipcMain.handle("memory:rewriteMemo", async (_e, ns: string) => {
  const p = providers.getDefault();
  if (!p) throw new Error("无默认 provider，无法生成总结");
  return memory.rewriteMemo(ns, async (_cur, recent) => {
    const r = await providers.complete(p, {
      system: "把以下记忆压缩为 3-8 条要点权威总结（中文，保留关键事实与偏好）。",
      user: recent.map((e) => `- ${e.content}`).join("\n"),
    });
    return r.text;
  });
});
ipcMain.handle("memory:merge", (_e, ns: string) => memory.mergeDuplicate(ns));
ipcMain.handle("memory:evict", (_e, ns: string, budget: number) => memory.evict(ns, budget));
ipcMain.handle("tools:run", async (_e, tool: string, args: any) => executor.run(tool, args));
ipcMain.handle("mcp:list", () => mcp.listTools());
ipcMain.handle("mcp:call", async (_e, serverId: string, tool: string, args: any) => mcp.callTool(serverId, tool, args));
ipcMain.handle("status:list", () => [...statuses.values()]);
ipcMain.handle("memory:add", (_e, botId: string, entry: any) => memory.add(botId, entry));
ipcMain.handle("memory:delete", (_e, botId: string, id: string) => memory.delete(botId, id));
ipcMain.handle("skills:list", () => skills.list());
ipcMain.handle("skills:create", (_e, text: string) => {
  const parsed = skillFromText(text);
  if (!parsed) throw new Error("没听懂要创建的技能，试试：创建技能：自动周报，每周五总结本周工作");
  return skills.create(parsed.key, parsed.markdown);
});
ipcMain.handle("skills:createRaw", (_e, key: string, markdown: string) => skills.create(key, markdown));
ipcMain.handle("skills:setEnabled", (_e, key: string, enabled: boolean) => skills.setEnabled(key, enabled));
ipcMain.handle("skills:delete", (_e, key: string) => skills.delete(key));
ipcMain.handle("tasks:list", (_e, botId?: string) => botId ? scheduler.listForBot(botId) : scheduler.list());
ipcMain.handle("tasks:create", (_e, input: any) => scheduler.create(input));
ipcMain.handle("tasks:delete", (_e, id: string) => scheduler.delete(id));
ipcMain.handle("tasks:setEnabled", (_e, id: string, enabled: boolean) => scheduler.setEnabled(id, enabled));
ipcMain.handle("tasks:runNow", async (_e, id: string) => { const t = scheduler.list().find((x) => x.id === id); if (t && scheduler.onRun) await scheduler.onRun(t); return scheduler.list().find((x) => x.id === id); });

app.on("window-all-closed", () => {});
