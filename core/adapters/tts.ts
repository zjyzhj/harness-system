/**
 * TTS / 音色：任意 OpenAI 兼容 `/audio/speech`；克隆按 cloneMode 分支，不绑死某一家。
 *
 * cloneMode:
 * - none   — 只用 voice 名/id（OpenAI alloy、中转预设音色等）
 * - upload — 先 POST uploadPath 注册音色，再 speech（如 SiliconFlow /uploads/audio/voice）
 * - inline — 每次合成带 references[{audio,text}]（CosyVoice 系零样本；自建兼容端亦可）
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { apiFetch } from "../image-tool";
import type { TtsCloneMode, TtsConfig } from "../realm/types";

const MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".pcm": "audio/pcm",
};

export function audioDataUrl(path: string): string {
  const ext = extname(path).toLowerCase();
  const mime = MIME[ext] ?? "audio/mpeg";
  return `data:${mime};base64,${readFileSync(path).toString("base64")}`;
}

function base(cfg: TtsConfig): string {
  if (!cfg.baseUrl) throw new Error("未配置语音合成接口（填任意 OpenAI 兼容的 /v1）");
  return cfg.baseUrl.replace(/\/$/, "");
}

function auth(cfg: TtsConfig): Record<string, string> {
  return cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {};
}

/** 未显式指定时：有 uploadPath → upload；模型名像克隆系 → inline；否则 none */
export function resolveCloneMode(cfg: TtsConfig): TtsCloneMode {
  if (cfg.cloneMode) return cfg.cloneMode;
  if (cfg.uploadPath) return "upload";
  if (/cosyvoice|fish-speech|fishaudio|gpt-sovits|clone/i.test(cfg.model || "")) return "inline";
  return "none";
}

export interface UploadVoiceInput {
  refPath: string;
  refText: string;
  customName: string;
  model?: string;
}

/** 上传参考音频，返回远端 voice id；仅 cloneMode=upload */
export async function uploadVoiceClone(cfg: TtsConfig, input: UploadVoiceInput): Promise<string> {
  const model = input.model || cfg.model;
  if (!model) throw new Error("未填写 TTS 模型名");
  const path = (cfg.uploadPath || "/uploads/audio/voice").replace(/^\//, "");
  const form = new FormData();
  form.append("model", model);
  form.append("customName", input.customName.slice(0, 64) || "presence");
  form.append("text", input.refText.trim() || "这是一段用于音色克隆的参考录音。");
  form.append("audio", audioDataUrl(input.refPath));

  const res = await apiFetch(`${base(cfg)}/${path}`, {
    method: "POST",
    headers: auth(cfg),
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 400);
    throw new Error(`上传音色失败 ${res.status}: ${body}`);
  }
  const raw = await res.text();
  let id = raw.trim();
  try {
    const j = JSON.parse(raw) as { uri?: string; voice?: string; data?: string; id?: string };
    id = j.uri || j.voice || j.data || j.id || id;
  } catch { /* 纯文本 id */ }
  id = id.replace(/^"|"$/g, "").trim();
  if (!id) throw new Error("上传音色成功但未返回 voice id");
  return id;
}

export interface SpeakInput {
  text: string;
  /** 远端 voice id / 预设音色名；inline 时可空 */
  voice?: string;
  model?: string;
  speed?: number;
  format?: "mp3" | "wav" | "opus" | "pcm";
  /** inline 克隆：本机参考音 */
  refPath?: string;
  refText?: string;
}

/** 文本 → 音频二进制 */
export async function synthesizeSpeech(cfg: TtsConfig, input: SpeakInput): Promise<{ buf: Buffer; format: string }> {
  const text = input.text.trim();
  if (!text) throw new Error("没有可朗读的文字");
  const format = input.format || "mp3";
  const model = input.model || cfg.model;
  if (!model) throw new Error("未填写 TTS 模型名");
  const mode = resolveCloneMode(cfg);

  const body: Record<string, unknown> = {
    model,
    input: text.slice(0, 2000),
    response_format: format,
    speed: input.speed ?? 1,
  };

  if (mode === "inline" && input.refPath) {
    body.voice = input.voice || "";
    body.references = [{
      audio: audioDataUrl(input.refPath),
      text: (input.refText || "").trim() || "参考录音。",
    }];
  } else {
    const voice = input.voice || cfg.defaultVoice;
    if (!voice) throw new Error("未绑定音色（请上传参考音，或填写预设 voice 名）");
    body.voice = voice;
  }

  const res = await apiFetch(`${base(cfg)}/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth(cfg) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const errBody = (await res.text()).slice(0, 400);
    throw new Error(`语音合成失败 ${res.status}: ${errBody}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error("语音合成返回空音频");
  return { buf, format };
}
