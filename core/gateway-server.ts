import { createServer, type Server } from "node:http";
import type { TransportMessage } from "./transport";
import type { MessageBus } from "./message-bus";

/**
 * G4 HTTP 网关 — 跨进程/跨机器 bot 通信。
 * - GET /health：健康检查（可带 token）
 * - POST /bots/msg：投递远程消息（Bearer token 校验 → 本地 bus 路由）
 * - 5MB body 上限；失败返回 4xx/5xx
 * 对标 CowAgent agent/multiagent/gateway.py（本机/局域网自建）。
 */
export class GatewayServer {
  private server: Server | null = null;

  constructor(
    private port: number,
    private token: string,
    private bus: MessageBus,
    private opts?: { maxBodyBytes?: number },
  ) {}

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer(async (req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
        if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

        const url = (req.url ?? "/").split("?")[0];
        if (req.method === "GET" && url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, ts: Date.now() }));
          return;
        }
        if (req.method === "POST" && url === "/bots/msg") {
          // token 校验
          const auth = req.headers.authorization ?? "";
          const ok = this.token && auth === `Bearer ${this.token}`;
          if (!ok) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
          let body = "";
          const max = this.opts?.maxBodyBytes ?? 5 * 1024 * 1024;
          req.on("data", (chunk) => {
            body += chunk;
            if (body.length > max) {
              res.writeHead(413, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "payload too large" }));
              req.destroy();
            }
          });
          req.on("end", () => {
            try {
              const msg = JSON.parse(body) as TransportMessage;
              if (!msg?.from || !msg?.to) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "from/to required" }));
                return;
              }
              // 投递给本地 bus（bus 内部按 to 路由；找不到 bot 时回执未注册）
              void this.bus.deliverRemote(msg).then((ok2) => {
                res.writeHead(ok2 ? 200 : 202, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: ok2, received: true }));
              }).catch((e) => {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
              });
            } catch {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "invalid json" }));
            }
          });
          return;
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      });
      server.on("error", reject);
      server.listen(this.port, () => {
        this.server = server;
        const addr = server.address();
        const actual = typeof addr === "object" && addr ? addr.port : this.port;
        resolve(actual);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }
}
