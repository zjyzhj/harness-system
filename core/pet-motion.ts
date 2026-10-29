/**
 * 桌宠具身策略：mood × action × 人设特质 → Live2D / sprite 播放提示。
 * 纯娱乐渲染，不参与 bot 工作回合。
 */
import type { PetActName } from "./pet-director";

export type PetMoodName = "idle" | "happy" | "excited" | "working" | "tired" | "sleepy";

export interface MotionTraits {
  /** persona / card traits 拼起来的短文本 */
  blob?: string;
}

export interface MotionPlan {
  action: PetActName;
  mood: PetMoodName;
  /** Live2D motion group 名（Hiyori/Haru/Mao 常见 Idle / TapBody） */
  live2dGroup: "Idle" | "TapBody" | "none";
  expression: boolean;
  sleepEyes: boolean;
  /** sprite atlas 行（与 pet.js SPRITE_ACTION_ROW 对齐） */
  spriteRow: number;
  holdSec: number;
}

const ACTION_MOOD: Record<PetActName, PetMoodName> = {
  idle: "idle",
  walk: "happy",
  jump: "excited",
  sleep: "sleepy",
  celebrate: "excited",
  work: "working",
  think: "working",
};

const SPRITE_ROW: Record<PetActName, number> = {
  idle: 0,
  walk: 1,
  jump: 4,
  sleep: 6,
  celebrate: 3,
  work: 7,
  think: 8,
};

const DEFAULT_HOLD: Record<PetActName, number> = {
  idle: 0,
  walk: 4,
  jump: 2,
  sleep: 8,
  celebrate: 3,
  work: 5,
  think: 4,
};

/**
 * 按动作 + 人设微调具身。活泼/酷/懒等只影响表情与 hold，不发明新 motion 组。
 */
export function resolveMotion(
  action: PetActName,
  opts?: { holdSec?: number; traits?: MotionTraits; mood?: PetMoodName },
): MotionPlan {
  const blob = opts?.traits?.blob || "";
  const lively = /活泼|萌|可爱|软|嗨|兴奋/.test(blob);
  const cool = /酷|稳|冷静|沉着/.test(blob);
  const lazy = /懒|困|慢|佛系/.test(blob);

  let mood = opts?.mood || ACTION_MOOD[action];
  let hold = opts?.holdSec ?? DEFAULT_HOLD[action];
  let live2dGroup: MotionPlan["live2dGroup"] = "Idle";
  let expression = false;
  let sleepEyes = false;

  switch (action) {
    case "celebrate":
    case "jump":
      live2dGroup = "TapBody";
      expression = lively || !cool;
      if (lively) hold = Math.max(hold, 4);
      break;
    case "walk":
      live2dGroup = "Idle";
      if (lazy) hold = Math.min(hold, 3);
      break;
    case "work":
      live2dGroup = "TapBody";
      expression = true;
      mood = "working";
      if (cool) hold = Math.max(hold, 6);
      break;
    case "think":
      live2dGroup = "none";
      expression = true;
      mood = "working";
      break;
    case "sleep":
      live2dGroup = "none";
      expression = true;
      sleepEyes = true;
      mood = "sleepy";
      if (lazy) hold = Math.max(hold, 10);
      break;
    case "idle":
    default:
      live2dGroup = "Idle";
      expression = lively && Math.random() < 0.35;
      break;
  }

  return {
    action,
    mood,
    live2dGroup,
    expression,
    sleepEyes,
    spriteRow: SPRITE_ROW[action] ?? 0,
    holdSec: hold,
  };
}

/** 从 bot persona / card 抽 traits blob */
export function traitsBlob(bot: { persona?: string; role?: string; personaCard?: { traits?: string[]; catchphrase?: string } }): string {
  return [
    bot.persona || "",
    bot.role || "",
    ...(bot.personaCard?.traits || []),
    bot.personaCard?.catchphrase || "",
  ].join(" ");
}
