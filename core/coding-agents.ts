/**
 * 本机 Coding Agent 注册表 + 实时探测。
 * 派工（cli.agent）与设置页共用：以探测结果为准，不手写「能调哪些」。
 * 加新后端 = 往 BUILTIN 加一条（bin + agent 参数），探测会自动带上。
 */
import { detectCli, type CliCapability, type CliName } from "./adapters/cli";

export type CodingAgentId = string;

export interface CodingAgentBackend {
  id: CodingAgentId;
  /** PATH 上的可执行名（展示用） */
  bin: string;
  label: string;
  /** 可走聊天 CLI Provider */
  chat: boolean;
  /** 可走 cli.agent 写仓库 */
  agent: boolean;
  /** 派工参数；仅 agent:true 需要 */
  buildAgentArgs?: (prompt: string, cwd: string) => string[];
  /** 探测优先级（小者优先），未装则跳过 */
  order?: number;
}

export interface CodingAgentStatus extends CliCapability {
  id: CodingAgentId;
  bin: string;
  label: string;
  chat: boolean;
  agent: boolean;
}

/** 内置：已核验可写 Agent 参数的三家；后续只加注册表，不改调用点 */
const BUILTIN: CodingAgentBackend[] = [
  {
    id: "cursor",
    bin: "cursor-agent",
    label: "Cursor Agent",
    chat: true,
    agent: true,
    order: 10,
    buildAgentArgs: (prompt, cwd) => [
      "-p",
      "--output-format",
      "text",
      "--trust",
      "--force",
      "--sandbox",
      "disabled",
      "--workspace",
      cwd,
      prompt,
    ],
  },
  {
    id: "claude",
    bin: "claude",
    label: "Claude Code",
    chat: true,
    agent: true,
    order: 20,
    buildAgentArgs: (prompt) => ["-p", "--output-format", "text", "--dangerously-skip-permissions", prompt],
  },
  {
    id: "codex",
    bin: "codex",
    label: "Codex CLI",
    chat: true,
    agent: true,
    order: 30,
    buildAgentArgs: (prompt, cwd) => ["exec", "--skip-git-repo-check", "-s", "workspace-write", "-C", cwd, prompt],
  },
];

const extras: CodingAgentBackend[] = [];

/** 运行时追加（测试 / 以后读 config 注册自定义） */
export function registerCodingAgent(backend: CodingAgentBackend) {
  const i = extras.findIndex((x) => x.id === backend.id);
  if (i >= 0) extras[i] = backend;
  else extras.push(backend);
  cache = null;
}

export function resetCodingAgentExtrasForTests() {
  extras.length = 0;
  cache = null;
}

export function listCodingAgentBackends(): CodingAgentBackend[] {
  const map = new Map<string, CodingAgentBackend>();
  for (const b of [...BUILTIN, ...extras]) map.set(b.id, b);
  return [...map.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

export function getCodingAgent(id: string): CodingAgentBackend | undefined {
  return listCodingAgentBackends().find((b) => b.id === id);
}

export function agentBin(id: string): string | undefined {
  return getCodingAgent(id)?.bin;
}

export function buildCodingAgentArgs(id: string, prompt: string, cwd: string): string[] {
  const b = getCodingAgent(id);
  if (!b?.buildAgentArgs) throw new Error(`Coding Agent「${id}」未配置派工参数`);
  return b.buildAgentArgs(prompt, cwd);
}

let cache: { at: number; items: CodingAgentStatus[] } | null = null;
const TTL_MS = 45_000;

/** 强制或按 TTL 探测；结果供提示词 / UI / 派工选用 */
export async function probeCodingAgents(opts?: { force?: boolean }): Promise<CodingAgentStatus[]> {
  if (!opts?.force && cache && Date.now() - cache.at < TTL_MS) return cache.items;
  const items: CodingAgentStatus[] = [];
  for (const b of listCodingAgentBackends()) {
    // 内置三家走 adapters/cli（含账号）；扩展项只查 bin --version
    const known = b.id === "cursor" || b.id === "claude" || b.id === "codex";
    const cap: CliCapability = known ? await detectCli(b.id as CliName) : await detectBinVersion(b.bin);
    items.push({
      id: b.id,
      bin: b.bin,
      label: b.label,
      chat: b.chat && cap.installed,
      agent: b.agent && cap.installed,
      installed: cap.installed,
      version: cap.version,
      account: cap.account,
    });
  }
  cache = { at: Date.now(), items };
  return items;
}

async function detectBinVersion(bin: string): Promise<CliCapability> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    let out = "";
    const p = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    const t = setTimeout(() => {
      try {
        p.kill();
      } catch {
        /* */
      }
      resolve({ installed: false, chat: false });
    }, 8_000);
    p.stdout?.on("data", (d) => {
      out += String(d);
    });
    p.on("error", () => {
      clearTimeout(t);
      resolve({ installed: false, chat: false });
    });
    p.on("close", (code) => {
      clearTimeout(t);
      if (code === 0 && out.trim()) {
        resolve({ installed: true, version: out.trim().split("\n")[0], chat: true });
      } else resolve({ installed: false, chat: false });
    });
  });
}

/** 上次探测快照（同步；未探测过则空，提示词会写「将按需探测」） */
export function codingAgentsSnapshot(): CodingAgentStatus[] {
  return cache?.items ?? [];
}

export function invalidateCodingAgentsCache() {
  cache = null;
}

/** 在已装且支持 agent 的里选：偏好 → 注册表顺序 */
export async function pickCodingAgent(preferred?: string | null): Promise<CodingAgentId | null> {
  const items = await probeCodingAgents();
  const agents = items.filter((x) => x.agent && x.installed);
  if (!agents.length) return null;
  if (preferred) {
    const hit = agents.find((x) => x.id === preferred);
    if (hit) return hit.id;
  }
  return agents[0]!.id;
}

export function parseCodingAgentId(raw: unknown): CodingAgentId | undefined {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return undefined;
  const ids = new Set(listCodingAgentBackends().map((b) => b.id));
  return ids.has(s) ? s : undefined;
}

/** 给模型看的一行清单（跟随最近一次探测） */
export function formatCodingAgentsPromptLine(items?: CodingAgentStatus[]): string {
  const list = items ?? codingAgentsSnapshot();
  if (!list.length) {
    return "- 写代码派工：本机 Coding CLI 尚未探测；调用 cli.agent 时会现查已装项（不必手写名单）。";
  }
  const lines = list.map((x) => {
    if (!x.installed) return `  - ${x.id}（${x.bin}）：未安装`;
    const bits = [x.version ? `v${x.version.split(/\s+/)[0]}` : "已装", x.agent ? "可派工" : "仅聊天", x.account ? x.account : ""].filter(Boolean);
    return `  - ${x.id}（${x.bin}）：${bits.join(" · ")}`;
  });
  const ready = list.filter((x) => x.agent).map((x) => x.id);
  return [
    `- 写代码派工（cli.agent）：以下为本机实时探测，安装/卸载后刷新设置或下次派工会更新，不要背死名单。`,
    ...lines,
    ready.length
      ? `  可派工：${ready.join(" / ")}。参数 cli 可省略（按 bot 偏好→探测顺序）；未装的偏好会自动换。`
      : `  当前没有可派工的 Coding CLI，请先安装并登录其一。`,
  ].join("\n");
}

export function cliAgentToolDescription(items?: CodingAgentStatus[]): string {
  const list = items ?? codingAgentsSnapshot();
  const ready = list.filter((x) => x.agent).map((x) => x.id);
  const names = ready.length ? ready.join("|") : listCodingAgentBackends().filter((b) => b.agent).map((b) => b.id).join("|");
  return `派本机 Coding CLI（Agent 可写）改工程。大仓库/多文件用它；小文件仍 fs.write。参数: task, cwd?（或 PROJECT_ROOT / bot.agentCwd）, cli?（${names}；省略则按本机已装与偏好自动选）, timeoutMin?。会弹确认；用户拒绝后不要换 CLI 绕过。当前可派工以【已配置的环境】里探测结果为准。`;
}
