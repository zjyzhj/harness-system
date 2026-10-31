/**
 * 桌宠宿主端口 — 仅娱乐侧车使用。
 * BotRuntime / RuntimeDeps 不依赖本类型；由 app 宿主实现并经 attachPetEntertainment 挂载。
 */
export interface PetHost {
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
  /** 让桌宠做动作：idle/walk/jump/sleep/celebrate/work/think（娱乐，不占工作回合） */
  act?: (botId: string, action: string, holdSec?: number) => { ok: true; action: string } | { ok: false; error: string };
  /** 气泡说一句（不跑整轮对话）；可选顺带做动作 */
  say?: (botId: string, text: string, opts?: { title?: string; action?: string; holdSec?: number }) =>
    { ok: true } | { ok: false; error: string };
  /** 只读心智投影（娱乐调试） */
  mind?: (botId: string) => { ok: true; mind: unknown; prompt: string } | { ok: false; error: string };
  /** 最近自主行动日志 */
  activity?: (botId?: string, limit?: number) => Array<{ at: number; botId: string; kind: string; via: string; note: string; blocked?: boolean }>;
  /** 播放娱乐节拍脚本（异步，不标 running） */
  playScript?: (botId: string, beats: unknown[]) => { ok: true; ms: number } | { ok: false; error: string };
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
}
