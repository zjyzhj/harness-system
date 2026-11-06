// RuntimeDeps / RuntimeOptions：BotRuntime 的依赖与每轮选项
import type { Bot, ContentBlock, MessageMeta, SourceItem } from "../types";
import type { ConsentCenter } from "../consent-center";
import type { AuditLog } from "../audit-log";
import type { ImageGenConfig } from "../image-tool";
import type { Store } from "../store";
import type { ProviderCenter } from "../provider-center";
import type { MemorySystem } from "../memory-system";
import type { SkillRegistry } from "../skill-registry";
import type { SystemKit } from "../system-kit";
import type { SystemAccess } from "../system-access";
import type { ToolExecutor } from "../tool-executor";
import type { ToolOutcome as RegOutcome } from "../tool-registry";
import type { OfflinePersona } from "../offline-persona";
import type { McpClient } from "../mcp-client";
import type { Scheduler } from "../scheduler";
import type { GroupRegistry } from "../group-registry";
import type { SecretStore } from "../secret-store";
import type { EnvStore } from "../env-store";
import type { DemoSkillEngine } from "../demo-skill";
import type { Vault } from "../vault";
import type { ConnectorStore } from "../connectors";

export interface RuntimeDeps {
  store: Store;
  providers: ProviderCenter;
  memory: MemorySystem;
  skills: SkillRegistry;
  system?: SystemKit;
  systemAccess?: SystemAccess;
  executor?: ToolExecutor;
  offline?: OfflinePersona;
  mcp?: McpClient;
  /**
   * 管理本软件的 MCP server 列表（写入 config.json 的 mcpServers 并热重连）。
   * 有了它 bot 才能在对话里安装 / 删除 MCP，而不必让用户去翻配置文件路径。
   */
  mcpManage?: {
    list(): Array<{ id: string; name: string; command?: string; args?: string[]; url?: string; tools: number; error?: string }>;
    /** 若磁盘 config 与内存不一致（例如 bot 用 shell 改了 config.json），重读并热重连；返回是否发生了重载 */
    resync?(): Promise<{ reloaded: boolean; count: number }>;
    add(server: { id?: string; name: string; command?: string; args?: string[]; url?: string; env?: Record<string, string> }): Promise<{ id: string; name: string; tools: number; error?: string }>;
    remove(idOrName: string): Promise<{ removed: string } | { error: string }>;
  };
  /** bot 间通信：from 向名为 target 的 bot 提问并拿到回复；depth 防止互相无限转发 */
  askBot?: (from: Bot, target: string, message: string, depth: number, parentSessionId?: string, signal?: AbortSignal) => Promise<string>;
  tasks?: Pick<Scheduler, "create" | "listForBot" | "delete"> & Partial<Pick<Scheduler, "list">>;
  /** 软件里不归 runtime 管的现状：项目等（main 提供） */
  appFacts?: () => { projects: { name: string; instructions?: string }[] };
  groups?: GroupRegistry;
  /** 以 from 的身份在软件里的群聊发言，群成员接力回应，返回他们的回复 */
  groupPost?: (from: Bot, group: string, message: string, signal?: AbortSignal) => Promise<
    { ok: true; group: string; replies: { name: string; text: string }[]; reason: string; joined?: boolean } | { ok: false; error: string }
  >;
  /** 确认系统通知能弹（必要时发一条并触发授权）；false = 没权限，到点只能在聊天里提醒 */
  notifyCheck?: (title: string, body: string) => Promise<boolean>;
  secrets?: SecretStore;
  /** 环境配置（非敏感的接口地址、账号名、环境变量等） */
  env?: EnvStore;
  /** bot 的工作目录根（每个 bot 一个子目录，fs.write 可写） */
  workspaceRoot?: string;
  /** 软件数据目录（活动账本等）；缺省时 sys.activity 不可用 */
  harnessHome?: string;
  /** bot 通过 app.* / skill.* 改了软件里的数据：通知界面刷新 */
  onAppChanged?: (what: string) => void;
  /** 工具创建 bot 后：主进程刷新侧栏并跳到欢迎会话 */
  onBotCreated?: (ev: { botId: string; sessionId: string }) => void;
  // 桌宠不进 RuntimeDeps — 见 core/pet/sidecar.ts → attachPetEntertainment
  /** 演示→技能：录制本机工具轨迹（可选；无则 demo.* 不可用） */
  demo?: DemoSkillEngine;
  /** 本机保险库聚合（只读 list/contact；无则 vault.* 不可用） */
  vault?: Vault;
  /** 出站 Webhook 登记；有则开放 webhook.list / add / remove / post */
  connectors?: ConnectorStore;
  /** 编码工作线（bot + 工程目录）。无则派工不续会话、聊天不带摘要 */
  codingThreads?: import("../coding-thread").CodingThreadStore;
  /** 编码进程在不在。无则每次派工都是一次性启动 */
  codingPresence?: import("../coding-presence").CodingPresence;
  /** 语义回想：返回注入上下文的一节（没开 / 没命中返回空串）；excludeSession 是当前会话（已在历史里） */
  recall?: (bot: Bot, query: string, excludeSession?: string) => Promise<string>;
  /** 每轮结束时上报这一轮的模型用量（主进程汇总成每日统计） */
  onUsage?: (u: { botId: string; providerId: string; model?: string; input: number; output: number; calls: number; cached: number }) => void;
  /** 图片生成接口配置（未配置时 image.* 工具提示用户去设置） */
  imageConfig?: () => ImageGenConfig | null;
  /** 授权中心：MCP 工具、内网地址、工作区外文件、改共享技能都要过它 */
  consent?: ConsentCenter;
  audit?: AuditLog;
  /**
   * 动作落地判决（可选）。生产默认走模型对照事实；单测可注入，避免假 provider 联网挂死。
   * facts 为 buildActionGroundingFacts 的纯文本。
   */
  judgeAction?: (input: { reply: string; facts: string }) => Promise<{ ok: boolean; issues: string[] }>;
}

export type ToolOutcome = RegOutcome;

export interface RuntimeOptions {
  maxToolRounds?: number;        // 最多工具调用轮数
  injectMemory?: boolean;        // 是否注入记忆
  injectSkills?: boolean;        // 是否注入技能描述
  budgetTokens?: number;         // G1：上下文 token 预算（默认 8000）
  depth?: number;                // bot 间转发深度（用户直聊为 0）
  signal?: AbortSignal;          // 停止生成
  skipUserRecord?: boolean;      // 群聊：用户消息已由调用方记录，只记 bot 回复
  /** 记忆提取用的用户原话（text 里带了群聊规则等包装时传）；null = 这一轮不从用户话里提取 */
  memoryText?: string | null;
  /** 回复里出现「完成/成功」时自动记事件（群聊里 bot 互相聊天时关掉） */
  autoEventMemory?: boolean;
  /** 额外写进这条回复 meta 的字段（群聊的 replyTo / tag） */
  meta?: Partial<MessageMeta>;
  /** 深度思考：换推理模型，没有推理模型时让模型先在 <think> 里分析 */
  think?: boolean;
  /** 全局 / 项目自定义指令 */
  extraSystem?: string;
  /** 无人值守（定时任务 / 自动执行）：没有用户能回答提问 / 确认 */
  unattended?: boolean;
  /** 内部：本轮走原生 function calling（影响工具说明的写法） */
  nativeTools?: boolean;
}

/** 一轮回复里共享的状态：联网来源按出现顺序编号，正文用 [n] 引用 */
export interface TurnCtx {
  sources: SourceItem[];
  userImages?: ContentBlock[];
  signal?: AbortSignal;
  unattended?: boolean;
  /** 长工具运行中刷新卡片摘要（如 cli.agent 进度尾） */
  onToolProgress?: (text: string) => void;
}
