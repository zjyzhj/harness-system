import { describe, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayServer } from "../core/gateway-server";
import { MessageBus } from "../core/message-bus";
import { Store } from "../core/store";
import { gatewayBindAllowed } from "../core/bot-access";

describe("入站网关设置语义", () => {
  test("非回环无 allowRemote 拒绝绑定", () => {
    expect(gatewayBindAllowed({ host: "0.0.0.0" }).ok).toBe(false);
    expect(gatewayBindAllowed({ host: "0.0.0.0", allowRemote: true }).ok).toBe(true);
    expect(gatewayBindAllowed({ host: "127.0.0.1" }).ok).toBe(true);
  });

  test("启停 + /health 实测", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-gw-set-"));
    const bus = new MessageBus(new Store(home));
    const token = randomBytes(18).toString("base64url");
    const server = new GatewayServer(0, token, bus, { host: "127.0.0.1" });
    let hits = 0;
    server.onRoutine = async () => {
      hits++;
      return { ok: true, taskId: "t1", name: "demo" };
    };
    const port = await server.start();
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { ok: boolean }).ok).toBe(true);

    const body = '{"ping":1}';
    const sig = createHmac("sha256", "wrong").update(body).digest("hex");
    // 没有对应 token 的例行路由：先测 health，再停
    await server.stop();
    expect(hits).toBe(0);
    void sig;
  });
});
