/**
 * 评测模式：electron . --run-evals
 * 在真实数据的临时副本上跑一组固定场景（真实模型、真实工具链路），报告写到 <数据目录>/evals/ 后退出。
 * 不开窗口、不占单实例锁，正在用的应用照常运行，你的会话和记忆不受影响。
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultScenarios, memoryScenarios, judgePrompt, parseJudge, reportMarkdown, runEvals } from "../../core/evals";
import { SkillRegistry } from "../../core/skill-registry";
import { MemorySystem } from "../../core/memory-system";
import type { ConsentCenter, ConsentDecision } from "../../core/consent-center";
import type { Store } from "../../core/store";
import type { GroupRegistry } from "../../core/group-registry";
import type { ProviderCenter } from "../../core/provider-center";
import type { BotRuntime } from "../../core/bot-runtime";

export const EVAL_MODE = process.argv.includes("--run-evals");

/** 把真实数据复制到临时目录，之后整个进程都用这份副本 */
export function prepareEvalHome(realHome: string, setUserData: (dir: string) => void) {
  const tmp = mkdtempSync(join(tmpdir(), "harness-eval-"));
  for (const name of readdirSync(realHome)) {
    const isData = (name.endsWith(".json") && !name.includes(".bak")) || ["memory", "skills", "sessions", "vectors", "attachments"].includes(name);
    if (isData) cpSync(join(realHome, name), join(tmp, name), { recursive: true, filter: (src) => !/\.(bak|corrupt)/.test(src) });
  }
  process.env.HARNESS_EVAL_OUT = join(realHome, "evals");
  process.env.HARNESS_EVAL_TMP = tmp;
  process.env.HARNESS_HOME = tmp;
  setUserData(join(tmp, "userdata"));
}

export async function runEvalMode(deps: {
  home: string;
  store: Store;
  groups: GroupRegistry;
  providers: ProviderCenter;
  runtime: BotRuntime;
  consent: ConsentCenter;
  exit: (code: number) => void;
}) {
  const { home, store, groups, providers, runtime, consent } = deps;
  // 规范与记忆评测：模拟用户在确认卡片上点「确认」（改共享技能要用户批准）；其他评测一律拒绝
  consent.decider = async (): Promise<ConsentDecision> => (process.env.HARNESS_EVAL_SUITE === "memory" ? "allow-once" : "deny");
  const bots = store.listBots();
  const master = bots.find((b) => b.isMaster) ?? bots[0];
  const nameOf = (id: string) => store.getBot(id)?.name ?? id;
  const facts = { bots: bots.map((b) => b.name), master: master.name, groups: groups.list().map((g) => ({ name: g.name, members: g.members.map(nameOf) })) };
  let scenarios = process.env.HARNESS_EVAL_SUITE === "memory"
    ? memoryScenarios(facts, {
      skills: () => new SkillRegistry(join(home, "skills")).list().map((s) => ({ key: s.key, name: s.name, enabled: s.enabled, body: s.body })),
      memories: (ns) => new MemorySystem(home).list(ns).map((e) => ({ kind: e.kind, content: e.content })),
      botId: (name) => store.listBots().find((b) => b.name === name)?.id ?? name,
    })
    : defaultScenarios(facts);
  const only = process.env.HARNESS_EVAL_ONLY?.split(",").map((x) => x.trim()).filter(Boolean);
  if (only?.length) scenarios = scenarios.filter((x) => only.includes(x.id));
  const provider = providers.get(master.providerId) || providers.getDefault();
  if (!provider) { console.error("[eval] 没有可用模型"); deps.exit(1); return; }
  const model = (master.providerId === provider.id && master.model) || provider.model || provider.name;
  console.log(`[eval] 开始：${scenarios.length} 个场景，${master.name} · ${model}`);
  const runAt = Date.now();
  const report = await runEvals(scenarios, async (prompt, o) => {
    const t0 = Date.now();
    const bot = (o.bot && store.listBots().find((b) => b.name === o.bot)) || master;
    const sessionId = `eval-${o.sessionKey}-${bot.id.slice(0, 6)}-${runAt}`;
    const r = await runtime.handleStream(
      { bot, from: "user", text: prompt, sessionId, history: store.listMessages(sessionId) },
      { onBlock: () => {}, signal: AbortSignal.timeout(180_000) },
    );
    const meta = store.listMessages(sessionId).at(-1)?.meta;
    return { text: r.text, toolCalls: r.toolCalls, latencyMs: Date.now() - t0, tokens: meta?.tokensUsed, cached: meta?.usage?.cached };
  }, {
    model,
    judge: async (rubric, sc, r) => {
      const jp = judgePrompt(rubric, sc, r);
      const out = await providers.complete(provider, { system: jp.system, user: jp.user, temperature: 0, signal: AbortSignal.timeout(60_000) });
      return parseJudge(out.text);
    },
    onProgress: (x) => console.log(`[eval] ${x.pass ? "✅" : "❌"} ${x.title}${x.error ? ` 出错：${x.error}` : ""}${x.checks.filter((c) => !c.pass).map((c) => ` ✗${c.label}${c.detail ? `（${c.detail}）` : ""}`).join("")}`),
  });
  const out = process.env.HARNESS_EVAL_OUT!;
  mkdirSync(out, { recursive: true });
  const stamp = report.at.replace(/[:.]/g, "-");
  writeFileSync(join(out, `eval-${stamp}.json`), JSON.stringify(report, null, 2));
  writeFileSync(join(out, `eval-${stamp}.md`), reportMarkdown(report));
  console.log(`[eval] 完成：通过 ${report.passed}/${report.total}，报告 ${join(out, `eval-${stamp}.md`)}`);
  try { rmSync(process.env.HARNESS_EVAL_TMP!, { recursive: true, force: true }); } catch { /* 临时目录清不掉不影响 */ }
  deps.exit(0);
}
