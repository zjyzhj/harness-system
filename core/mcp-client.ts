import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { ToolInvocation } from "./types";
import { isPrivateHost, safeFetch } from "./web-search";

export interface McpServerConfig {
  id: string;
  name: string;
  /** stdio 启动命令（command + args） */
  command?: string;
  args?: string[];
  /** HTTP/SSE 端点（如本机 grok 网关） */
  url?: string;
  headers?: Record<string, string>;
  /** stdio 进程额外的环境变量；不会把 app 自身的环境（含各种密钥）整份传下去。值里可写 {{secret:NAME}}，连接时才解密填入 */
  env?: Record<string, string>;
  /** 软件内置：设置里不可删除 */
  builtin?: boolean;
  /** false = 用户关掉；仍留在配置里但不连接 */
  enabled?: boolean;
}

const PASS_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];

export function mcpEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of PASS_ENV) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  const merged = { ...env, ...(extra ?? {}) };
  // Dock 启动的 Electron PATH 常缺 uvx / homebrew，MCP 子进程补全
  const home = homedir();
  const extras = [join(home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const cur = (merged.PATH ?? "").split(delimiter).filter(Boolean);
  merged.PATH = [...extras, ...cur].filter((p, i, a) => p && a.indexOf(p) === i).join(delimiter);
  return merged;
}

export interface McpToolInfo {
  serverId: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

const PROTOCOL_VERSION = "2025-03-26";
const CLIENT_INFO = { name: "harness-bot", version: "1.0.0" };
const REQUEST_TIMEOUT_MS = 30_000;

interface StdioConn {
  proc: ChildProcess;
  pending: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>;
  stderr: string;
  ready: Promise<void>;
}

/** 把 MCP 工具结果里的内容块拼成文本 */
function resultText(result: any): string {
  const content = result?.content;
  if (!Array.isArray(content)) return JSON.stringify(result ?? null);
  const text = content.map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c))).join("\n");
  return result?.isError ? `❌ ${text}` : text;
}

/** MCP 客户端：stdio 或 Streamable HTTP；连接时先 initialize 握手，再做工具发现和调用 */
export class McpClient {
  private toolsByServer = new Map<string, McpToolInfo[]>();
  private conns = new Map<string, StdioConn>();
  private httpSessions = new Map<string, Promise<string | null>>();
  private errors = new Map<string, string>();
  private seq = 0;

  private fillSecrets: (m: Record<string, string>) => Record<string, string> = (m) => m;

  constructor(private servers: McpServerConfig[]) {}

  /** env / headers 里的 {{secret:NAME}} 用这个函数换成真值（只在启动进程、发请求时用，不落盘） */
  setSecretFiller(fn: (m: Record<string, string>) => Record<string, string>) {
    this.fillSecrets = fn;
  }

  async init(): Promise<void> {
    await Promise.all(this.servers.map(async (s) => {
      try {
        const result = s.url ? await this.httpRequest(s, "tools/list", {}) : await this.stdioRequest(s, "tools/list", {});
        this.toolsByServer.set(s.id, (result?.tools ?? []).map((t: any) => ({ serverId: s.id, name: t.name, description: t.description, inputSchema: t.inputSchema })));
        this.errors.delete(s.id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[mcp] server ${s.name} 初始化失败: ${msg}`);
        this.toolsByServer.set(s.id, []);
        this.errors.set(s.id, msg);
      }
    }));
  }

  /** 换一组 server 配置：关掉旧进程后重新连接 */
  async reload(servers: McpServerConfig[]): Promise<void> {
    this.close();
    this.servers = servers;
    this.toolsByServer.clear();
    this.errors.clear();
    await this.init();
  }

  /** 每个 server 的连接状态和工具数 */
  status(): (McpServerConfig & { tools: number; error?: string })[] {
    return this.servers.map((s) => ({ ...s, tools: this.toolsByServer.get(s.id)?.length ?? 0, error: this.errors.get(s.id) }));
  }

  listTools(): McpToolInfo[] {
    return [...this.toolsByServer.values()].flat();
  }

  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const s = this.servers.find((x) => x.id === serverId);
    if (!s) throw new Error(`MCP server ${serverId} 不存在`);
    const params = { name: toolName, arguments: args };
    return resultText(s.url ? await this.httpRequest(s, "tools/call", params) : await this.stdioRequest(s, "tools/call", params));
  }

  // ---- stdio ----
  private connect(s: McpServerConfig): StdioConn {
    const existing = this.conns.get(s.id);
    if (existing) return existing;
    if (!s.command) throw new Error(`${s.name} 没有配置启动命令`);
    const proc = spawn(s.command, s.args ?? [], { stdio: ["pipe", "pipe", "pipe"], env: mcpEnv(s.env ? this.fillSecrets(s.env) : undefined) });
    const conn: StdioConn = { proc, pending: new Map(), stderr: "", ready: Promise.resolve() };
    this.conns.set(s.id, conn);
    const failAll = (err: Error) => {
      for (const p of conn.pending.values()) { clearTimeout(p.timer); p.reject(err); }
      conn.pending.clear();
      if (this.conns.get(s.id) === conn) this.conns.delete(s.id);
    };
    let buf = "";
    proc.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        const p = typeof msg.id === "number" ? conn.pending.get(msg.id) : undefined;
        if (!p) continue;
        conn.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    });
    proc.stderr!.on("data", (chunk: Buffer) => { conn.stderr = (conn.stderr + chunk.toString()).slice(-2000); });
    proc.on("error", (e: NodeJS.ErrnoException) => failAll(new Error(e.code === "ENOENT" ? `找不到命令「${s.command}」` : e.message)));
    proc.on("exit", (code, signal) => {
      const tail = conn.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
      failAll(new Error(`进程已退出（${signal ?? `code ${code}`}）${tail ? `：${tail}` : ""}`));
    });
    conn.ready = this.rawStdio(conn, "initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }).then(() => {
      proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    });
    conn.ready.catch(() => {});
    return conn;
  }

  private rawStdio(conn: StdioConn, method: string, params: unknown): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { conn.pending.delete(id); reject(new Error(`${method} 超时`)); }, REQUEST_TIMEOUT_MS);
      conn.pending.set(id, { resolve, reject, timer });
      conn.proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private async stdioRequest(s: McpServerConfig, method: string, params: unknown): Promise<any> {
    const conn = this.connect(s);
    await conn.ready;
    return this.rawStdio(conn, method, params);
  }

  // ---- Streamable HTTP ----
  private async httpPost(s: McpServerConfig, body: unknown, session: string | null): Promise<{ res: Response; data: any }> {
    const url = s.url!;
    let allowPrivate = false;
    try {
      allowPrivate = await isPrivateHost(new URL(url).hostname);
    } catch { /* 无效 URL 交给 safeFetch */ }
    const res = await safeFetch(url, {
      method: "POST",
      allowPrivate,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(session ? { "Mcp-Session-Id": session } : {}),
        ...(s.headers ? this.fillSecrets(s.headers) : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok && res.status !== 202) throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
    const text = await res.text();
    if (!text.trim()) return { res, data: null };
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const events = text.split(/\n\n/).map((ev) => ev.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n")).filter(Boolean);
      const msgs = events.map((e) => { try { return JSON.parse(e); } catch { return null; } }).filter(Boolean);
      return { res, data: msgs.find((m: any) => m.id === (body as any).id) ?? msgs.at(-1) ?? null };
    }
    return { res, data: JSON.parse(text) };
  }

  private httpSession(s: McpServerConfig): Promise<string | null> {
    let p = this.httpSessions.get(s.id);
    if (!p) {
      p = (async () => {
        const { res, data } = await this.httpPost(s, { jsonrpc: "2.0", id: ++this.seq, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } }, null);
        if (data?.error) throw new Error(data.error.message ?? "initialize 失败");
        const session = res.headers.get("mcp-session-id");
        await this.httpPost(s, { jsonrpc: "2.0", method: "notifications/initialized" }, session).catch(() => {});
        return session;
      })();
      p.catch(() => this.httpSessions.delete(s.id));
      this.httpSessions.set(s.id, p);
    }
    return p;
  }

  private async httpRequest(s: McpServerConfig, method: string, params: unknown): Promise<any> {
    const session = await this.httpSession(s);
    const { data } = await this.httpPost(s, { jsonrpc: "2.0", id: ++this.seq, method, params }, session);
    if (data?.error) throw new Error(data.error.message ?? JSON.stringify(data.error));
    return data?.result ?? data;
  }

  close() {
    for (const c of this.conns.values()) c.proc.kill();
    this.conns.clear();
    this.httpSessions.clear();
  }
}
