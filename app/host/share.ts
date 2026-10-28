/* 分享对话：导出成单文件 HTML，或离屏渲染成长图（同时复制到剪贴板） */
import { BrowserWindow, app, clipboard, ipcMain } from "electron";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildShareHtml } from "../../core/share-page";
import type { Store } from "../../core/store";
import type { GroupRegistry } from "../../core/group-registry";

const SHARE_W = 760;
/** 按 2 倍像素渲染；离屏窗口太高会截不全，所以 CSS 高度封顶 */
const SHARE_SCALE = 2;
const SHARE_MAX_H = 8_000;

export function registerShareIpc(deps: { appRoot: string; store: Store; groups: GroupRegistry }) {
  const { store, groups } = deps;
  /** 共用渲染器（renderer/common-render.js）在主进程里跑一份，分享页和界面渲染一致 */
  let render: { markdown: (s: string) => string; esc: (s: string) => string } | null = null;
  const getRender = () => {
    if (!render) {
      const src = readFileSync(join(deps.appRoot, "app", "renderer", "common-render.js"), "utf8");
      const lib = new Function(`${src}\nreturn { renderMarkdown, esc };`)() as { renderMarkdown: (s: string) => string; esc: (s: string) => string };
      render = { markdown: lib.renderMarkdown, esc: lib.esc };
    }
    return render;
  };
  const shareHtml = (sessionId: string, msgIds: number[] | undefined, forImage: boolean) => {
    const s = store.getSession(sessionId);
    const all = store.listMessages(sessionId);
    const messages = msgIds?.length ? all.filter((m) => msgIds.includes(m.id!)) : all;
    const g = groups.get(s?.botId ?? "");
    const bot = store.getBot(s?.botId ?? "");
    const title = s?.title || (g ? `群聊「${g.name}」` : bot ? `和 ${bot.name} 的对话` : "对话");
    const avatarOf = (id: string) => {
      const p = store.getBot(id)?.avatarPath;
      return p && existsSync(p) && statSync(p).size < 512 * 1024 ? `data:image/png;base64,${readFileSync(p).toString("base64")}` : null;
    };
    return { title, html: buildShareHtml({ title, messages, nameOf: (id) => store.getBot(id)?.name ?? id, avatarOf, forImage }, getRender()) };
  };

  ipcMain.handle("share:export", async (_e, sessionId: string, format: "png" | "html", msgIds?: number[]) => {
    const outDir = app.getPath("downloads");
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
    if (format === "html") {
      const { title, html } = shareHtml(sessionId, msgIds, false);
      const file = join(outDir, `${title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40)}-${stamp}.html`);
      writeFileSync(file, html, "utf8");
      return { path: file };
    }
    let ids = msgIds?.length ? msgIds : store.listMessages(sessionId).map((m) => m.id!);
    const win = new BrowserWindow({ show: false, width: SHARE_W * SHARE_SCALE, height: 800, webPreferences: { offscreen: true, javascript: true, zoomFactor: SHARE_SCALE } });
    try {
      let height = 0;
      let dropped = 0;
      const tmp = join(app.getPath("temp"), `harness-share-${Date.now()}.html`);
      for (;;) {
        writeFileSync(tmp, shareHtml(sessionId, ids, true).html, "utf8");
        await win.loadFile(tmp);
        height = await win.webContents.executeJavaScript("document.querySelector('.page').scrollHeight");
        if (height <= SHARE_MAX_H || ids.length <= 2) break;
        const cut = Math.max(1, Math.ceil(ids.length * (1 - SHARE_MAX_H / height)));
        ids = ids.slice(cut);
        dropped += cut;
      }
      win.setContentSize(SHARE_W * SHARE_SCALE, Math.min(height, SHARE_MAX_H) * SHARE_SCALE);
      await new Promise((r) => setTimeout(r, 400));
      const img = await win.webContents.capturePage();
      const file = join(outDir, `对话长图-${stamp}.png`);
      writeFileSync(file, img.toPNG());
      clipboard.writeImage(img);
      rmSync(tmp, { force: true });
      return { path: file, dropped };
    } finally {
      win.destroy();
    }
  });
}
