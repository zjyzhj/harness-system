import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import { AgentRegistry, ruleParse, extractModel } from "../core/agent-registry";
import { MessageBus } from "../core/message-bus";
import { ProviderCenter } from "../core/provider-center";
import { PersonaGenerator, fallbackAvatar, buildCard } from "../core/persona";
import { SystemKit } from "../core/system-kit";
import { Migration } from "../core/migration";

let tmp: string;
let store: Store;
let home: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "harness-bot-test-"));
  home = join(tmp, "h");
  store = new Store(home);
});

afterAll(() => {
  store.close();
});

describe("store", () => {
  test("config 文件 0600", () => {
    const { mode } = statSync(join(home, "config.json"));
    expect((mode & 0o777).toString(8)).toBe("600");
  });
  test("provider CRUD + default", () => {
    store.saveProvider({ id: "p1", kind: "openai-compat", name: "测试中转", baseUrl: "https://x", apiKey: "sk-test", model: "gpt-4o-mini", isDefault: true, createdAt: Date.now() });
    store.saveProvider({ id: "p2", kind: "openai-compat", name: "第二家", baseUrl: "https://y", isDefault: false, createdAt: Date.now() });
    expect(store.getDefaultProvider()?.id).toBe("p1");
    expect(store.getProvider("p1")?.apiKey).toBe("sk-test");
  });
  test("bot + message roundtrip", () => {
    store.saveBot({ id: "b1", name: "助手", role: "通用", persona: "友好", providerId: "p1", petEnabled: false, createdAt: Date.now() });
    store.addMessage({ sessionId: "s1", from: "user", to: "b1", role: "user", content: "hi", kind: "chat", createdAt: Date.now() });
    expect(store.getBot("b1")?.name).toBe("助手");
    expect(store.listMessages("s1")).toHaveLength(1);
  });
});

describe("agent-registry", () => {
  test("一句话创建 bot（规则降级）", async () => {
    const reg = new AgentRegistry(store);
    const bot = await reg.createBotFromText("创建 bot：翻译助手，用 claude 模型，风格活泼");
    expect(bot.name).toBe("翻译助手");
    expect(bot.role).toContain("翻译");
    expect(bot.model).toBe("claude");
    expect(bot.systemPrompt).toContain("翻译");
    expect(store.getBot(bot.id)?.id).toBe(bot.id);
  });
  test("ruleParse 关键词抽取", () => {
    const p = ruleParse("创建一个写代码的 bot 叫小码");
    expect(p.name).toContain("小码");
    expect(p.role).toContain("编程");
    expect(extractModel("用 deepseek-chat 模型")).toBe("deepseek-chat");
  });
});

describe("message-bus", () => {
  test("两个 bot 互发消息", async () => {
    const bus = new MessageBus(store);
    const reg = new AgentRegistry(store);
    const a = await reg.createBotFromText("创建 bot：A 助手");
    const b = await reg.createBotFromText("创建 bot：B 助手");
    const seen: string[] = [];
    bus.onMessage((m) => seen.push(`${m.from}→${m.to}`));
    bus.register(a.id, async () => "A 收到");
    bus.register(b.id, async () => "B 收到");
    const msgs = await bus.send(a, b, "你好 B");
    expect(msgs.some((m) => m.content === "B 收到")).toBe(true);
    expect(seen.some((m) => m.includes(`${a.id}→${b.id}`) || m.includes("user→"))).toBe(true);
  });
  test("未注册处理器给出提示", async () => {
    const bus = new MessageBus(store);
    const reg = new AgentRegistry(store);
    const a = await reg.createBotFromText("创建 bot：C 助手");
    const b = await reg.createBotFromText("创建 bot：D 助手");
    const msgs = await bus.send(a, b, "在吗");
    expect(msgs.some((m) => m.content.includes("未注册"))).toBe(true);
  });
});

describe("provider-center", () => {
  test("注册 cli provider + 能力探测", async () => {
    const pc = new ProviderCenter(store);
    pc.addProvider({ kind: "cli", name: "Claude CLI", cliName: "claude" });
    const caps = await pc.capabilities();
    expect(Object.keys(caps)).toContain("claude");
    expect(typeof caps.claude.installed).toBe("boolean");
  });
  test("openai-compat test() 对无效地址返回 ok:false", async () => {
    const pc = new ProviderCenter(store);
    const p = pc.addProvider({ kind: "openai-compat", name: "坏地址", baseUrl: "http://127.0.0.1:1/v1", apiKey: "x", model: "gpt-4o-mini" });
    const r = await pc.test(p.id);
    expect(r.ok).toBe(false);
  });
});

describe("persona", () => {
  test("一句话生成形象（降级头像 + 角色卡）", async () => {
    const reg = new AgentRegistry(store);
    const bot = await reg.createBotFromText("创建 bot：小狐");
    const assets = join(home, "assets");
    const pg = new PersonaGenerator(store, assets);
    const r = await pg.generate(bot, "一只蓝色狐狸，可爱");
    expect(r.card.traits).toContain("蓝色色系");
    expect(existsSync(r.avatarPath!)).toBe(true);
    const saved = store.getBot(bot.id);
    expect(saved?.personaCard?.name).toBe("小狐");
    expect(saved?.avatarPath).toBe(r.avatarPath);
  });
  test("fallbackAvatar 产出 SVG 文件", () => {
    const path = join(home, "assets", "x.svg");
    const p = fallbackAvatar({ id: "x", name: "狐", role: "", persona: "", providerId: "p1", petEnabled: false, createdAt: Date.now() }, "蓝色狐狸", path);
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, "utf8")).toContain("<svg");
  });
  test("buildCard 性格提取", () => {
    const card = buildCard({ id: "x", name: "小狐", role: "", persona: "活泼", providerId: "p1", petEnabled: false, createdAt: Date.now() }, "蓝色狐狸可爱");
    expect(card.traits.join()).toContain("蓝色");
    expect(card.traits.join()).toContain("可爱");
  });
});

describe("system-kit", () => {
  test("白名单文件读写", () => {
    const kit = new SystemKit({ allowedRoot: home });
    expect(kit.canAccess(join(home, "a.txt"))).toBe(true);
    expect(kit.canAccess("/etc/passwd")).toBe(false);
    kit.writeFile(join(home, "a.txt"), "hello");
    expect(kit.readFile(join(home, "a.txt"))).toBe("hello");
    expect(() => kit.writeFile("/tmp/outside.txt", "x")).toThrow();
  });
  test("通知降级不抛错", async () => {
    const kit = new SystemKit();
    expect(await kit.notify("t", "b")).toBe(true);
  });
});

describe("migration", () => {
  test("导出→导入往返", async () => {
    const reg = new AgentRegistry(store);
    const bot = await reg.createBotFromText("创建 bot：迁移测试助手");
    const assets = join(home, "assets");
    const pg = new PersonaGenerator(store, assets);
    await pg.generate(bot, "一只猫");
    const mig = new Migration(store, assets);
    const payload = mig.exportPayload();
    expect(payload.format).toBe("harness-bot-migration/v1");
    expect(payload.bots.length).toBeGreaterThan(0);
    // 导入到干净 store
    const store2 = new Store(join(home, "imported"));
    const mig2 = new Migration(store2, join(home, "assets-imported"));
    const r = mig2.importFromPayload(payload);
    expect(r.importedBots).toBeGreaterThan(0);
    const imported = store2.listBots();
    expect(imported.length).toBeGreaterThan(0);
    const withAvatar = imported.find((b) => b.avatarPath && existsSync(b.avatarPath));
    expect(withAvatar).toBeDefined();
    store2.close();
  });
  test("导出 key 脱敏", () => {
    const mig = new Migration(store, join(home, "assets"));
    const payload = mig.exportPayload({ maskKeys: true });
    for (const p of payload.providers) {
      if (p.apiKey) expect(p.apiKey).toContain("****");
    }
  });
});
