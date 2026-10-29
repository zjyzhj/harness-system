/* 灵境 Presence：CRUD、音色克隆、文本对话 + TTS */
import { ipcMain, dialog, type BrowserWindow } from "electron";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { Store } from "../../core/store";
import type { ProviderCenter } from "../../core/provider-center";
import { RealmStore } from "../../core/realm/store";
import { RealmRuntime } from "../../core/realm/runtime";
import { PRESENCE_CONSENT_STATEMENT, type TtsConfig } from "../../core/realm/types";
import type { CreatePresenceInput } from "../../core/realm/runtime";

export function registerRealmIpc(deps: {
  home: string;
  store: Store;
  providers: ProviderCenter;
  keyCipher: { encrypt(s: string): string };
  openStoredKey: (v: unknown) => string;
  getMainWin: () => BrowserWindow | null;
}) {
  const { store, providers, keyCipher, openStoredKey, getMainWin } = deps;
  const realm = new RealmStore(deps.home);
  const runtime = new RealmRuntime(
    realm,
    store,
    providers,
    () => {
      const c = store.readConfig().tts as TtsConfig | undefined;
      return c?.baseUrl ? c : null;
    },
    openStoredKey,
  );

  const notify = () => {
    const w = getMainWin();
    if (w && !w.isDestroyed()) w.webContents.send("app:changed", "realm");
  };

  ipcMain.handle("realm:consentText", () => PRESENCE_CONSENT_STATEMENT);

  ipcMain.handle("realm:list", (_e, includeArchived?: boolean) => realm.list(!!includeArchived));
  ipcMain.handle("realm:get", (_e, id: string) => realm.get(id) ?? null);

  ipcMain.handle("realm:create", (_e, input: CreatePresenceInput) => {
    const p = runtime.create(input);
    notify();
    return p;
  });

  ipcMain.handle("realm:update", (_e, id: string, patch: {
    name?: string; relation?: string; bio?: string; styleNotes?: string; corpus?: string; providerId?: string;
  }) => {
    const p = realm.update(id, patch);
    notify();
    return p;
  });

  ipcMain.handle("realm:archive", (_e, id: string) => {
    const p = realm.archive(id);
    notify();
    return p;
  });

  ipcMain.handle("realm:remove", (_e, id: string) => {
    realm.remove(id);
    notify();
  });

  ipcMain.handle("realm:ttsConfig", (_e, cfg?: TtsConfig & { apiKey?: string }) => {
    const all = store.readConfig();
    const cur = all.tts as TtsConfig | undefined;
    if (cfg) {
      if (!cfg.baseUrl?.trim() || !cfg.model?.trim()) throw new Error("请填写 Base URL 和模型名");
      const next: TtsConfig = {
        baseUrl: cfg.baseUrl.trim(),
        model: cfg.model.trim(),
        apiKey: cfg.apiKey === "__keep__" ? cur?.apiKey ?? "" : cfg.apiKey ? keyCipher.encrypt(cfg.apiKey) : "",
        cloneMode: cfg.cloneMode,
        uploadPath: cfg.uploadPath?.trim() || undefined,
        defaultVoice: cfg.defaultVoice?.trim() || undefined,
      };
      store.writeConfig({ ...all, tts: next });
      return { ...next, apiKey: next.apiKey ? "***" : "" };
    }
    return cur ? { ...cur, apiKey: cur.apiKey ? "***" : "" } : null;
  });

  /** 预设音色名（cloneMode=none） */
  ipcMain.handle("realm:setPresetVoice", async (_e, presenceId: string, voiceName: string) => {
    const p = await runtime.bindVoice(presenceId, { refText: voiceName, voiceName });
    notify();
    return p;
  });

  /** 选本地参考音频文件并克隆 */
  ipcMain.handle("realm:cloneVoice", async (_e, presenceId: string, refText: string) => {
    const win = getMainWin();
    const opts = {
      title: "选择参考录音（建议 8–10 秒、单人、无背景噪音）",
      properties: ["openFile"] as Array<"openFile">,
      filters: [{ name: "音频", extensions: ["mp3", "wav", "m4a", "webm", "ogg", "opus"] }],
    };
    const r = win && !win.isDestroyed()
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths[0]) return null;
    const src = r.filePaths[0];
    const buf = readFileSync(src);
    const ext = extname(src).slice(1) || "mp3";
    const refPath = realm.saveRefAudio(presenceId, buf, ext);
    const p = await runtime.bindVoice(presenceId, { refPath, refText: refText || "" });
    notify();
    return p;
  });

  /** 渲染进程录音 ArrayBuffer → 克隆 */
  ipcMain.handle("realm:cloneVoiceBuf", async (_e, presenceId: string, audio: ArrayBuffer, mime: string, refText: string) => {
    const ext = mime.includes("wav") ? "wav" : mime.includes("mp4") || mime.includes("m4a") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm";
    const refPath = realm.saveRefAudio(presenceId, Buffer.from(audio), ext);
    const p = await runtime.bindVoice(presenceId, { refPath, refText: refText || "" });
    notify();
    return p;
  });

  ipcMain.handle("realm:previewVoice", async (_e, presenceId: string, text?: string) => {
    return runtime.previewVoice(presenceId, text);
  });

  ipcMain.handle("realm:chat", async (_e, presenceId: string, text: string, sessionId?: string) => {
    const result = await runtime.turn(presenceId, text, sessionId);
    notify();
    return result;
  });

  ipcMain.handle("realm:messages", (_e, sessionId: string) => store.listMessages(sessionId));
  ipcMain.handle("realm:sessions", (_e, presenceId: string) =>
    store.listSessions(`presence:${presenceId}`));

  return { realm, runtime };
}

// re-export for typing in create handler
export type { CreatePresenceInput };
