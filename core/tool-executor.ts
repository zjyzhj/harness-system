import { exec } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, resolve, normalize, extname } from "node:path";
import type { SystemKit } from "./system-kit";
import type { MemorySystem } from "./memory-system";

export interface ToolResult {
  output: string;
  ok: boolean;
  durationMs: number;
}

export interface ExecutorOptions {
  allowedRoots: string[];        // 文件白名单根目录
  allowedCommands?: string[];    // bash 白名单（前缀匹配），空=所有
  deniedCommands?: string[];     // 明确禁止（如 rm -rf /）
  maxOutputBytes?: number;
  maxExecMs?: number;
}

const SAFE_COMMANDS = [
  "echo", "ls", "cat", "head", "tail", "grep", "rg", "find", "pwd", "date",
  "whoami", "curl", "wget", "node", "bun", "python3", "git", "npm", "pnpm",
  "mkdir", "touch", "cp", "mv", "wc", "sort", "uniq", "sed", "awk", "jq",
  "open", "osascript", "swift", "ps", "top", "df", "du",
];

/**
 * 真工具执行器 — 让技能「真干活」。
 * 内置工具：fs.read / fs.write / fs.list / bash.run / web.fetch / notify
 * 安全：命令白名单 + 目录白名单 + 超时 + 输出上限 + 禁止危险命令
 */
export class ToolExecutor {
  private opts: Required<Pick<ExecutorOptions, "allowedRoots" | "allowedCommands" | "deniedCommands" | "maxOutputBytes" | "maxExecMs">> & ExecutorOptions;

  constructor(opts: ExecutorOptions, private system?: SystemKit, private memory?: MemorySystem) {
    this.opts = {
      allowedRoots: opts.allowedRoots,
      allowedCommands: opts.allowedCommands ?? SAFE_COMMANDS,
      deniedCommands: ["rm -rf /", "dd if=", ":(){", "mkfs", "chmod 777 /"],
      maxOutputBytes: opts.maxOutputBytes ?? 16_000,
      maxExecMs: opts.maxExecMs ?? 30_000,
    };
  }

  /** 统一执行入口 */
  async run(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    const t0 = Date.now();
    try {
      const out = await this.dispatch(tool, args);
      return { output: out, ok: true, durationMs: Date.now() - t0 };
    } catch (e) {
      return { output: `❌ ${e instanceof Error ? e.message : String(e)}`, ok: false, durationMs: Date.now() - t0 };
    }
  }

  private async dispatch(tool: string, args: Record<string, unknown>): Promise<string> {
    switch (tool) {
      case "fs.read": return this.fsRead(String(args.path ?? ""));
      case "fs.write": return this.fsWrite(String(args.path ?? ""), String(args.content ?? ""));
      case "fs.list": return this.fsList(String(args.path ?? "."));
      case "bash.run": return this.bashRun(String(args.command ?? ""));
      case "web.fetch": return this.webFetch(String(args.url ?? ""));
      case "notify": return this.notify(String(args.title ?? "通知"), String(args.body ?? ""));
      case "memory.add": return this.memoryAdd(String(args.botId ?? ""), args);
      case "memory.search": return this.memorySearch(String(args.botId ?? ""), String(args.query ?? ""));
      default: throw new Error(`未知工具: ${tool}`);
    }
  }

  // ---- 文件 ----
  private assertPath(p: string) {
    const abs = normalize(resolve(p));
    const allowed = this.opts.allowedRoots.some((root) => abs === normalize(resolve(root)) || abs.startsWith(normalize(resolve(root)) + "/"));
    if (!allowed) throw new Error(`路径不在白名单内: ${abs}`);
    return abs;
  }

  private fsRead(p: string): string {
    const abs = this.assertPath(p);
    if (!existsSync(abs)) throw new Error(`文件不存在: ${abs}`);
    const data = readFileSync(abs, "utf8");
    return data.length > this.opts.maxOutputBytes ? data.slice(0, this.opts.maxOutputBytes) + `\n…(截断，共 ${data.length} 字节)` : data;
  }

  private fsWrite(p: string, content: string): string {
    const abs = this.assertPath(p);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
    return `已写入 ${abs}（${content.length} 字符）`;
  }

  private fsList(p: string): string {
    const abs = this.assertPath(p);
    if (!existsSync(abs)) throw new Error(`目录不存在: ${abs}`);
    const entries = readdirSync(abs).slice(0, 100);
    return entries.map((e) => {
      const st = statSync(join(abs, e));
      return `${st.isDirectory() ? "📁" : extname(e) ? "📄" : "📄"} ${e}`;
    }).join("\n");
  }

  // ---- bash ----
  private bashRun(cmd: string): Promise<string> {
    if (!cmd.trim()) throw new Error("命令为空");
    if (this.opts.deniedCommands.some((d) => cmd.includes(d))) throw new Error(`命令被安全策略禁止: ${cmd.slice(0, 60)}`);
    const first = cmd.trim().split(/\s+/)[0];
    const allowed = this.opts.allowedCommands?.length === 0 || this.opts.allowedCommands?.includes(first) || (first.includes("/") && existsSync(first));
    if (!allowed) throw new Error(`命令 ${first} 不在白名单（可用: ${this.opts.allowedCommands?.slice(0, 20).join(", ")}…）`);
    return new Promise((resolvePromise, reject) => {
      const child = exec(cmd, { timeout: this.opts.maxExecMs, maxBuffer: this.opts.maxOutputBytes * 2 }, (err, stdout, stderr) => {
        if (err && !stdout) {
          reject(new Error(`${err.message}${stderr ? "\n" + stderr.slice(0, 800) : ""}`));
          return;
        }
        resolvePromise((stdout || stderr).slice(0, this.opts.maxOutputBytes));
      });
      child.on("error", reject);
    });
  }

  // ---- web ----
  private async webFetch(url: string): Promise<string> {
    if (!/^https?:\/\//.test(url)) throw new Error("URL 需以 http(s):// 开头");
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { "User-Agent": "HarnessBot/0.1" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return text.slice(0, this.opts.maxOutputBytes);
  }

  // ---- notify ----
  private async notify(title: string, body: string): Promise<string> {
    if (this.system) await this.system.notify(title, body);
    return `已通知: ${title}`;
  }

  // ---- memory ----
  private memoryAdd(botId: string, args: Record<string, unknown>): string {
    if (!this.memory) throw new Error("记忆系统未注入");
    this.memory.add(botId, {
      kind: (args.kind as any) || "fact",
      content: String(args.content ?? ""),
      tags: args.tags ? String(args.tags).split(",").map((s) => s.trim()) : undefined,
      source: "tool",
    });
    return "已记住";
  }
  private memorySearch(botId: string, query: string): string {
    if (!this.memory) throw new Error("记忆系统未注入");
    const hits = this.memory.search(botId, query, 6);
    return hits.length ? hits.map((h) => `- ${h.content}`).join("\n") : "（暂无相关记忆）";
  }
}

/** 内置工具的可调用描述（给模型看） */
export const BUILTIN_TOOL_DESCRIPTIONS = `- fs.read: 读取白名单内文件内容。参数: path
- fs.write: 写入文件（白名单内）。参数: path, content
- fs.list: 列出目录内容。参数: path
- bash.run: 执行白名单命令（如 curl/ls/cat/git）。参数: command
- web.fetch: 抓取网页文本。参数: url
- notify: 发送系统通知。参数: title, body
- memory.add: 保存持久记忆。参数: botId, content, kind
- memory.search: 检索记忆。参数: botId, query`;
