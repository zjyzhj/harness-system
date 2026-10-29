/**
 * 桌宠节拍脚本：把一句话/特效展开成短序列（娱乐向，不占 bot 工作回合）。
 */
import { PET_ACTIONS, type PetActName } from "./pet-director";
import { inferEffectFromPhrase } from "./pet-effects";

export type PetBeat =
  | { type: "action"; action: PetActName; hold?: number }
  | { type: "fx"; phrase: string }
  | { type: "say"; text: string; title?: string }
  | { type: "wait"; ms: number };

const MAX_BEATS = 6;

/** 常见娱乐短语 → 节拍（规则快路径） */
export function expandPhraseToBeats(phrase: string): PetBeat[] | null {
  const t = phrase.trim();
  if (!t) return null;

  if (/大招|必杀|龟派|气功|冲击波|开大/.test(t)) {
    return [
      { type: "action", action: "celebrate", hold: 1 },
      { type: "fx", phrase: t },
      { type: "action", action: "jump", hold: 2 },
      { type: "say", text: "嘿！看招～", title: "特效" },
    ];
  }
  if (/比心|爱心|心动/.test(t)) {
    return [
      { type: "fx", phrase: t.includes("比心") ? t : "比心" },
      { type: "action", action: "celebrate", hold: 2 },
      { type: "say", text: "比心！", title: "特效" },
    ];
  }
  if (/睡觉|晚安|眯一/.test(t)) {
    return [
      { type: "say", text: "那我眯一会儿…", title: "休息" },
      { type: "action", action: "sleep", hold: 8 },
    ];
  }
  if (/加油|冲|打气/.test(t)) {
    return [
      { type: "action", action: "celebrate", hold: 2 },
      { type: "fx", phrase: "气场" },
      { type: "say", text: "加油！我在呢。", title: "打气" },
    ];
  }
  // 能推断出特效的短语 → fx + 小庆祝
  const inferred = inferEffectFromPhrase(t);
  if (inferred && !/^(跳|走|睡|想|工作)/.test(t)) {
    return [
      { type: "fx", phrase: t },
      { type: "action", action: "celebrate", hold: 2 },
    ];
  }
  return null;
}

/** 解析模型/导演返回的 beats JSON 数组 */
export function parseBeats(raw: unknown): PetBeat[] | null {
  if (!Array.isArray(raw)) return null;
  const out: PetBeat[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const j = item as Record<string, unknown>;
    const type = String(j.type || "");
    if (type === "action") {
      const action = String(j.action || "").toLowerCase() as PetActName;
      if (!PET_ACTIONS.includes(action)) continue;
      const hold = j.hold != null ? Number(j.hold) : j.holdSec != null ? Number(j.holdSec) : undefined;
      out.push({ type: "action", action, hold: Number.isFinite(hold) ? hold : undefined });
    } else if (type === "fx") {
      const phrase = String(j.phrase || j.text || "").trim();
      if (phrase) out.push({ type: "fx", phrase: phrase.slice(0, 40) });
    } else if (type === "say") {
      const text = String(j.text || "").trim();
      if (text) out.push({ type: "say", text: text.slice(0, 80), title: j.title ? String(j.title).slice(0, 20) : undefined });
    } else if (type === "wait") {
      const ms = Number(j.ms ?? j.delayMs ?? 0);
      if (ms > 0) out.push({ type: "wait", ms: Math.min(3000, Math.max(100, ms)) });
    }
    if (out.length >= MAX_BEATS) break;
  }
  return out.length ? out : null;
}

/** 从模型整段文本里抠 beats */
export function parseBeatsFromText(raw: string): PetBeat[] | null {
  const m = (raw || "").match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    return parseBeats(JSON.parse(m[0]));
  } catch {
    return null;
  }
}

/** 估算整段脚本时长（宿主调度用） */
export function estimateScriptMs(beats: PetBeat[]): number {
  let ms = 0;
  for (const b of beats) {
    if (b.type === "wait") ms += b.ms;
    else if (b.type === "action") ms += (b.hold ?? 2) * 1000;
    else if (b.type === "fx") ms += 1800;
    else if (b.type === "say") ms += 1200;
  }
  return Math.min(12_000, Math.max(800, ms));
}

export const PET_SCRIPT_MAX_BEATS = MAX_BEATS;
