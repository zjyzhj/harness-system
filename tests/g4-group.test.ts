import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import { MessageBus } from "../core/message-bus";
import { GroupRegistry } from "../core/group-registry";
import type { Bot } from "../core/types";

let home: string;
let store: Store;
let bus: MessageBus;
let groups: GroupRegistry;
let a: Bot, b: Bot, c: Bot;

function mkBot(name: string): Bot {
  return { id: `bot-${name}`, name, role: "助手", persona: "", providerId: "default", petEnabled: false, createdAt: Date.now() };
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "harness-g4-"));
  store = new Store(home);
  bus = new MessageBus(store);
  groups = new GroupRegistry(home);
  bus.setGroups(groups);
  a = mkBot("A"); b = mkBot("B"); c = mkBot("C");
  store.saveBot(a); store.saveBot(b); store.saveBot(c);
  // 注册 handler：回显收到的文本
  for (const bot of [a, b, c]) {
    bus.register(bot.id, async (_from, _to, text) => `收到：${text}`);
  }
});
afterAll(() => {});

describe("G4 group registry", () => {
  test("T4.1a 建组 + join/leave + 成员", () => {
    const g = groups.create("产品组", "user", [a.id, b.id]);
    expect(g.members).toEqual([a.id, b.id]);
    groups.join(g.id, c.id);
    expect(groups.members(g.id)).toContain(c.id);
    groups.leave(g.id, c.id);
    expect(groups.members(g.id)).not.toContain(c.id);
    expect(groups.findByName("产品组")?.id).toBe(g.id);
  });

  test("T4.1b @组 解析成员", () => {
    groups.create("早会组", "user", [a.id, b.id, c.id]);
    const members = groups.resolveMembers("大家好，@早会组 请准备材料");
    expect(members).toEqual([a.id, b.id, c.id]);
    const found = groups.resolveAt("@产品组 今天进度");
    expect(found[0]?.name).toBe("产品组");
  });
});

describe("G4 rich message + broadcast", () => {
  test("T4.0 富内容互发：图片块落盘保留", async () => {
    const rich: any[] = [{ type: "text", text: "看这个图" }, { type: "image", dataUrl: "data:image/png;base64,AAAA", alt: "测试图" }];
    const msgs = await bus.send(a, b, rich as any);
    expect(msgs.length).toBe(2); // outgoing + reply
    const saved = store.listMessages(msgs[0].sessionId);
    expect(saved.some((m) => Array.isArray(m.content) && (m.content as any[]).some((x) => x.type === "image"))).toBe(true);
    // handler 收到的是纯文本摘要（富块过滤 text 拼接）
    const reply = msgs.find((m) => m.role === "assistant");
    expect(String(reply?.content)).toContain("收到：看这个图");
  });

  test("T4.1c 群组广播：@组 所有成员收到", async () => {
    const g = groups.create("广播组", "user", [a.id, b.id, c.id]);
    const all = await bus.broadcast(g.id, a, "早会材料：@广播组 各成员请准备");
    // A 是发起者，B/C 各收到 outgoing+reply（回复返回给发起者 A）
    expect(all.length).toBeGreaterThanOrEqual(4);
    const fromB = all.filter((m) => m.from === b.id);
    const fromC = all.filter((m) => m.from === c.id);
    expect(fromB.some((m) => m.role === "assistant")).toBe(true);
    expect(fromC.some((m) => m.role === "assistant")).toBe(true);
  });

  test("T4.1d 非成员不收到广播", async () => {
    const g = groups.create("二人组", "user", [a.id, b.id]);
    const all = await bus.broadcast(g.id, a, "@二人组 集合");
    expect(all.filter((m) => m.to === c.id)).toEqual([]);
  });
});
