/**
 * Harness Bot — Electron 壳
 * Tray(菜单栏) + 主控窗口 + 宠物窗口(无边框透明)
 * 核心逻辑全部在 core/（纯 TS），这里只做宿主桥接。
 */
import { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, Notification, screen, nativeImage } from "electron";
import { join } from "node:path";
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
import { Migration } from "../core/migration";
import { SystemKit } from "../core/system-kit";

const home = process.env.HARNESS_HOME || join(app.getPath("userData"), "..", "harness-bot");
const store = new Store(home);
const assetsDir = join(home, "assets");
const registry = new AgentRegistry(store);
const bus = new MessageBus(store);
const providers = new ProviderCenter(store);
const persona = new PersonaGenerator(store, assetsDir);
const migration = new Migration(store, assetsDir);
const system = new SystemKit({
  allowedRoot: join(home, "workspace"),
  notify: (p) => new Notification({ title: p.title, body: p.body }).show() as unknown as boolean,
  clipboardWrite: (t) => clipboard.writeText(t),
  clipboardRead: () => clipboard.readText(),
});

// 为所有 bot 注册默认消息处理器：调用其绑定的 provider 生成回复
async function defaultHandler(from: any, to: any, text: string, ctx: any): Promise<string> {
  const bot = store.getBot(to.id);
  const prov = bot && (providers.get(bot.providerId) || providers.getDefault());
  if (!prov) return `⚠️ ${to.name} 还没有可用模型配置，请先在设置中添加 provider。`;
  const r = await providers.complete(prov, {
    model: bot?.model,
    system: bot?.systemPrompt,
    user: text,
    history: store.listMessages(ctx.sessionId).slice(-8).map((m) => ({ sessionId: m.sessionId, from: m.from, to: m.to, role: m.role, content: m.content, kind: m.kind, createdAt: m.createdAt })),
  });
  return r.text;
}

// 注册已有 bot + 新 bot 时自动注册
function registerAll() {
  for (const b of store.listBots()) bus.register(b.id, defaultHandler);
}
registerAll();

let tray: Tray | null = null;
let mainWin: BrowserWindow | null = null;
const petWins = new Map<string, BrowserWindow>();

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
  const [x, y] = (store.listPets().find((p) => p.botId === botId) ? [store.listPets().find((p) => p.botId === botId)!.x, store.listPets().find((p) => p.botId === botId)!.y] : [screen.getPrimaryDisplay().workAreaSize.width - 260, screen.getPrimaryDisplay().workAreaSize.height - 340]);
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
  win.on("closed", () => petWins.delete(botId));
  win.on("moved", () => {
    const [bx, by] = win.getPosition();
    store.savePet({ botId, x: bx, y: by, visible: true });
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
ipcMain.handle("persona:generate", async (_e, id: string, desc: string) => {
  const bot = store.getBot(id);
  if (!bot) throw new Error("bot 不存在");
  return persona.generate(bot, desc);
});
ipcMain.handle("chat:send", async (_e, botId: string, text: string, sessionId?: string) => {
  const bot = store.getBot(botId);
  if (!bot) throw new Error("bot 不存在");
  return bus.chat(bot, text, sessionId);
});
ipcMain.handle("bus:send", async (_e, fromId: string, toId: string, text: string) => {
  const from = store.getBot(fromId), to = store.getBot(toId);
  if (!from || !to) throw new Error("bot 不存在");
  return bus.send(from, to, text);
});
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
ipcMain.handle("pets:list", () => store.listPets());
ipcMain.handle("pets:save", (_e, p: { botId: string; x: number; y: number; visible: boolean }) => store.savePet(p));
ipcMain.handle("sessions:list", (_e, botId?: string) => store.listSessions(botId));
ipcMain.handle("messages:list", (_e, sessionId: string) => store.listMessages(sessionId));

app.on("window-all-closed", () => {});
