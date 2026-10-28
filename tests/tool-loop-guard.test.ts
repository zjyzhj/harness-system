import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import { MemorySystem } from "../core/memory-system";
import { SkillRegistry } from "../core/skill-registry";
import { BotRuntime, toolBlockCutoff } from "../core/bot-runtime";
import { ProviderCenter } from "../core/provider-center";
import { ToolExecutor } from "../core/tool-executor";
import type { Bot } from "../core/types";

const block = '```tool\n{"tool":"fs.list","args":{"path":"/definitely/not/allowed"}}\n```';

describe("工具块截断", () => {
  test("工具块写完、模型接着编结果时截断在工具块结尾", () => {
    const text = `我查一下。\n${block}\n\n命令被权限拦了，我换个分组再试。`;
    expect(toolBlockCutoff(text)).toBe(text.indexOf(block) + block.length);
  });

  test("工具块后面只有空白或下一个工具块（含写到一半）时不截断", () => {
    expect(toolBlockCutoff(`我查一下。\n${block}\n\n`)).toBeNull();
    expect(toolBlockCutoff(`${block}\n\`\``)).toBeNull();
    expect(toolBlockCutoff(`${block}\n\`\`\`tool\n{"tool"`)).toBeNull();
    expect(toolBlockCutoff("没有工具块的普通回答")).toBeNull();
  });
});

describe("工具循环防护", () => {
  const home = mkdtempSync(join(tmpdir(), "harness-loop-"));
  const store = new Store(home);
  afterAll(() => store.close());
  const bot: Bot = { id: "a", name: "助手", role: "通用", persona: "", providerId: "", petEnabled: false, createdAt: Date.now() };
  store.saveBot(bot);

  test("模型写完工具块后自说自话：流被截断，工具真正执行，编出来的内容不进回复", async () => {
    const calls: { aborted: boolean }[] = [];
    class P extends ProviderCenter {
      override async streamComplete(_p: any, req: any): Promise<any> {
        if (String(req.user).includes("[工具执行返回]")) {
          req._onChunk({ type: "text", text: "这个目录不让访问。" });
          return { text: "这个目录不让访问。" };
        }
        const chunks = ["我查一下。\n", block, "\n\n命令被权限拦了，", "我换个分组再试。", "\n".repeat(3) + block];
        for (const c of chunks) {
          if (req.signal?.aborted) break;
          req._onChunk({ type: "text", text: c });
        }
        calls.push({ aborted: !!req.signal?.aborted });
        if (req.signal?.aborted) throw new Error("aborted");
        return { text: chunks.join("") };
      }
    }
    const providers = new P(store);
    providers.addProvider({ kind: "openai-compat", toolMode: "text", name: "默认", baseUrl: "https://fake/v1", apiKey: "x", model: "m", isDefault: true });
    const rt = new BotRuntime({ store, providers, memory: new MemorySystem(home), skills: new SkillRegistry(join(home, "skills")) });
    const r = await rt.handleStream({ bot, from: "user", text: "看看目录", sessionId: "s1" }, { onBlock: () => {} });
    expect(calls[0].aborted).toBe(true);
    expect(r.toolCalls.length).toBe(1);
    expect(r.text).toBe("这个目录不让访问。");
    expect(JSON.stringify(r.content)).not.toContain("换个分组");
  });

  test("同一个失败的调用不会被反复执行", async () => {
    let round = 0;
    class P extends ProviderCenter {
      override async streamComplete(_p: any, req: any): Promise<any> {
        round++;
        const text = round <= 3 ? block : "做不到，这个目录不在允许范围。";
        req._onChunk({ type: "text", text });
        return { text };
      }
    }
    const providers = new P(store);
    providers.addProvider({ kind: "openai-compat", toolMode: "text", name: "默认", baseUrl: "https://fake/v1", apiKey: "x", model: "m", isDefault: true });
    const memory = new MemorySystem(home);
    const executor = new ToolExecutor({ allowedRoots: [join(home, "ws")] }, undefined, memory);
    const rt = new BotRuntime({ store, providers, memory, executor, skills: new SkillRegistry(join(home, "skills")) });
    const r = await rt.handleStream({ bot, from: "user", text: "看看目录", sessionId: "s2" }, { onBlock: () => {} });
    const results = (r.content ?? []).filter((b) => b.type === "tool_call").map((b: any) => String(b.result));
    expect(results.length).toBe(3);
    expect(results[0]).not.toContain("已经失败过");
    expect(results[1]).toContain("已经失败过");
  });
});
