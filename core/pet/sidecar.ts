/**
 * 桌宠娱乐侧车 — 可选挂载到 BotRuntime。
 *
 * 原则：Bot 完整设计（对话、工具、记忆、协作、技能、MCP…）不依赖桌宠。
 * 桌宠只是娱乐表现层；未挂载时 Runtime 无 pet.* 工具、无桌宠提示词。
 */
import type { Bot } from "../types";
import type { Store } from "../store";
import type { ToolRegistry } from "../tool-registry";
import type { PetHost } from "./host-port";
import { runPetTool } from "./tools";
import { isPetTopic, petPlaybook, petSelfBrief } from "./prompt";

export interface PetSidecarOpts {
  store: Store;
  host: PetHost;
  onAppChanged?: (what: string) => void;
}

/** 能接收娱乐侧车的 Runtime 最小面（避免循环依赖具体 BotRuntime 类） */
export interface PetEntertainmentTarget {
  toolRegistry(): ToolRegistry;
  setPromptExtras(extras: {
    stableFact?: (bot: Bot) => string | null | undefined;
    volatile?: (bot: Bot, query: string) => string | null | undefined;
  }): void;
}

/** 把桌宠工具与提示词挂到已构造的 Runtime 上（幂等：重复调用会再注册前缀） */
export function attachPetEntertainment(runtime: PetEntertainmentTarget, opts: PetSidecarOpts): void {
  const { store, host, onAppChanged } = opts;
  const R = runtime.toolRegistry();
  R.registerPrefix(
    "pet.",
    "桌宠娱乐工具（status/list/mind/activity/skin/act/say/fx/search/install/generate/show/hide/disable/prefs/evolve/visits/remind/visit/create）。桌宠不代替干活；用户谈桌宠时附手册",
    (ctx) => runPetTool(ctx.bot, ctx.tool, ctx.args, { store, host, onAppChanged }),
  );
  runtime.setPromptExtras({
    stableFact: (bot) => petSelfBrief(bot, host),
    volatile: (bot, query) => (isPetTopic(query) ? petPlaybook(bot, host) : null),
  });
}
