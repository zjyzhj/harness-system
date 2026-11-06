import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import { MessageBus } from "../core/message-bus";
import { GatewayServer } from "../core/gateway-server";
import { HttpTransport } from "../core/transport";
import type { Bot } from "../core/types";

let home: string;
let store: Store;
let bus: MessageBus;
let gateway: GatewayServer;
let port: number;
const TOKEN = "test-token-1234567890";

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "harness-g4gw-"));
  store = new Store(home);
  bus = new MessageBus(store);
  const bot: Bot = { id: "bot-remote-target", name: "远程目标", role: "助手", persona: "", providerId: "default", petEnabled: false, createdAt: Date.now() };
  store.saveBot(bot);
  bus.register(bot.id, async (_f, _t, text) => `已收到：${text}`);
  gateway = new GatewayServer(0, TOKEN, bus);
  port = await gateway.start();
});
afterAll(async () => {
  await gateway.stop();
});

describe("G4 gateway", () => {
  test("T4.5a /health 健康检查", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.ok).toBe(true);
    const j = await res.json() as { ok: boolean };
    expect(j.ok).toBe(true);
  });

  test("T4.5b token 错误 → 401", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/bots/msg`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
      body: JSON.stringify({ from: "x", to: "bot-remote-target", text: "hi", timestamp: Date.now() }),
    });
    expect(res.status).toBe(401);
  });

  test("T4.5c 跨进程消息：HttpTransport 经网关投递成功并回执", async () => {
    const t = new HttpTransport(`http://127.0.0.1:${port}`, TOKEN);
    const sent = await t.send({ from: "bot-remote-sender", to: "bot-remote-target", text: "你好，远程协作", timestamp: Date.now() });
    expect(sent).toBe(true);
    // 远程目标收到并回复 → 回复消息落盘（session 归属远程发送者）
    const sessions = store.listSessions("bot-remote-sender");
    const latest = sessions[sessions.length - 1];
    const msgs = store.listMessages(latest.id);
    expect(msgs.some((m) => String(m.content).includes("已收到：你好，远程协作"))).toBe(true);
    // ping 可用
    expect(await t.ping()).toBe(true);
  });

  test("/bots/msg 每 token 限流 → 429", async () => {
    const home2 = mkdtempSync(join(tmpdir(), "harness-g4msg-"));
    const store2 = new Store(home2);
    const bus2 = new MessageBus(store2);
    store2.saveBot({ id: "t", name: "t", role: "", persona: "", providerId: "default", petEnabled: false, createdAt: Date.now() });
    bus2.register("t", async () => "ok");
    const tok = "msg-limit-token-abcdefgh";
    const g = new GatewayServer(0, tok, bus2, { msgPerTokenPerMin: 2, msgPerIpPerMin: 100 });
    const p = await g.start();
    const post = () => fetch(`http://127.0.0.1:${p}/bots/msg`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
      body: JSON.stringify({ from: "a", to: "t", text: "x", timestamp: Date.now() }),
    });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    const limited = await post();
    expect(limited.status).toBe(429);
    await g.stop();
  });
});
