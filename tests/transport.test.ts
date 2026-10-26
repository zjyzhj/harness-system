import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import { AgentRegistry } from "../core/agent-registry";
import { contentText } from "../core/types";
import { MessageBus } from "../core/message-bus";
import { LocalTransport, HttpTransport } from "../core/transport";

let store: Store;
let reg: AgentRegistry;

beforeAll(() => {
  store = new Store(mkdtempSync(join(tmpdir(), "harness-transport-")));
  reg = new AgentRegistry(store);
});
afterAll(() => store.close());

describe("transport", () => {
  test("LocalTransport 同进程转发", async () => {
    const a = await reg.createBotFromText("创建 bot：本地A");
    const b = await reg.createBotFromText("创建 bot：远程B");
    const busA = new MessageBus(store);
    const busB = new MessageBus(store);
    // A 有 handler；B 的 handler 在 busB 上
    busA.register(a.id, async () => "A 已收到");
    busB.register(b.id, async () => "B 回执");
    // A 的 bus 不注册 B → 走 transport
    const lt = new LocalTransport((id) => store.getBot(id));
    busA.addTransport(lt);
    const outgoing = await busA.send(a, b, "你好B（跨进程）");
    expect(outgoing.length).toBeGreaterThan(0);
  });

  test("未注册且无 transport → 提示未注册", async () => {
    const a = await reg.createBotFromText("创建 bot：孤A");
    const b = await reg.createBotFromText("创建 bot：孤B");
    const bus = new MessageBus(store);
    bus.register(a.id, async () => "ok");
    const msgs = await bus.send(a, b, "ping");
    expect(msgs.some((m) => contentText(m.content).includes("未注册"))).toBe(true);
  });

  test("HttpTransport ping 坏地址返回 false", async () => {
    const ht = new HttpTransport("http://127.0.0.1:1");
    expect(await ht.ping()).toBe(false);
  });

  test("HttpTransport deliver 回调", async () => {
    const ht = new HttpTransport("http://x");
    const got: string[] = [];
    ht.onMessage((m) => got.push(m.text));
    ht.deliver({ from: "a", to: "b", text: "hello", timestamp: Date.now() });
    expect(got).toContain("hello");
  });
});
