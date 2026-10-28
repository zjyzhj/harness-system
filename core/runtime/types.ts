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
  /** 软件里不归 runtime 管的现状：编排计划、项目（main 提供） */
  appFacts?: () => { plans: { title: string; status: string }[]; projects: { name: string; instructions?: string }[] };
  groups?: GroupRegistry;
  /** 编排计划：bot 在聊天里发起 / 查看 / 停止（main 提供，跑完把结果发回发起的会话） */
  plans?: {
    start(req: { requester: Bot; sessionId?: string; task?: string; title?: string; stages?: Array<{ bot: string; prompt: string; mode?: string }> }): Promise<{ title: string; steps: string[] }>;
    list(): Array<{ id: string; title: string; status: string; result?: string }>;
    cancel(match: string): string | null;
  };
  /** 以 from 的身份在软件里的群聊发言，群成员接力回应，返回他们的回复 */
  groupPost?: (from: Bot, group: string, message: string, signal?: AbortSignal) => Promise<
    { ok: true; group: string; replies: { name: string; text: string }[]; reason: string } | { ok: false; error: string }
  >;
  /** 确认系统通知能弹（必要时发一条并触发授权）；false = 没权限，到点只能在聊天里提醒 */
  notifyCheck?: (title: string, body: string) => Promise<boolean>;
  secrets?: SecretStore;
  /** 环境配置（非敏感的接口地址、账号名、环境变量等） */
  env?: EnvStore;
  /** bot 的工作目录根（每个 bot 一个子目录，fs.write 可写） */
  workspaceRoot?: string;
  /** bot 通过 app.* / skill.* 改了软件里的数据：通知界面刷新 */
  onAppChanged?: (what: string) => void;
  /**
   * 桌宠宿主（main 注入）：Bot 通过 pet.* 工具操作「桌面表现层」。
   * 自己上台/藏起/换装/查状态 = 基础；召唤别人 / 互访 = 受 prefs 闸门。
   */
  petHost?: {
    show: (botId: string) => void;
    /** 只藏窗口，不关 petEnabled */
    hide: (botId: string) => void;
    skinLabel: (botId: string) => string;
    /** 当前是否在桌面可见 */
    isShown?: (botId: string) => boolean;
    /** 经验值 */
    xp?: (botId: string) => number;
    listSkins?: () => Array<{ id: string; name: string }>;
    setSkin?: (botId: string, skinId: string) => { ok: true; label: string } | { ok: false; error: string };
    /** 搜 petdex 社区库（需能访问网络） */
    searchCatalog?: (query: string) => Promise<Array<{ slug: string; name: string; id: string; installed: boolean }>>;
    /** 下载并登记到本地形象列表；可选立刻换上 */
    installCatalog?: (slug: string, opts?: { name?: string; wearBotId?: string }) => Promise<
      { ok: true; id: string; label: string; worn: boolean } | { ok: false; error: string }
    >;
    maySpawn: () => boolean;
    mayVisit?: () => boolean;
    /** from 去拜访 to；返回文案或错误 */
    visit?: (fromId: string, toId: string) =>
      | { ok: true; line: string }
      | { ok: false; error: string }
      | Promise<{ ok: true; line: string } | { ok: false; error: string }>;
    visitHistory?: (botId: string, limit?: number) => Array<{
      fromName: string; toName: string; lineFrom: string; lineTo: string; at: number; fromId: string; toId: string;
    }>;
    revertSkin?: (botId: string) => { ok: true; label: string } | { ok: false; error: string };
    generatePersona?: (botId: string, desc: string, style?: string) => Promise<
      | {
          ok: true;
          name: string;
          message: string;
          imaged: boolean;
          codeDrawn?: boolean;
          skin?: string;
          suggestions?: Array<{ kind: string; id: string; name: string }>;
        }
      | { ok: false; error: string }
    >;
    /** 彻底下台：关 petEnabled 并关窗 */
    disable?: (botId: string) => void;
    prefs?: (botId: string) => Record<string, unknown>;
    setPrefs?: (botId: string, patch: Record<string, unknown>) => Record<string, unknown>;
    evolveList?: (botId: string, mode: "pending" | "history") => Array<{
      id: string; title: string; detail: string; status: string; kind: string; createdAt: number;
    }>;
    evolveDecide?: (botId: string, action: "accept" | "reject", id?: string) =>
      { ok: true; title: string; status: string } | { ok: false; error: string };
    /** 纯宠物闹钟（气泡提醒，不跑对话） */
    remind?: (botId: string, delayMs: number, text: string) => { ok: true; at: number } | { ok: false; error: string };
    /** 让桌宠做动作：idle/walk/jump/sleep/celebrate/work/think */
    act?: (botId: string, action: string, holdSec?: number) => { ok: true; action: string } | { ok: false; error: string };
    /** 气泡说一句（不跑整轮对话）；可选顺带做动作 */
    say?: (botId: string, text: string, opts?: { title?: string; action?: string; holdSec?: number }) =>
      { ok: true } | { ok: false; error: string };
    /**
     * 叠加特效（不改皮肤，可还原）。phrase 可「放出龟派气功」——命中或新建自定义配方。
     * action=list|play|pin|unpin|forget|gc
     */
    fx?: (botId: string, args: {
      action?: string;
      phrase?: string;
      name?: string;
      sticky?: boolean;
    }) => Promise<
      | {
          ok: true;
          message: string;
          effect?: { id: string; name: string; kind: string; created?: boolean };
          list?: Array<{ id: string; name: string; kind: string; sticky?: boolean; useCount: number }>;
        }
      | { ok: false; error: string }
    >;
  };
  /** 语义回想：返回注入上下文的一节（没开 / 没命中返回空串）；excludeSession 是当前会话（已在历史里） */
  recall?: (bot: Bot, query: string, excludeSession?: string) => Promise<string>;
  /** 每轮结束时上报这一轮的模型用量（主进程汇总成每日统计） */
  onUsage?: (u: { botId: string; providerId: string; model?: string; input: number; output: number; calls: number; cached: number }) => void;
  /** 图片生成接口配置（未配置时 image.* 工具提示用户去设置） */
  imageConfig?: () => ImageGenConfig | null;
  /** 授权中心：MCP 工具、内网地址、工作区外文件、改共享技能都要过它 */
  consent?: ConsentCenter;
  audit?: AuditLog;
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
  /** 无人值守（编排阶段等）：没有用户能回答提问 / 确认 */
  unattended?: boolean;
  /** 内部：本轮走原生 function calling（影响工具说明的写法） */
  nativeTools?: boolean;
}

/** 一轮回复里共享的状态：联网来源按出现顺序编号，正文用 [n] 引用 */
export interface TurnCtx { sources: SourceItem[]; userImages?: ContentBlock[]; signal?: AbortSignal; unattended?: boolean }
