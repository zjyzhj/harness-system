/* 语音输入：录音交给 OpenAI 兼容的 /audio/transcriptions（如 SiliconFlow SenseVoice、OpenAI Whisper） */
import { ipcMain, systemPreferences } from "electron";
import { apiFetch } from "../../core/image-tool";
import type { Store } from "../../core/store";

export function registerVoiceIpc(deps: { store: Store; keyCipher: { encrypt(s: string): string }; openStoredKey: (v: unknown) => string }) {
  const { store, keyCipher, openStoredKey } = deps;
  /** 语音输入：录音交给 OpenAI 兼容的 /audio/transcriptions（如 SiliconFlow SenseVoice、OpenAI Whisper） */
  ipcMain.handle("voice:config", (_e, cfg?: { baseUrl: string; apiKey: string; model: string }) => {
    const all = store.readConfig();
    const asr = all.asr as { baseUrl: string; apiKey: string; model: string } | undefined;
    if (cfg) {
      const next = { ...cfg, apiKey: cfg.apiKey === "__keep__" ? asr?.apiKey ?? "" : cfg.apiKey ? keyCipher.encrypt(cfg.apiKey) : "" };
      store.writeConfig({ ...all, asr: next });
      return { ...next, apiKey: next.apiKey ? "***" : "" };
    }
    return asr ? { ...asr, apiKey: asr.apiKey ? "***" : "" } : null;
  });
  ipcMain.handle("voice:micAccess", async () => (process.platform === "darwin" ? systemPreferences.askForMediaAccess("microphone") : true));
  ipcMain.handle("voice:transcribe", async (_e, audio: ArrayBuffer, mime: string) => {
    const asr = store.readConfig().asr as { baseUrl: string; apiKey: string; model: string } | undefined;
    if (!asr?.baseUrl) throw new Error("未配置语音识别");
    const form = new FormData();
    form.append("file", new Blob([audio], { type: mime }), `voice.${mime.includes("mp4") ? "m4a" : "webm"}`);
    form.append("model", asr.model || "whisper-1");
    const res = await apiFetch(`${asr.baseUrl.replace(/\/$/, "")}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${openStoredKey(asr.apiKey)}` }, body: form });
    if (!res.ok) throw new Error(`语音识别失败 ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json() as { text?: string };
    return (j.text ?? "").trim();
  });
}
