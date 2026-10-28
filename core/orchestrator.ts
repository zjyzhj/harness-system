import { randomUUID } from "node:crypto";
import { readJsonSafe, writeJsonAtomic } from "./atomic-fs";
import { join } from "node:path";
import type { Bot, ContentBlock, OrchestrationPlan, OrchestrationStage, OrchestrationStageMode } from "./types";
import type { Store } from "./store";
import type { GroupRegistry } from "./group-registry";
import type { ProviderCenter } from "./provider-center";

export interface OrchestratorDeps {
  store: Store;
  groups?: GroupRegistry;
  providers?: ProviderCenter;
}

export interface StageContext {
  signal: AbortSignal;
  /** 流式产出增量 */
  onText: (delta: string) => void;
  /** 当前动作（如「调用 web.search」） */
  onActivity: (what: string) => void;
}
export type StageRunner = (stage: OrchestrationStage, prevResult: string | undefined, ctx: StageContext) => Promise<string>;

/**
 * G4 编排器 — 对标 CowAgent agent/multiagent/orchestrator.py
 * - seq：串行，上一阶段 result 注入下一阶段 prompt
 * - fan：并行 fan-out，全部完成后汇总（concat）
 * - 超时（默认 5min）/ 取消 / 重试（每阶段 2 次）
 * - 权限：仅 owner ∈ groups.admin 或 owner === "user" 可 run
 * - 持久化 plans.json
 */
export class Orchestrator {
  private plans = new Map<string, OrchestrationPlan>();
  private file: string;
  private abortFlags = new Map<string, boolean>();
  private controllers = new Map<string, AbortController>();
  stageRunner: StageRunner | null = null;
  /** 计划状态或实时产出变化时回调（界面推送用） */
  onChange: ((plan: OrchestrationPlan) => void) | null = null;

  constructor(private deps: OrchestratorDeps, private home: string) {
    this.file = join(home, "plans.json");
    this.load();
  }

  private load() {
    {
      const raw = readJsonSafe<OrchestrationPlan[]>(this.file, []);
      if (Array.isArray(raw)) {
        for (const p of raw) {
          // 上次退出时还在跑的计划已经不可能继续了
          if (p.status === "running") {
            p.status = "error";
            p.result = p.result ?? "（应用退出，已中断）";
            for (const s of p.stages) if (s.status === "running") { s.status = "error"; s.error = "应用退出，已中断"; }
          }
          this.plans.set(p.id, p);
        }
      }
    }
  }
  private persist(changed?: OrchestrationPlan) {
    writeJsonAtomic(this.file, [...this.plans.values()].map((p) => ({ ...p, stages: p.stages.map(({ live: _l, activity: _a, ...s }) => s) })));
    if (changed) this.emit(changed);
  }
  private emit(plan: OrchestrationPlan) {
    try { this.onChange?.(plan); } catch { /* 界面推送失败不影响编排 */ }
  }

  /** 权限：user 或 group admin 可发起；非授权 bot 拒绝 */
  assertCanRun(ownerBotId: string) {
    if (ownerBotId === "user") return;
    const groups = this.deps.groups;
    if (!groups) return;
    const isAdmin = groups.list().some((g) => g.admin === ownerBotId);
    if (!isAdmin) throw new Error(`权限不足：${ownerBotId} 不是任何群组管理员，无法发起编排`);
  }

  create(input: { ownerBotId: string; title: string; stages: Array<{ botId: string; prompt: string; mode?: OrchestrationStageMode }> }): OrchestrationPlan {
    this.assertCanRun(input.ownerBotId);
    const plan: OrchestrationPlan = {
      id: randomUUID(),
      ownerBotId: input.ownerBotId,
      title: input.title,
      createdAt: Date.now(),
      status: "pending",
      stages: input.stages.map((s, i) => ({
        id: `${randomUUID()}-${i}`,
        botId: s.botId,
        prompt: s.prompt,
        mode: s.mode ?? "seq",
        status: "pending" as const,
        retries: 0,
      })),
    };
    if (plan.stages.length === 0) throw new Error("编排需要至少一个阶段");
    this.plans.set(plan.id, plan);
    this.persist();
    return plan;
  }

  /** 执行计划：seq 串行 / fan 并行；返回最终 plan（result 为最后阶段结果） */
  async run(planId: string, opts?: { timeoutMs?: number }): Promise<OrchestrationPlan> {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`计划不存在: ${planId}`);
    if (!this.stageRunner) throw new Error("编排器未绑定 stageRunner");
    if (plan.status === "running") throw new Error("这个计划正在运行");
    plan.status = "running";
    plan.result = undefined;
    plan.currentStage = undefined;
    plan.startedAt = Date.now();
    plan.finishedAt = undefined;
    for (const s of plan.stages) {
      Object.assign(s, { status: "pending", result: undefined, error: undefined, startedAt: undefined, finishedAt: undefined, live: undefined, activity: undefined, retries: 0 });
    }
    this.abortFlags.set(planId, false);
    this.controllers.set(planId, new AbortController());
    this.persist(plan);
    const timeoutMs = opts?.timeoutMs ?? 5 * 60_000;

    try {
      let prevResult: string | undefined;
      let seqCursor = 0;
      while (seqCursor < plan.stages.length) {
        if (this.abortFlags.get(planId)) return this.end(plan, "error", "（已取消）");
        const stage = plan.stages[seqCursor];
        if (stage.mode === "fan") {
          // 收集连续 fan 阶段并行执行
          const fans: OrchestrationStage[] = [];
          while (seqCursor < plan.stages.length && plan.stages[seqCursor].mode === "fan") {
            fans.push(plan.stages[seqCursor]);
            seqCursor++;
          }
          const outputs = await Promise.all(fans.map((s) => this.runStage(plan, s, prevResult, timeoutMs)));
          prevResult = outputs.filter(Boolean).join("\n\n");
        } else {
          await this.runStage(plan, stage, prevResult, timeoutMs);
          if (!stage.result) return this.end(plan, "error", `阶段「${stage.prompt.slice(0, 20)}」没有产出`);
          prevResult = stage.result;
          seqCursor++;
        }
      }
      return this.end(plan, "done", prevResult);
    } catch (e) {
      return this.end(plan, "error", this.abortFlags.get(planId) ? "（已取消）" : `编排失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.controllers.delete(planId);
    }
  }

  private end(plan: OrchestrationPlan, status: "done" | "error", result: string | undefined) {
    // 取消时 cancel() 已经收尾，这里不再覆盖
    if (plan.status === "running") {
      plan.status = status;
      plan.result = result;
      plan.currentStage = undefined;
      plan.finishedAt = Date.now();
    }
    for (const s of plan.stages) { s.live = undefined; s.activity = undefined; }
    this.persist(plan);
    return plan;
  }

  private async runStage(plan: OrchestrationPlan, stage: OrchestrationStage, prevResult: string | undefined, timeoutMs: number) {
    if (this.abortFlags.get(plan.id)) throw new Error("已取消");
    stage.status = "running";
    stage.startedAt = Date.now();
    stage.live = "";
    plan.currentStage = stage.prompt.slice(0, 40);
    this.persist(plan);
    const prompt = prevResult
      ? `${stage.prompt}\n\n【上一阶段结果】\n${prevResult.slice(0, 8000)}`
      : stage.prompt;
    const ctrl = this.controllers.get(plan.id) ?? new AbortController();
    const ctx: StageContext = {
      signal: ctrl.signal,
      onText: (d) => { if (stage.status !== "running") return; stage.live = (stage.live ?? "") + d; stage.activity = undefined; this.emit(plan); },
      onActivity: (w) => { if (stage.status !== "running") return; stage.activity = w; this.emit(plan); },
    };
    const runOnce = async (): Promise<string> => {
      if (!this.stageRunner) throw new Error("stageRunner 未绑定");
      return this.stageRunner!({ ...stage, prompt }, prevResult, ctx);
    };
    try {
      // 超时：可清理 timer，避免遗留挂起进程
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<string>((_, rej) => {
        timer = setTimeout(() => { ctrl.abort(); rej(new Error(`阶段超时 ${timeoutMs / 1000}s`)); }, timeoutMs);
        timer.unref?.();
      });
      let result: string;
      try {
        result = await Promise.race([runOnce(), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (this.abortFlags.get(plan.id)) throw new Error("已取消");
      stage.result = result;
      stage.status = "done";
      stage.finishedAt = Date.now();
      stage.live = undefined;
      stage.activity = undefined;
      this.persist(plan);
      return result;
    } catch (e) {
      const err = this.abortFlags.get(plan.id) ? "已取消" : e instanceof Error ? e.message : String(e);
      if (stage.status === "running") {
        stage.status = "error";
        stage.error = err;
        stage.finishedAt = Date.now();
      }
      stage.activity = undefined;
      this.persist(plan);
      throw new Error(`阶段「${stage.prompt.slice(0, 30)}」失败：${err}`);
    }
  }

  cancel(planId: string) {
    this.abortFlags.set(planId, true);
    this.controllers.get(planId)?.abort();
    const plan = this.plans.get(planId);
    if (plan && plan.status === "running") {
      plan.status = "error";
      plan.result = "（已取消）";
      plan.currentStage = undefined;
      plan.finishedAt = Date.now();
      for (const s of plan.stages) if (s.status === "running") { s.status = "error"; s.error = "已取消"; s.finishedAt = Date.now(); s.activity = undefined; }
      this.persist(plan);
    }
  }

  delete(planId: string) {
    this.abortFlags.set(planId, true);
    this.controllers.get(planId)?.abort();
    this.plans.delete(planId);
    this.persist();
  }

  list(): OrchestrationPlan[] {
    return [...this.plans.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
  listForBot(botId: string): OrchestrationPlan[] {
    return this.list().filter((p) => p.ownerBotId === botId || p.stages.some((s) => s.botId === botId));
  }
  prune(olderThanMs: number) {
    const cutoff = Date.now() - olderThanMs;
    for (const [id, p] of this.plans) if (p.createdAt < cutoff) this.plans.delete(id);
    this.persist();
  }
}

/** 富内容块 → 纯文本（编排结果注入用） */
export function contentToText(content: string | ContentBlock[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text ?? "").join("\n");
}

/**
 * 一句话 → 编排计划（LLM 解析优先，规则降级）。
 * 支持「让 A 调研，B 总结，C 写报告」（逗号/顿号/→ 分段）。
 */
export class PlanParseError extends Error {}

export async function planFromText(
  text: string,
  bots: Bot[],
  opts?: { provider?: { id: string }; complete?: (p: any, req: any) => Promise<{ text: string }> },
): Promise<Array<{ botId: string; prompt: string; mode?: OrchestrationStageMode }>> {
  const nameToBot = new Map(bots.map((b) => [b.name, b]));
  // 1) LLM 解析（可选）
  if (opts?.provider && opts.complete) {
    try {
      const r = await opts.complete(opts.provider, {
        system: `你是任务编排解析器。把用户指令拆成顺序阶段（只输出 JSON 数组，不要多余文字）：
[{"bot":"<bot名>","prompt":"<给该 bot 的指令>","mode":"seq|fan"}]
可用 bot：${bots.map((b) => b.name).join("、")}
"bot" 必须原样写用户指定的名字；用户提到的执行者不在可用 bot 里时照样原样写出来，不要换成别的 bot。用户没指定执行者的阶段，挑最合适的可用 bot。`,
        user: text,
        signal: AbortSignal.timeout(45_000),
      });
      const arr = JSON.parse(r.text.replace(/```json|```/g, "").trim());
      const stages: Array<{ botId: string; prompt: string; mode?: OrchestrationStageMode }> = [];
      const unknown: string[] = [];
      if (Array.isArray(arr)) {
        for (const s of arr.slice(0, 10)) {
          const name = String(s.bot ?? s.botId ?? "").trim();
          const bot = nameToBot.get(name);
          if (!bot) { if (name && !unknown.includes(name)) unknown.push(name); continue; }
          stages.push({ botId: bot.id, prompt: String(s.prompt ?? s.task ?? ""), mode: s.mode === "fan" ? "fan" : "seq" });
        }
      }
      if (unknown.length) throw new PlanParseError(`找不到 bot：${unknown.join("、")}。现有：${bots.map((b) => b.name).join("、")}`);
      if (stages.length) return stages;
    } catch (e) {
      if (e instanceof PlanParseError) throw e;
      /* 其它错误降级到规则解析 */
    }
  }
  // 2) 规则降级：按分隔符分段，匹配 bot 名
  const names = bots.map((b) => b.name).sort((a, b) => b.length - a.length);
  const segments = text
    .replace(/^(让|请|帮我|安排|编排|用)/, "")
    .split(/[，,。;；、\n]|→|->|然后/)
    .map((s) => s.trim())
    .filter(Boolean);
  const stages: Array<{ botId: string; prompt: string; mode?: OrchestrationStageMode }> = [];
  for (const seg of segments) {
    const bot = names.find((n) => seg.includes(n));
    if (!bot) continue;
    const nameToBotLocal = nameToBot.get(bot)!;
    const prompt = seg.replace(new RegExp(bot, "g"), "").replace(/^(给|让|请|叫|由)\s*/, "").trim() || `执行：${seg}`;
    stages.push({ botId: nameToBotLocal.id, prompt, mode: "seq" });
  }
  // 3) 兜底：整句给第一个 bot
  if (!stages.length && bots.length) {
    stages.push({ botId: bots[0].id, prompt: text, mode: "seq" });
  }
  return stages;
}
