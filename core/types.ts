export type ProviderKind = "openai-compat" | "cli";

export interface Provider {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  isDefault: boolean;
  cliName?: "codex" | "cursor" | "claude";
  createdAt: number;
}

export interface Bot {
  id: string;
  name: string;
  role: string;
  persona: string;
  providerId: string;
  model?: string;
  systemPrompt?: string;
  petEnabled: boolean;
  avatarPath?: string;
  personaCard?: PersonaCard;
  createdAt: number;
}

export interface PersonaCard {
  name: string;
  traits: string[];
  catchphrase?: string;
  background?: string;
  interactionStyle?: string;
}

export interface ChatMessage {
  id?: number;
  sessionId: string;
  from: string;
  to: string;
  role: "user" | "assistant" | "system";
  content: string;
  kind: "chat" | "bot-to-bot" | "event";
  createdAt: number;
}

export interface Session {
  id: string;
  botId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface PetState {
  botId: string;
  x: number;
  y: number;
  visible: boolean;
}

export interface MigrationPayload {
  format: "harness-bot-migration/v1";
  exportedAt: string;
  providers: Provider[];
  bots: Bot[];
  pets: PetState[];
  assets?: Record<string, string>;
}

// ---- Bot 底层运行时扩展 ----

export interface Skill {
  key: string;                 // 唯一标识（目录名）
  name: string;
  description: string;         // 给 LLM 看的能力描述（用于决定何时调用）
  path: string;                // SKILL.md 绝对路径
  body: string;                // 指令正文（渐进披露：只在需要时注入）
  enabled: boolean;
  always?: boolean;            // true = 总是注入
  requires?: string[];         // 依赖的命令
}

export interface MemoryEntry {
  id: string;
  botId: string;
  kind: "fact" | "summary" | "note" | "event";
  content: string;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
  source?: string;             // 来源：sessionId 或 user
}

export interface ScheduledTask {
  id: string;
  botId: string;
  name: string;
  cron: string;                // 5 段 cron
  prompt: string;              // 到期时给 bot 的指令
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt?: number;
  runCount: number;
  createdAt: number;
}

export interface ToolCall {
  id: string;
  tool: string;                // 技能 key 或内置工具名
  args: Record<string, unknown>;
}

/** 模型在「工具回合」请求调用的工具 */
export interface ToolInvocation {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface RuntimeResult {
  text: string;                // bot 最终回复
  toolCalls: ToolCall[];       // 本次回复前的工具调用记录
  memoryEvents?: MemoryEntry[]; // 本次产生的记忆事件（自动写入）
  usedSkills: string[];        // 实际用到的技能 key
}
