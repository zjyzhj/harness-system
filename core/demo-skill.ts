/**
 * 演示 → 技能：录制本机工具轨迹，收束成 SKILL.md，可挂定时重跑。
 * 不做屏幕跟看 / 云电脑；只记 Harness 工具调用摘要（密钥打码）。
 */
import { randomUUID } from "node:crypto";

export interface DemoStep {
  tool: string;
  /** 已打码的参数摘要 */
  args: Record<string, unknown>;
  resultSummary: string;
  at: number;
  ok: boolean;
}

export interface DemoSession {
  id: string;
  botId: string;
  sessionId?: string;
  title?: string;
  startedAt: number;
  steps: DemoStep[];
}

export interface DemoSkillDraft {
  name: string;
  description: string;
  body: string;
  steps: number;
  sessionId: string;
}

const SKIP_TOOLS = /^(demo\.|ui\.|plan\.list|app\.state|app\.listModels|memory\.list|memory\.search|bot\.list|task\.list|skill\.list|skill\.get|pet\.)/;

/** 参数里像密钥的字段名 */
const SECRET_KEYS = /^(api[_-]?key|token|password|secret|authorization|auth|cookie|credential|private[_-]?key)$/i;

export class DemoSkillEngine {
  private active = new Map<string, DemoSession>();

  start(botId: string, opts?: { sessionId?: string; title?: string }): DemoSession {
    const prev = this.active.get(botId);
    if (prev) this.active.delete(botId);
    const session: DemoSession = {
      id: `demo-${randomUUID().slice(0, 8)}`,
      botId,
      sessionId: opts?.sessionId,
      title: opts?.title?.trim() || undefined,
      startedAt: Date.now(),
      steps: [],
    };
    this.active.set(botId, session);
    return session;
  }

  status(botId: string): DemoSession | null {
    return this.active.get(botId) ?? null;
  }

  isRecording(botId: string): boolean {
    return this.active.has(botId);
  }

  cancel(botId: string): DemoSession | null {
    const s = this.active.get(botId) ?? null;
    if (s) this.active.delete(botId);
    return s;
  }

  /**
   * 记录一步工具调用。demo.* / 纯查询类工具默认跳过。
   * 返回是否写入。
   */
  record(
    botId: string,
    input: { tool: string; args?: Record<string, unknown>; output?: string; ok?: boolean },
  ): boolean {
    const session = this.active.get(botId);
    if (!session) return false;
    const tool = String(input.tool || "").trim();
    if (!tool || SKIP_TOOLS.test(tool)) return false;
    const output = String(input.output ?? "");
    const ok = input.ok ?? !output.startsWith("❌");
    session.steps.push({
      tool,
      args: redactArgs(input.args ?? {}),
      resultSummary: summarizeResult(output),
      at: Date.now(),
      ok,
    });
    return true;
  }

  /**
   * 结束录制并生成技能草稿（不落盘；由 Runtime 调 SkillRegistry.save）。
   */
  finish(
    botId: string,
    opts?: { name?: string; description?: string },
  ): { ok: true; draft: DemoSkillDraft; session: DemoSession } | { ok: false; error: string } {
    const session = this.active.get(botId);
    if (!session) return { ok: false, error: "当前没有进行中的演示录制。先 demo.start。" };
    if (!session.steps.length) {
      return { ok: false, error: "还没有录到任何工具步骤。先按流程调用工具（fs/bash/mcp/web…），再 demo.finish。" };
    }
    const name = (opts?.name || session.title || guessName(session)).trim().slice(0, 60);
    const description = (opts?.description || guessDescription(session, name)).trim().slice(0, 200);
    const body = buildBody(session, name);
    // 先停录；落盘失败可用 reopen 恢复
    this.active.delete(botId);
    return {
      ok: true,
      session,
      draft: { name, description, body, steps: session.steps.length, sessionId: session.id },
    };
  }

  /** 技能落盘失败时恢复录制会话（继续补步或重试 finish） */
  reopen(botId: string, session: DemoSession): void {
    this.active.set(botId, session);
  }

  /** 稳定前缀：一行录制状态 */
  brief(botId: string): string | null {
    const s = this.active.get(botId);
    if (!s) return null;
    return `【演示录制中】已录 ${s.steps.length} 步（id=${s.id}）。继续用工具完成流程；结束用 demo.finish，取消用 demo.cancel。演示是本机工具轨迹，不是云电脑跟看。`;
  }

  /** 用户谈演示 / 正在录制时的操作手册 */
  playbook(botId: string): string {
    const s = this.active.get(botId);
    const head = s
      ? `正在录制「${s.title || "未命名"}」：已 ${s.steps.length} 步。`
      : "用户想把流程教成可复用技能。";
    return [
      `【演示→技能 · 本机】${head}`,
      "开始：demo.start title=…；状态：demo.status；取消：demo.cancel。",
      "录制期间正常调用 fs/bash/mcp/web/bot.ask 等工具即可自动记步骤（查询类与 demo.* 本身不记）。",
      "结束：demo.finish name=… description=…；可选 cron=… 或 in=30m 挂定时重跑。",
      "不要假装跟看了屏幕；不要把密钥原文写进技能。",
    ].join("\n");
  }
}

export function isDemoTopic(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  return /教你|教我|跟我做|跟看|演示|录成技能|录制技能|学会这个|记住这套|demo\.(start|finish|status|cancel)|演示一遍|走一遍流程/i.test(t);
}

export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (SECRET_KEYS.test(k)) {
      out[k] = "[redacted]";
      continue;
    }
    if (typeof v === "string") {
      out[k] = redactString(v).slice(0, 400);
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = redactArgs(v as Record<string, unknown>);
    } else if (Array.isArray(v)) {
      out[k] = v.slice(0, 20).map((x) => (typeof x === "string" ? redactString(x).slice(0, 200) : x));
    } else {
      out[k] = v;
    }
  }
  return out;
}

function redactString(s: string): string {
  return s
    .replace(/\{\{secret:[^}]+\}\}/gi, "{{secret:***}}")
    .replace(/\b(sk-[a-zA-Z0-9]{16,}|ghp_[a-zA-Z0-9]{20,}|xox[baprs]-[a-zA-Z0-9-]{20,})\b/g, "[redacted-token]")
    .replace(/(api[_-]?key|token|password|secret)\s*[:=]\s*["']?[^\s"'&,;]+/gi, "$1=[redacted]");
}

export function summarizeResult(output: string): string {
  const t = redactString(String(output || "").replace(/```tool[\s\S]*?```/g, "").trim());
  if (!t) return "（无输出）";
  if (t.length <= 280) return t;
  return `${t.slice(0, 240)}…（共 ${t.length} 字）`;
}

function guessName(session: DemoSession): string {
  if (session.title) return session.title;
  const tools = [...new Set(session.steps.map((s) => s.tool.split(".")[0] || s.tool))];
  return `演示流程（${tools.slice(0, 3).join("+")}）`;
}

function guessDescription(session: DemoSession, name: string): string {
  const tools = session.steps.map((s) => s.tool).join(" → ");
  return `根据演示录制的可复用流程「${name}」。步骤工具：${tools.slice(0, 160)}`;
}

function buildBody(session: DemoSession, name: string): string {
  const lines: string[] = [
    `# ${name}`,
    "",
    "本技能由「演示→技能」从本机工具轨迹生成。按下列步骤执行；遇到需用户确认的操作先 ui.confirm。",
    "",
    "## 步骤",
  ];
  session.steps.forEach((step, i) => {
    const argsJson = JSON.stringify(step.args, null, 0);
    lines.push("");
    lines.push(`### ${i + 1}. \`${step.tool}\`${step.ok ? "" : "（当时失败，复跑时注意）"}`);
    lines.push(`- 参数参考：\`${argsJson.slice(0, 500)}\``);
    lines.push(`- 当时结果摘要：${step.resultSummary}`);
    lines.push(`- 复跑：调用工具 \`${step.tool}\`，参数按当前任务调整，不要照抄过期路径/临时值。`);
  });
  lines.push("");
  lines.push("## 注意");
  lines.push("- 密钥用 `{{secret:名字}}` 或环境变量，不要写死在技能里。");
  lines.push("- 若步骤依赖用户本机状态（文件是否存在、登录态），先检查再执行。");
  lines.push(`- 录制 id：${session.id}；开始于 ${new Date(session.startedAt).toISOString()}。`);
  return lines.join("\n");
}
