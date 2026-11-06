/**
 * 对齐 scripts/smoke-group-live.ts 的 Case A/B：无 CDP、无真模型。
 * 锁住「没 @ → 主持人先说」「@某人 → 他先说」。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import { GroupRegistry } from "../core/group-registry";
import { ProviderCenter } from "../core/provider-center";
import { GroupSessionRunner } from "../core/group-session";
import type { Bot, ContentBlock } from "../core/types";

function bot(id: string, name: string, extra: Partial<Bot> = {}): Bot {
  return { id, name, systemPrompt: "", providerId: "p", createdAt: 0, petEnabled: false, persona: "", role: "", ...extra } as Bot;
}

describe("冒烟对齐：群聊 @ / 没@", () => {
  const dir = mkdtempSync(join(tmpdir(), "smoke-group-at-"));
  const store = new Store(dir);
  const groups = new GroupRegistry(dir);
  const providers = new ProviderCenter(store);
  store.saveBot(bot("m", "灵感助手", { isMaster: true }));
  store.saveBot(bot("w", "写作助手"));
  store.saveBot(bot("t", "翻译助手"));
  const g = groups.create("测试", "user", ["m", "w", "t"]);
  groups.update(g.id, { settings: { moderator: "m", relay: true, maxTurns: 6 } });
  const hooks = { onProgress: () => {}, onStream: () => {}, setRunning: () => {}, setIdle: () => {} };

  test("Case A：没 @ → 主持人先说，不齐声开场", async () => {
    const order: string[] = [];
    const runner = new GroupSessionRunner({
      store, groups, providers,
      runtime: {
        handleStream: async (req: { bot: Bot; text: string }, opts: { onBlock: (b: ContentBlock) => void }) => {
          if (req.text.includes("你是本群主持人")) {
            opts.onBlock({ type: "text", text: "小结" });
            return { text: "小结", content: [{ type: "text", text: "小结" }] };
          }
          order.push(req.bot.id);
          const text = "先定方向。【交给】无";
          opts.onBlock({ type: "text", text });
          return { text, content: [{ type: "text", text }] };
        },
      } as never,
    });
    const sid = `group-${g.id}-a`;
    const r = await runner.chat(g.id, "先定本周方向。只说一两句。末尾写【交给】无。", sid, hooks);
    expect(r.ok).toBe(true);
    expect(order[0]).toBe("m");
    // 没人再被点名时不应把写作/翻译齐声拉进来
    expect(order.filter((id) => id === "w" || id === "t")).toEqual([]);
  });

  test("Case B：@写作助手 → 她先说", async () => {
    const order: string[] = [];
    const runner = new GroupSessionRunner({
      store, groups, providers,
      runtime: {
        handleStream: async (req: { bot: Bot; text: string }, opts: { onBlock: (b: ContentBlock) => void }) => {
          if (req.text.includes("你是本群主持人")) {
            opts.onBlock({ type: "text", text: "小结" });
            return { text: "小结", content: [{ type: "text", text: "小结" }] };
          }
          order.push(req.bot.id);
          const text = "我能帮写文案。【交给】无";
          opts.onBlock({ type: "text", text });
          return { text, content: [{ type: "text", text }] };
        },
      } as never,
    });
    const sid = `group-${g.id}-b`;
    const r = await runner.chat(g.id, "@写作助手 用一句话说明你能帮什么。末尾写【交给】无。", sid, hooks);
    expect(r.ok).toBe(true);
    expect(order[0]).toBe("w");
    expect(order.includes("m")).toBe(false);
  });

  test("cleanup", () => { rmSync(dir, { recursive: true, force: true }); });
});
