import { spawn, type ChildProcess } from "node:child_process";
import type { ToolInvocation } from "./types";

export interface McpServerConfig {
  id: string;
  name: string;
  /** stdio 启动命令（command + args） */
  command?: string;
  args?: string[];
  /** HTTP/SSE 端点（如本机 grok 网关） */
  url?: string;
  headers?: Record<string, string>;
}

export interface McpToolInfo {
  serverId: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** 极简 MCP 客户端：stdio 或 HTTP，工具发现 + 调用 */
export class McpClient {
  private toolsByServer = new Map<string, McpToolInfo[]>();
  private procs = new Map<string, ChildProcess>();

  constructor(private servers: McpServerConfig[]) {}

  async init(): Promise<void> {
    for (const s of this.servers) {
      try {
        const tools = s.url ? await this.listHttpTools(s) : await this.listStdioTools(s);
        this.toolsByServer.set(s.id, tools);
      } catch (e) {
        console.warn(`[mcp] server ${s.name} 初始化失败: ${e instanceof Error ? e.message : e}`);
        this.toolsByServer.set(s.id, []);
      }
    }
  }

  listTools(): McpToolInfo[] {
    return [...this.toolsByServer.values()].flat();
  }

  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const s = this.servers.find((x) => x.id === serverId);
    if (!s) throw new Error(`MCP server ${serverId} 不存在`);
    if (s.url) return this.callHttpTool(s, toolName, args);
    return this.callStdioTool(s, toolName, args);
  }

  // ---- HTTP ----
  private async listHttpTools(s: McpServerConfig): Promise<McpToolInfo[]> {
    // MCP over HTTP: POST /tools/list（简化协议，兼容常见网关）
    const res = await fetch(s.url!.replace(/\/$/, ""), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(s.headers ?? {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as any;
    return (data?.result?.tools ?? data?.tools ?? []).map((t: any) => ({
      serverId: s.id, name: t.name, description: t.description, inputSchema: t.inputSchema,
    }));
  }

  private async callHttpTool(s: McpServerConfig, tool: string, args: Record<string, unknown>): Promise<string> {
    const res = await fetch(s.url!.replace(/\/$/, ""), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(s.headers ?? {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: tool, arguments: args } }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as any;
    return JSON.stringify(data?.result ?? data);
  }

  // ---- stdio ----
  private ensureProc(s: McpServerConfig): ChildProcess {
    let proc = this.procs.get(s.id);
    if (proc) return proc;
    if (!s.command) throw new Error(`${s.name} 无 command`);
    proc = spawn(s.command, s.args ?? [], { stdio: ["pipe", "pipe", "pipe"] });
    proc.on("error", (e) => console.warn(`[mcp] ${s.name} 进程错误: ${e.message}`));
    this.procs.set(s.id, proc);
    return proc;
  }

  private request(s: McpServerConfig, method: string, params: unknown): Promise<any> {
    const proc = this.ensureProc(s);
    return new Promise((resolve, reject) => {
      const id = Date.now() + Math.random();
      const timer = setTimeout(() => { reject(new Error(`${method} 超时`)); }, 15_000);
      const onData = (buf: Buffer) => {
        const text = buf.toString();
        // 极简 JSON-RPC over stdio（行协议）
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id === id) {
              clearTimeout(timer);
              proc.stdout!.off("data", onData);
              msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
            }
          } catch { /* 忽略非 JSON 行 */ }
        }
      };
      proc.stdout!.on("data", onData);
      proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private async listStdioTools(s: McpServerConfig): Promise<McpToolInfo[]> {
    const result = await this.request(s, "tools/list", {});
    return (result?.tools ?? []).map((t: any) => ({ serverId: s.id, name: t.name, description: t.description, inputSchema: t.inputSchema }));
  }

  private async callStdioTool(s: McpServerConfig, tool: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.request(s, "tools/call", { name: tool, arguments: args });
    const content = result?.content ?? [];
    return content.map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c))).join("\n");
  }

  close() {
    for (const p of this.procs.values()) p.kill();
    this.procs.clear();
  }
}
