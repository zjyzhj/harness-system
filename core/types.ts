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
  /** 手动指定 wire 协议（探测失败时兜底）：chat/completions 或 responses */
  wireApi?: "chat" | "responses";
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
  /** G3：宠物皮肤 id（pixel/cute/default…） */
  skinId?: string;
}

export interface PersonaCard {
  name: string;
  traits: string[];
  catchphrase?: string;
  background?: string;
  interactionStyle?: string;
}

// ---- V3 消息内容块（对齐 Claude/OpenAI content blocks）----

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "code"; lang?: string; code: string }
  | { type: "image"; path?: string; url?: string; dataUrl?: string; alt?: string }
  | { type: "tool_call"; tool: string; args?: Record<string, unknown>; callId?: string; result?: string; status?: "ok" | "error" | "running" | "queued" }
  | { type: "file"; path: string; name: string; size?: number }
  | { type: "thinking"; text: string };

export type MessageContent = string | ContentBlock[];

/** 消息 meta（V3）：模型/耗时/token */
export interface MessageMeta {
  providerId?: string;
  model?: string;
  latencyMs?: number;
  tokensUsed?: number;
  streamed?: boolean;
}

export interface ChatMessage {
  id?: number;
  sessionId: string;
  from: string;
  to: string;
  role: "user" | "assistant" | "system";
  content: string | ContentBlock[];
  kind: "chat" | "bot-to-bot" | "event";
  createdAt: number;
  meta?: MessageMeta;
}

/** 取消息可投递给 LLM 的纯文本（数组时拼接 text/thinking 块） */
export function contentText(c: string | ContentBlock[]): string {
  if (typeof c === "string") return c;
  return c
    .filter((b) => b.type === "text" || b.type === "thinking")
    .map((b) => (b as { text?: string }).text ?? "")
    .join("\n");
}

/** 消息是否含图片等非文本块 */
export function hasRichContent(c: string | ContentBlock[]): boolean {
  return Array.isArray(c) && c.some((b) => b.type !== "text" && b.type !== "thinking");
}

export interface Session {
  id: string;
  botId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** G1：归档标记（软归档，不进列表） */
  archived?: boolean;
  /** G1：消息总数（SessionIndex 维护） */
  messageCount?: number;
  /** G1：已压缩边界 seq（增量摘要去重） */
  lastSeq?: number;
  /** G1：token 估算（累计） */
  tokenEstimate?: number;
}

/** G1：搜索命中 */
export interface SearchHit {
  sessionId: string;
  botId: string;
  msgId: number;
  snippet: string;
  createdAt: number;
  role: string;
}


export interface PetState {
  botId: string;
  x: number;
  y: number;
  visible: boolean;
  /** G3：多显示器记忆 — 记录所在显示器 id，重启后恢复到同一屏幕 */
  displayId?: number;
}

export interface MigrationPayload {
  format: "harness-bot-migration/v2";
  exportedAt: string;
  providers: Provider[];
  bots: Bot[];
  pets: PetState[];
  assets?: Record<string, string>;
  /** V2：全量迁移 */
  memory?: Record<string, MemoryEntry[]>;
  skills?: Record<string, string>;        // skill key -> SKILL.md 内容
  tasks?: ScheduledTask[];
}

// ---- V3 适配器抽象（对齐 CowAgent LLMModel）----

export interface ToolDescription {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface LLMRequest {
  model?: string;
  system?: string;
  history?: ChatMessage[];
  user?: string | ContentBlock[];
  tools?: ToolDescription[];
  temperature?: number;
  stream?: boolean;
}

export interface LLMResponse {
  content: ContentBlock[];
  raw?: unknown;
  usage?: { inputTokens?: number; outputTokens?: number };
  model?: string;
  finishReason?: string;
}

export type StreamChunk = ContentBlock | { type: "done"; usage?: LLMResponse["usage"] } | { type: "error"; message: string };

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
  /** G2：命名空间（bot:<id> | group:<name> | global）；缺省 = bot:<botId> */
  namespace?: string;
  /** G2：语义检索缓存向量（hash 或 OpenAI） */
  vector?: number[];
  /** G2：嵌入器标记（hash | openai） */
  vectorKind?: "hash" | "openai";
}

export interface ScheduledTask {
  id: string;
  botId: string;
  name: string;
  cron: string;                // 5 段 cron
  prompt?: string;              // 到期时给 bot 的指令（once 闹钟可省略）
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt?: number;
  runCount: number;
  createdAt: number;
  /** V2-D：失败重试与日志 */
  maxRetries?: number;
  retryCount?: number;
  lastResult?: string;
  lastError?: string;
  lastRunLog?: string;
  /** G3：一次性闹钟（kind="once"） */
  kind?: "cron" | "once";
  alarmAt?: number;
  /** G3：到期是否推送到宠物气泡 */
  notifyPet?: boolean;
  /** G3：一次性闹钟关联的会话 id（用于宠物「打开会话」跳转） */
  sessionId?: string;
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
  /** G3：富内容块（工具卡/代码/图片），供宠物/面板展示 */
  content?: ContentBlock[];
}

// ---- V2 扩展 ----

export interface AgentStatus {
  botId: string;
  state: "idle" | "running" | "error";
  lastRunAt?: number;
  lastError?: string;
  currentTask?: string;
}

export interface SkillUsageLog {
  key: string;
  botId: string;
  invokedAt: number;
  ok: boolean;
  outputPreview?: string;
}

export interface TaskRunLog {
  taskId: string;
  ranAt: number;
  ok: boolean;
  error?: string;
  prompt: string;
}
