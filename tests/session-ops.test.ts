import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import { MemorySystem } from "../core/memory-system";
import { SkillRegistry } from "../core/skill-registry";
import { BotRuntime } from "../core/bot-runtime";
import { ProviderCenter } from "../core/provider-center";
import { contentText, type Bot } from "../core/types";

const home = mkdtempSync(join(tmpdir(), "harness-sess-test-"));
const store = new Store(home);
afterAll(() => store.close());
const bot: Bot = { id: "a", name: "助手", role: "通用", persona: "", providerId: "", petEnabled: false, createdAt: Date.now() };
store.saveBot(bot);

class SlowProvider extends ProviderCenter {
  override async streamComplete(_p: any, req: any): Promise<any> {
    req._onChunk({ type: "text", text: "写到一半" });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, 2000);
      req.signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); });
    });
    return { text: "写到一半完整", content: [{ type: "text", text: "写到一半完整" }] };
  }
}

describe("会话操作", () => {
  test("重命名 / 删除消息 / 压缩摘要持久化", () => {
    const sid = "s-ops";
    for (let i = 0; i < 3; i++) store.addMessage({ id: `m${i}`, sessionId: sid, botId: "a", from: "user", to: "a", kind: "user-to-bot", content: `第${i}条`, createdAt: Date.now() + i } as any);
    store.renameSession(sid, "新名字");
    expect(store.getSession(sid)?.title).toBe("新名字");
    const ids = store.listMessages(sid).map((m) => m.id!);
    store.deleteMessages(sid, [ids[1]]);
    expect(store.listMessages(sid).map((m) => contentText(m.content))).toEqual(["第0条", "第2条"]);
    store.markCompacted(sid, 1, "摘要内容");
    expect(store.getSession(sid)?.summary).toBe("摘要内容");
    const reopened = new Store(home);
    expect(reopened.getSession(sid)?.title).toBe("新名字");
    expect(reopened.listMessages(sid).length).toBe(2);
    reopened.close();
  });

  test("停止生成：保留已输出部分并标记已停止", async () => {
    const providers = new SlowProvider(store);
    providers.addProvider({ kind: "openai-compat", name: "默认", baseUrl: "https://fake/v1", apiKey: "x", model: "m", isDefault: true });
    const rt = new BotRuntime({ store, providers, memory: new MemorySystem(home), skills: new SkillRegistry(join(home, "skills")) });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const t0 = Date.now();
    const r = await rt.handleStream({ bot, from: "user", text: "写长文", sessionId: "s-stop" }, { signal: ac.signal, onBlock: () => {} });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.text).toContain("写到一半");
    expect(contentText(r.content ?? [])).toContain("已停止生成");
    const last = store.listMessages("s-stop").at(-1)!;
    expect(contentText(last.content)).toContain("已停止生成");
  });

  test("退出时留下已经写出的回复", async () => {
    const providers = new SlowProvider(store);
    providers.addProvider({ kind: "openai-compat", name: "默认", baseUrl: "https://fake/v1", apiKey: "x", model: "m", isDefault: true });
    const rt = new BotRuntime({ store, providers, memory: new MemorySystem(home), skills: new SkillRegistry(join(home, "skills")) });
    const ac = new AbortController();
    const pending = rt.handleStream({ bot, from: "user", text: "请开始写", sessionId: "s-quit" }, { signal: ac.signal, onBlock: () => {} });
    await new Promise((r) => setTimeout(r, 40));
    rt.flushInflight();
    const texts = store.listMessages("s-quit").map((m) => contentText(m.content));
    expect(texts[0]).toContain("请开始写");
    expect(texts.at(-1)).toContain("写到一半");
    expect(texts.at(-1)).toContain("回复未完成，应用已退出");
    const reopened = new Store(home);
    const again = reopened.listMessages("s-quit").map((m) => contentText(m.content));
    expect(again.join("\n")).toContain("写到一半");
    expect(again.filter((t) => t.includes("写到一半")).length).toBe(1);
    reopened.close();
    ac.abort();
    await pending;
    expect(store.listMessages("s-quit").filter((m) => m.role === "assistant")).toHaveLength(1);
  });
});
