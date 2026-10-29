/** 灵境 Presence：独立于 Bot 的「留人」实体（文本 + 音色；视频延后） */

export type PresenceConsentRole = "self" | "with-consent" | "kin";

export interface PresenceConsent {
  affirmedAt: number;
  role: PresenceConsentRole;
  /** 用户勾选时确认的声明原文（落盘备查） */
  statement: string;
}

export type PresenceVoiceStatus = "none" | "ready" | "error";

export interface PresenceVoice {
  status: PresenceVoiceStatus;
  /**
   * 远端音色 id，或 OpenAI 系预设名（alloy / coral …）。
   * cloneMode=inline 时可空，合成时带本机参考音。
   */
  remoteVoiceId?: string;
  /** 本机参考音频路径 */
  refPath?: string;
  /** 参考音频对应文案（克隆质量关键） */
  refText?: string;
  error?: string;
  /** 最近一次试听/合成时间 */
  clonedAt?: number;
}

export interface Presence {
  id: string;
  /** 称呼（对话里怎么叫 TA） */
  name: string;
  /** 与用户的关系，如「外婆」「挚友」 */
  relation?: string;
  /** 其人痕迹：性格、生平、相处方式（用户填写） */
  bio?: string;
  /** 说话方式备注 */
  styleNotes?: string;
  /** 语料摘录：聊天/信件片段，锚定口吻，禁止无限续造 */
  corpus?: string;
  providerId: string;
  consent: PresenceConsent;
  voice: PresenceVoice;
  createdAt: number;
  updatedAt: number;
  archived?: boolean;
}

/**
 * 音色克隆方式（任意兼容供应商）：
 * - none   — 只用 voice 名/id
 * - upload — 先上传注册再合成
 * - inline — 每次合成附带参考音
 */
export type TtsCloneMode = "none" | "upload" | "inline";

export interface TtsConfig {
  baseUrl: string;
  apiKey?: string;
  /** 模型名，由所用供应商决定，无默认绑死 */
  model: string;
  cloneMode?: TtsCloneMode;
  /** upload 模式路径，默认 /uploads/audio/voice */
  uploadPath?: string;
  /** none 模式默认 voice 名 */
  defaultVoice?: string;
}

export const PRESENCE_SESSION_PREFIX = "presence:";

export function presenceSessionOwner(presenceId: string): string {
  return `${PRESENCE_SESSION_PREFIX}${presenceId}`;
}

export function parsePresenceOwner(botId: string): string | null {
  return botId.startsWith(PRESENCE_SESSION_PREFIX) ? botId.slice(PRESENCE_SESSION_PREFIX.length) : null;
}

/** 创建时用户必须确认的声明 */
export const PRESENCE_CONSENT_STATEMENT =
  "我确认有权使用此人的声音与个人痕迹创建灵境 Presence；仅供私密联结，不用于欺诈、公开传播或冒充真人；我知悉回复由 AI 生成，并非本人实时在场；我可随时封存或删除。";
