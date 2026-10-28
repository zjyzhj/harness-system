import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
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
    private opts?: { maxBodyBytes?: number; host?: string },
  ) {}

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer(async (req, res) => {
        // 不给浏览器开跨域：网页脚本不能借用户的浏览器往本机网关投消息
        if (req.method === "OPTIONS") { res.writeHead(403); res.end(); return; }

        const url = (req.url ?? "/").split("?")[0];
        if (req.method === "GET" && url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, ts: Date.now() }));
          return;
        }
        if (req.method === "POST" && url === "/bots/msg") {
          // token 校验
          const auth = req.headers.authorization ?? "";
          const ok = this.token.length >= 16 && safeEqual(auth, `Bearer ${this.token}`);
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
      server.listen(this.port, this.opts?.host ?? "127.0.0.1", () => {
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
