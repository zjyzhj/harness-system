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
  /** 工具调用方式：默认 native（原生 function calling，端点不支持时自动退回 text 工具块） */
  toolMode?: "native" | "text";
  /** 深度思考时换用的推理模型（DeepSeek 不填自动用 deepseek-reasoner） */
  thinkModel?: string;
  /** 模型上下文窗口（token），不填按模型名估计 */
  contextTokens?: number;
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
  /** 形状头像（没有 avatarPath 时显示） */
  avatar?: { shape: string; color: string };
  personaCard?: PersonaCard;
  createdAt: number;
  /** G3：宠物皮肤 id（pixel/cute/default…） */
  skinId?: string;
  /** 换装前的皮肤，便于「换回去」 */
  prevSkinId?: string;
  /** 主控 bot：置顶显示，负责调度其他成员 */
  isMaster?: boolean;
  /** 模型路由：复杂任务先让推理模型想清楚再执行并自检。默认主控 auto、其他 off */
  reasoning?: "auto" | "always" | "off";
  /** 左栏手动排序（越小越靠前） */
  order?: number;
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
  /** textPath：附件抽出的全文（PDF / Word / 表格等），chars 为字数 */
  | { type: "file"; path: string; name: string; size?: number; textPath?: string; chars?: number; error?: string }
  /** ms：思考用时 */
  | { type: "thinking"; text: string; ms?: number }
  /** 撤回本轮已流式推送的正文（纠偏 / 截断工具块后的假结果），不落盘 */
  | { type: "retract" }
  /** 联网搜索 / 打开过的网页，正文里的 [1] [2] 对应这里的序号 */
  | { type: "sources"; items: SourceItem[] }
  /** 让用户点选的问题卡片：mode=confirm 时是「确认 / 修改 / 取消」 */
  | { type: "choice"; id: string; question: string; options: string[]; mode?: "choice" | "confirm"; detail?: string; answer?: string }
  /** 让用户在加密输入框里填写的密钥，值只存本机，不进对话 */
  | { type: "secret"; name: string; label: string; note?: string; scope?: "all"; saved?: boolean }
  /** 群聊主持人的结论卡片：决定了什么、谁负责什么、还有什么没定 */
  | { type: "conclusion"; summary: string; decisions: string[]; tasks: ConclusionTask[]; open?: string[] };

export interface SourceItem { title: string; url: string; snippet?: string }

export interface ConclusionTask { owner: string; ownerId?: string; task: string; done?: boolean; dispatched?: boolean }

export type MessageContent = string | ContentBlock[];

/** 消息 meta（V3）：模型/耗时/token */
export interface MessageMeta {
  /** 发给模型时按原样带上图片等块（工具循环里的当前问题） */
  inline?: boolean;
  /** 定时任务到点后发回原会话的结果（值为任务名） */
  scheduled?: string;
  /** bot 主动跟进（不是对用户消息的回复） */
  proactive?: boolean;
  /** 这一轮所有模型调用的用量合计（含推理预想、自检、工具轮、压缩） */
  /** cached：输入里命中前缀缓存的部分（DeepSeek 约 1/10 计费） */
  usage?: { input: number; output: number; calls: number; cached?: number };
  providerId?: string;
  model?: string;
  latencyMs?: number;
  tokensUsed?: number;
  streamed?: boolean;
  /** 群聊：这条是回应谁的（bot id 或 "user"） */
  replyTo?: string;
  /** 群聊：主持人的小结 / 结论 */
  tag?: "summary" | "conclusion";
  /** 回复后给用户的追问建议 */
  suggestions?: string[];
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
    .map((b) => {
      if (b.type === "text") return b.text ?? "";
      if (b.type === "thinking") return null;
      if (b.type === "file") return `[附件 ${b.name}${b.textPath ? `，全文 ${b.textPath}` : ""}]`;
      if (b.type === "choice") {
        const opts = b.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join(" / ");
        return `[${b.mode === "confirm" ? "请用户确认" : "请用户选择"}] ${b.question}${b.detail ? `（${b.detail}）` : ""}${b.mode === "confirm" ? "" : ` 选项：${opts}`}${b.answer ? ` → 用户已选：${b.answer}` : ""}`;
      }
      if (b.type === "secret") return `[请用户填写密钥「${b.label}」(${b.name})${b.saved ? "，已保存" : ""}]`;
      if (b.type === "conclusion") {
        return [`【讨论结论】${b.summary}`, ...b.decisions.map((d) => `- 决定：${d}`), ...b.tasks.map((t) => `- ${t.owner} 负责：${t.task}${t.done ? "（已完成）" : t.dispatched ? "（已分派）" : ""}`), ...(b.open ?? []).map((o) => `- 待定：${o}`)].join("\n");
      }
      return null;
    })
    .filter((t): t is string => t !== null)
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
  /** 压缩边界之前所有消息的累计摘要 */
  summary?: string;
  /** G1：token 估算（累计） */
  tokenEstimate?: number;
  /** 所属项目（共用项目指令和资料） */
  projectId?: string;
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
  /** G5.5：宠物成长经验（回复/任务完成触发，展示等级与经验条） */
  xp?: number;
}

export interface SkinExport {
  name: string;
  color?: string;
  desc?: string;
  fps: number;
  url?: string;
  rows: number;
  cols: number;
  cellW?: number;
  cellH?: number;
  /** 源 spritesheet 文件绝对路径 */
  path: string;
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
  /** G5.5：社区宠物皮肤元数据 + 源文件路径，随迁移往返（导入端重建注册并复制文件） */
  skins?: Record<string, SkinExport>;
  tasks?: ScheduledTask[];
  /** G4：群组与编排计划随迁移往返 */
  groups?: Group[];
  plans?: OrchestrationPlan[];
  /** 普通配置（env.json） */
  env?: { key: string; value: string; label?: string; note?: string; botId?: string; updatedAt: number; updatedBy?: string }[];
  /** 项目与自定义指令；files 里的 path / textPath 是导出端的本机路径，导入时复制 */
  projects?: { id: string; name: string; instructions: string; files: Extract<ContentBlock, { type: "file" }>[]; createdAt: number; updatedAt: number }[];
  instructions?: { about?: string; style?: string };
  commandRules?: { botId: string; command: string; decision: "allow" | "deny"; createdAt: number }[];
  /** 密钥绑定本机钥匙串不能带走，只带名单，导入后提示重新填写 */
  secretNames?: { name: string; label?: string; note?: string; botId?: string }[];
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
  usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number };
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
  owner?: string;              // 私有技能所属 bot id；空 = 所有 bot 共享
}

export interface MemoryEntry {
  id: string;
  botId: string;
  /** rule：用户给 bot 定的做事规范，始终注入；fact：关于用户的事实 / 偏好 */
  kind: "rule" | "fact" | "summary" | "note" | "event";
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
  /** once 任务到点时把 prompt 交给 bot 执行（而不只是闹钟提醒） */
  runPrompt?: boolean;
  /** once 任务执行后自动删除 */
  deleteAfterRun?: boolean;
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
  /** 正在哪个会话里干活；群聊发言时为 group-* */
  sessionId?: string;
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

// ---- G4 协作与编排 ----

/** 群组（与 core/group-registry.ts 的 Group 同构，供迁移序列化） */
export interface Group {
  id: string;
  name: string;
  members: string[];
  admin: string;          // "user" 或 bot id
  createdAt: number;
  settings?: { goal?: string; relay?: boolean; maxTurns?: number; moderator?: string };
}

export type OrchestrationStageMode = "seq" | "fan";

export interface OrchestrationStage {
  id: string;
  botId: string;
  prompt: string;
  mode: OrchestrationStageMode;
  status: "pending" | "running" | "done" | "error";
  result?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  retries: number;
  /** 运行中的实时产出 / 当前动作，不持久化 */
  live?: string;
  activity?: string;
}

export interface OrchestrationPlan {
  id: string;
  ownerBotId: string;       // "user" 或 bot id（仅主控/授权可发起）
  title: string;
  createdAt: number;
  status: "pending" | "running" | "done" | "error";
  stages: OrchestrationStage[];
  currentStage?: string;
  result?: string;          // 最终产出
  startedAt?: number;
  finishedAt?: number;
}
