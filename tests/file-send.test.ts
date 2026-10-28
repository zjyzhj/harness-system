import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import { MemorySystem } from "../core/memory-system";
import { SkillRegistry } from "../core/skill-registry";
import { BotRuntime, sendFiles } from "../core/bot-runtime";
import { ProviderCenter } from "../core/provider-center";
import type { Bot, ContentBlock } from "../core/types";

const home = mkdtempSync(join(tmpdir(), "harness-file-send-"));
const out = join(home, "out");
mkdirSync(out);
writeFileSync(join(out, "a.png"), "x");
writeFileSync(join(out, "b.jpg"), "x");
writeFileSync(join(out, "规范.md"), "# 规范");
writeFileSync(join(out, ".DS_Store"), "x");
const store = new Store(home);
afterAll(() => store.close());

describe("file.send", () => {
  test("目录展开：图片成 image 块，其他成 file 卡片，忽略隐藏文件", () => {
    const r = sendFiles({ path: out });
    expect(r.blocks?.map((b) => b.type)).toEqual(["image", "image", "file"]);
    const f = r.blocks![2] as Extract<ContentBlock, { type: "file" }>;
    expect(f.name).toBe("规范.md");
    expect(f.size).toBe(Buffer.byteLength("# 规范"));
  });

  test("找不到的路径会告诉模型", () => {
    const r = sendFiles({ paths: [join(out, "a.png"), "relative.png", join(out, "nope.png")] });
    expect(r.blocks?.length).toBe(1);
    expect(r.output).toContain("relative.png");
    expect(r.output).toContain("nope.png");
    expect(sendFiles({}).blocks).toBeUndefined();
  });

  test("附件进入最终回复", async () => {
    class P extends ProviderCenter {
      override async streamComplete(_p: any, req: any): Promise<any> {
        const done = String(req.user).includes("[工具执行返回]");
        const text = done ? "做好了，10 张图在这" : "```tool\n" + JSON.stringify({ tool: "file.send", args: { path: out } }) + "\n```";
        req._onChunk({ type: "text", text });
        return { text, content: [{ type: "text", text }] };
      }
    }
    const providers = new P(store);
    providers.addProvider({ kind: "openai-compat", toolMode: "text", name: "默认", baseUrl: "https://fake/v1", apiKey: "x", model: "m", isDefault: true });
    const bot: Bot = { id: "a", name: "出图", role: "设计", persona: "", providerId: "", petEnabled: false, createdAt: Date.now() };
    store.saveBot(bot);
    const rt = new BotRuntime({ store, providers, memory: new MemorySystem(home), skills: new SkillRegistry(join(home, "skills")) });
    const r = await rt.handleStream({ bot, from: "user", text: "出图", sessionId: "s" }, { onBlock: () => {} });
    expect(r.content?.filter((b) => b.type === "image").length).toBe(2);
    expect(r.content?.filter((b) => b.type === "file").length).toBe(1);
    const saved = store.listMessages("s").at(-1)!.content as ContentBlock[];
    expect(saved.some((b) => b.type === "image")).toBe(true);
  });

  test("工具轮次按 问题 → 模型调用 → 工具结果 的顺序回给模型，问题不会被重复放到最后", async () => {
    const reqs: any[] = [];
    class P extends ProviderCenter {
      override async streamComplete(_p: any, req: any): Promise<any> {
        reqs.push(req);
        const text = reqs.length === 1 ? "我先看看目录\n```tool\n" + JSON.stringify({ tool: "fs.list", args: { path: out } }) + "\n```" : "看完了";
        req._onChunk({ type: "text", text });
        return { text, content: [{ type: "text", text }] };
      }
    }
    const providers = new P(store);
    providers.addProvider({ kind: "openai-compat", toolMode: "text", name: "默认", baseUrl: "https://fake/v1", apiKey: "x", model: "m", isDefault: true });
    const bot: Bot = { id: "a", name: "出图", role: "设计", persona: "", providerId: "", petEnabled: false, createdAt: Date.now() };
    const rt = new BotRuntime({ store, providers, memory: new MemorySystem(home), skills: new SkillRegistry(join(home, "skills")) });
    await rt.handleStream({ bot, from: "user", text: "看看目录", sessionId: "s-order", history: [] }, { onBlock: () => {} });
    const second = reqs[1];
    const tail = second.history.slice(-2).map((h: any) => [h.role, String(typeof h.content === "string" ? h.content : JSON.stringify(h.content)).replace(/^<系统附注[\s\S]*?<\/系统附注>\s*/, "")]);
    expect(tail[0]).toEqual(["user", "看看目录"]);
    expect(tail[1][0]).toBe("assistant");
    expect(tail[1][1]).toContain("我先看看目录");
    expect(tail[1][1]).toContain('"tool":"fs.list"');
    expect(String(second.user)).toStartWith("[工具执行返回]");
  });

  test("截屏：图片附在这一轮回复里，排在用户的话后面，不单独插一条", async () => {
    class P extends ProviderCenter {
      override async streamComplete(_p: any, req: any): Promise<any> {
        const done = String(req.user).includes("[工具执行返回]");
        const text = done ? "截好了" : "我截一张\n```tool\n" + JSON.stringify({ tool: "screen.screenshot", args: {} }) + "\n```";
        req._onChunk({ type: "text", text });
        return { text, content: [{ type: "text", text }] };
      }
    }
    const providers = new P(store);
    providers.addProvider({ kind: "openai-compat", toolMode: "text", name: "默认", baseUrl: "https://fake/v1", apiKey: "x", model: "m", isDefault: true });
    const bot: Bot = { id: "a", name: "出图", role: "设计", persona: "", providerId: "", petEnabled: false, createdAt: Date.now() };
    const systemAccess = { screenshot: async () => ({ path: join(out, "a.png"), dataUrl: "data:image/png;base64,eA==" }) };
    const rt = new BotRuntime({ store, providers, memory: new MemorySystem(home), skills: new SkillRegistry(join(home, "skills")), systemAccess: systemAccess as never });
    await rt.handleStream({ bot, from: "user", text: "截个屏", sessionId: "s-shot" }, { onBlock: () => {} });
    const msgs = store.listMessages("s-shot");
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    const imgs = (msgs[1].content as ContentBlock[]).filter((b) => b.type === "image");
    expect(imgs.length).toBe(1);
  });
});
