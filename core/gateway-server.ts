import { createServer, type IncomingMessage, type Server } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
import type { TransportMessage } from "./transport";
import type { MessageBus } from "./message-bus";

/** 滑动窗口限流（进程内） */
export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();
  allow(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (arr.length >= limit) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }
}

/**
 * 校验可选 / 强制签名：HMAC-SHA256(token, rawBody) 的 hex，头 X-Harness-Signature。
 * require=false（默认）：未带头仍可走；带了就必须对。
 * require=true：必须带头且正确（对齐云端 REQUIRE_INBOUND_HMAC）。
 */
export function routineSignatureOk(
  token: string,
  rawBody: string,
  header: string | undefined,
  opts?: { require?: boolean },
): boolean {
  if (!header) return !opts?.require;
  const want = header.trim().replace(/^sha256=/i, "");
  const got = createHmac("sha256", token).update(rawBody).digest("hex");
  return safeEqual(want, got);
}

/**
 * G4 HTTP 网关 — 跨进程/跨机器 bot 通信。
 * - GET /health：健康检查（可带 token）
 * - POST /bots/msg：投递远程消息（Bearer token 校验 → 本地 bus 路由）
 * - POST /routines/:token：例行触发（能力 URL；限流 + 可选 HMAC 签名）
 * - 5MB body 上限（例行单独更小）；失败返回 4xx/5xx
 * 对标 CowAgent agent/multiagent/gateway.py（本机/局域网自建）。
 */
export class GatewayServer {
  private server: Server | null = null;
  /**
   * 入站例行触发：POST /routines/:token
   * 建议快速校验后返回 accepted:true（HTTP 202），真正跑 bot 放后台——对齐 Grok「200/202 = 已受理，不是跑完」。
   */
  onRoutine: ((
    token: string,
    body: unknown,
    meta?: { priorityHeader?: string },
  ) => Promise<{
    ok: boolean;
    error?: string;
    taskId?: string;
    name?: string;
    /** 已受理、后台执行 → 网关回 202 */
    accepted?: boolean;
    priority?: string;
  }>) | null = null;
  private routineLimiter = new SlidingWindowLimiter();

  constructor(
    private port: number,
    private token: string,
    private bus: MessageBus,
    private opts?: {
      maxBodyBytes?: number;
      host?: string;
      /** 例行 body 上限，默认 64KiB */
      routineMaxBodyBytes?: number;
      /** 每 token 每分钟上限，默认 12 */
      routinePerTokenPerMin?: number;
      /** 每来源 IP 每分钟上限，默认 60 */
      routinePerIpPerMin?: number;
      /** /bots/msg 每 token 每分钟，默认 60 */
      msgPerTokenPerMin?: number;
      /** /bots/msg 每 IP 每分钟，默认 120 */
      msgPerIpPerMin?: number;
      /** true：例行 POST 必须带正确 X-Harness-Signature */
      requireHmac?: boolean;
    },
  ) {}

  private clientIp(req: IncomingMessage): string {
    const xf = req.headers["x-forwarded-for"];
    if (typeof xf === "string" && xf.trim()) return xf.split(",")[0]!.trim();
    return req.socket.remoteAddress || "unknown";
  }

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
        const routineMatch = url.match(/^\/routines\/([A-Za-z0-9_-]+)$/);
        if (req.method === "POST" && routineMatch) {
          if (!this.onRoutine) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "routines not configured" }));
            return;
          }
          const token = routineMatch[1];
          const ip = this.clientIp(req);
          const perTok = this.opts?.routinePerTokenPerMin ?? 12;
          const perIp = this.opts?.routinePerIpPerMin ?? 60;
          if (!this.routineLimiter.allow(`tok:${token}`, perTok, 60_000)
            || !this.routineLimiter.allow(`ip:${ip}`, perIp, 60_000)) {
            res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" });
            res.end(JSON.stringify({ error: "rate limited" }));
            return;
          }
          let body = "";
          let aborted = false;
          const max = this.opts?.routineMaxBodyBytes ?? 64 * 1024;
          req.on("data", (chunk) => {
            if (aborted) return;
            body += chunk;
            if (body.length > max) {
              aborted = true;
              if (!res.headersSent) {
                res.writeHead(413, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "payload too large" }));
              }
              req.destroy();
            }
          });
          req.on("end", () => {
            if (aborted || res.headersSent) return;
            const sig = req.headers["x-harness-signature"];
            if (!routineSignatureOk(token, body, typeof sig === "string" ? sig : undefined, { require: !!this.opts?.requireHmac })) {
              res.writeHead(401, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: this.opts?.requireHmac && !sig ? "signature required" : "invalid signature" }));
              return;
            }
            let parsed: unknown = {};
            if (body.trim()) {
              try { parsed = JSON.parse(body); } catch {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "invalid json" }));
                return;
              }
            }
            const priorityHeader = req.headers["x-harness-priority"] ?? req.headers["x-priority"];
            void this.onRoutine!(token, parsed, {
              priorityHeader: typeof priorityHeader === "string" ? priorityHeader : undefined,
            }).then((r) => {
              if (res.headersSent) return;
              if (!r.ok) {
                res.writeHead(r.error === "not found" ? 404 : 400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: r.error || "failed" }));
                return;
              }
              const status = r.accepted ? 202 : 200;
              res.writeHead(status, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                ok: true,
                accepted: !!r.accepted,
                taskId: r.taskId,
                name: r.name,
                priority: r.priority,
              }));
            }).catch((e) => {
              if (res.headersSent) return;
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "routine failed" }));
              console.error("[gateway] routine error:", e instanceof Error ? e.message : e);
            });
          });
          return;
        }
        if (req.method === "POST" && url === "/bots/msg") {
          // token 校验
          const auth = req.headers.authorization ?? "";
          const ok = this.token.length >= 16 && safeEqual(auth, `Bearer ${this.token}`);
          if (!ok) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
          const ip = this.clientIp(req);
          const perTok = this.opts?.msgPerTokenPerMin ?? 60;
          const perIp = this.opts?.msgPerIpPerMin ?? 120;
          if (!this.routineLimiter.allow(`msg-tok:${this.token.slice(0, 12)}`, perTok, 60_000)
            || !this.routineLimiter.allow(`msg-ip:${ip}`, perIp, 60_000)) {
            res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" });
            res.end(JSON.stringify({ error: "rate limited" }));
            return;
          }
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
