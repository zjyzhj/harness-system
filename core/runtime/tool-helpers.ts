// 内置工具的纯实现：定时任务、file.send、ui.*
import type { Bot, ContentBlock } from "../types";
import type { Scheduler } from "../scheduler";
import type { SecretStore } from "../secret-store";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
import type { ToolOutcome } from "./types";
import { formatNow } from "./turn-helpers";

/** 解析一次性任务时间：in 分钟数 / "HH:mm"（今天已过则明天）/ 任意 Date 可解析字符串 */
/** 「5」「5m」「5分钟」「1h30m」「90s」「2小时」→ 分钟数；纯数字按分钟 */
export function parseDurationMinutes(v: unknown): number | null {
  if (typeof v === "number") return v > 0 ? v : null;
  const s = String(v ?? "").trim().toLowerCase().replace(/\s+/g, "");
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) > 0 ? Number(s) : null;
  const unit: Record<string, number> = { d: 1440, 天: 1440, h: 60, hr: 60, 小时: 60, 个小时: 60, m: 1, min: 1, 分: 1, 分钟: 1, s: 1 / 60, sec: 1 / 60, 秒: 1 / 60 };
  let total = 0;
  let rest = s;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(个小时|小时|分钟|min|sec|hr|天|分|秒|d|h|m|s)/g)) {
    total += Number(m[1]) * unit[m[2]];
    rest = rest.replace(m[0], "");
  }
  return total > 0 && !rest ? total : null;
}

export function parseRunAt(args: Record<string, unknown>, now = Date.now()): number | null {
  const mins = parseDurationMinutes(args.in ?? args.minutes);
  if (mins) return now + mins * 60_000;
  const at = args.at ?? args.time;
  if (at === undefined || at === null || at === "") return null;
  if (typeof at === "number") return at > 1e12 ? at : null;
  const s = String(at).trim();
  const hm = s.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const d = new Date(now);
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const ts = Date.parse(s.replace(" ", "T"));
  return Number.isFinite(ts) ? ts : null;
}

export function runTaskTool(tasks: Pick<Scheduler, "create" | "listForBot" | "delete">, bot: Bot, tool: string, args: Record<string, unknown>, sessionId?: string): string {
  const fmt = (ts?: number) => (ts ? formatNow(new Date(ts)) : "—");
  if (tool === "task.list") {
    const list = tasks.listForBot(bot.id);
    return list.length
      ? list.map((x) => `- ${x.name}（id=${x.id.slice(0, 8)}，${x.kind === "once" ? "一次性" : x.cron}，${x.enabled ? "启用" : "停用"}，下次 ${fmt(x.nextRunAt)}）`).join("\n")
      : "（没有定时任务）";
  }
  if (tool === "task.delete") {
    const key = String(args.id ?? args.name ?? "").trim();
    if (!key) return "task.delete 需要 id 或 name";
    const list = tasks.listForBot(bot.id);
    const exact = list.filter((x) => x.id === key || x.name === key);
    if (exact.length === 1) {
      tasks.delete(exact[0].id);
      return `已删除任务「${exact[0].name}」`;
    }
    if (exact.length > 1) {
      return `有 ${exact.length} 个叫「${key}」的任务，请用 id 指定：\n${exact.map((x) => `- ${x.name}（id=${x.id.slice(0, 8)}）`).join("\n")}`;
    }
    // 短前缀太容易误伤；task.list 展示的是 8 位前缀
    if (key.length >= 8) {
      const prefix = list.filter((x) => x.id.startsWith(key));
      if (prefix.length === 1) {
        tasks.delete(prefix[0].id);
        return `已删除任务「${prefix[0].name}」`;
      }
      if (prefix.length > 1) {
        return `id 前缀「${key}」匹配到 ${prefix.length} 个任务，请写更长一点：\n${prefix.map((x) => `- ${x.name}（id=${x.id.slice(0, 8)}）`).join("\n")}`;
      }
    }
    return `找不到任务「${key}」`;
  }
  const name = String(args.name ?? args.title ?? "定时任务");
  const prompt = String(args.prompt ?? args.task ?? name);
  const runAt = parseRunAt(args);
  if (runAt) {
    // runPrompt 默认 true；notifyPet 默认 true。纯气泡闹钟：runPrompt:false
    const runPrompt = !(args.runPrompt === false || args.runPrompt === "false" || args.alarmOnly === true);
    const notifyPet = !(args.notifyPet === false || args.notifyPet === "false");
    const t = tasks.create({
      botId: bot.id, name, prompt, cron: "* * * * *", kind: "once", alarmAt: runAt,
      notifyPet, runPrompt, deleteAfterRun: args.keep !== true, sessionId,
    });
    const mode = runPrompt ? "到点执行" : "到点仅宠物提醒";
    return `已创建一次性任务「${t.name}」，将在 ${fmt(t.nextRunAt)} ${mode}${t.deleteAfterRun ? "，执行后自动删除" : ""}`;
  }
  const cron = String(args.cron ?? "");
  if (!cron) return "task.create 需要 cron（周期任务）或 at / in（一次性任务）";
  try {
    const t = tasks.create({ botId: bot.id, name, prompt, cron, sessionId });
    return `已创建周期任务「${t.name}」（${cron}），下次 ${fmt(t.nextRunAt)}`;
  } catch (e) {
    return `创建失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

export const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".bmp", ".svg"]);
export const MAX_SEND = 40;

/** file.send：把本机文件/目录作为图片或文件卡片附到本轮回复里交给用户 */
export const SENSITIVE_PATH = [
  /\/\.(ssh|aws|gnupg|kube|azure|docker)(\/|$)/, /\/Library\/Keychains(\/|$)/, /\/\.config\/(gh|gcloud)(\/|$)/,
  /\/Library\/Application Support\/harness-bot\/(?!workspace(\/|$))/, /(^|\/)\.env(\.[\w-]+)?$/, /(^|\/)\.(netrc|npmrc|pypirc)$/,
  /\.(pem|key|p12|pfx|keystore|jks|mobileprovision)$/i, /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
];

export function isSensitivePath(p: string): boolean {
  let real = p;
  try { real = realpathSync(p); } catch {}
  return SENSITIVE_PATH.some((re) => re.test(p) || re.test(real));
}

export function sendFiles(args: Record<string, unknown>, allowSensitive = false): { output: string; blocks?: ContentBlock[]; sensitive?: string[] } {
  const raw = args.paths ?? args.path ?? args.files ?? args.file;
  const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((x) => String(x).trim()).filter(Boolean);
  if (!list.length) return { output: "file.send 需要 path（文件或目录）或 paths（数组）" };
  const resolve = (p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);
  const files: string[] = [];
  const missing: string[] = [];
  for (const item of list) {
    const p = resolve(item);
    if (!isAbsolute(p) || !existsSync(p)) { missing.push(item); continue; }
    if (statSync(p).isDirectory()) {
      readdirSync(p).filter((n) => !n.startsWith(".")).sort().map((n) => join(p, n)).filter((f) => statSync(f).isFile()).forEach((f) => files.push(f));
    } else files.push(p);
  }
  const picked = files.slice(0, MAX_SEND);
  const sensitive = allowSensitive ? [] : picked.filter(isSensitivePath);
  if (sensitive.length) return { output: "", sensitive };
  const blocks: ContentBlock[] = picked.map((f) => IMAGE_EXT.has(extname(f).toLowerCase())
    ? { type: "image", path: f, alt: basename(f) }
    : { type: "file", path: f, name: basename(f), size: statSync(f).size });
  const notes = [
    blocks.length ? `已把 ${blocks.length} 个文件附在回复里展示给用户` : "没有可发送的文件",
    files.length > MAX_SEND ? `（共 ${files.length} 个，只附了前 ${MAX_SEND} 个）` : "",
    missing.length ? `；找不到或不是绝对路径：${missing.join("、")}` : "",
  ];
  return { output: notes.join(""), blocks: blocks.length ? blocks : undefined };
}

/** 模型有时把选项写成 {label, description} 之类的对象 */
export function optionText(o: unknown): string {
  if (o && typeof o === "object") {
    const r = o as Record<string, unknown>;
    const main = [r.label, r.text, r.title, r.name, r.option, r.value].find((v) => typeof v === "string" && v.trim()) as string | undefined;
    const desc = [r.description, r.desc, r.detail].find((v) => typeof v === "string" && v.trim()) as string | undefined;
    if (main) return (desc && !main.includes(desc) ? `${main}：${desc}` : main).trim();
    return Object.values(r).filter((v) => typeof v === "string" && v.trim()).join("：").trim();
  }
  return String(o ?? "").trim();
}

/** ui.ask / ui.confirm / ui.secret：生成可交互卡片，本轮结束等用户操作 */
export function uiTool(tool: string, args: Record<string, unknown>, secrets?: SecretStore, botId?: string): ToolOutcome {
  const id = `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  if (tool === "ui.ask") {
    const question = String(args.question ?? args.title ?? "").trim();
    const options = (Array.isArray(args.options) ? args.options : []).map(optionText).filter(Boolean).slice(0, 8);
    if (!question || options.length < 2) return { output: "ui.ask 需要 question 和至少 2 个 options" };
    return { output: "已把选项展示给用户，等待用户选择（本轮结束）", blocks: [{ type: "choice", id, question, options, mode: "choice" }], halt: true };
  }
  if (tool === "ui.confirm") {
    const question = String(args.action ?? args.question ?? "").trim();
    if (!question) return { output: "ui.confirm 需要 action（要执行的操作）" };
    const detail = args.detail ? String(args.detail) : undefined;
    return { output: "已请求用户确认，等待用户答复（本轮结束）", blocks: [{ type: "choice", id, question, detail, options: ["确认", "修改", "取消"], mode: "confirm" }], halt: true };
  }
  if (tool === "ui.secret") {
    const name = String(args.name ?? "").trim().replace(/[^\w.\-]/g, "_");
    if (!name) return { output: "ui.secret 需要 name（英文标识，如 FEISHU_APP_SECRET）" };
    if (botId && secrets?.ownedByOther(name, botId)) return { output: `密钥名 ${name} 已被另一个 bot 私用，换一个名字（如 ${name}_2）` };
    if (secrets?.has(name) && args.overwrite !== true) return { output: `密钥 ${name} 已保存过，bash.run 里写 $${name}、其它工具参数里写 {{secret:${name}}} 直接用；要换新值传 overwrite:true` };
    const note = args.note ? String(args.note).slice(0, 200) : undefined;
    const shared = args.scope === "all" || args.scope === "global";
    return { output: "已向用户展示加密输入框，等待用户填写（本轮结束）", blocks: [{ type: "secret", name, label: String(args.label ?? name), ...(note ? { note } : {}), ...(shared ? { scope: "all" as const } : {}) }], halt: true };
  }
  return { output: `未知工具 ${tool}` };
}

/** 自己发过的交互卡片在历史里还原成工具块，模型看到的是「我调用了 ui.*」而不是一段可模仿的文字 */
export function ownHistoryText(blocks: ContentBlock[]): string {
  return blocks.map((b) => {
    if (b.type === "text") return b.text;
    if (b.type === "choice") {
      const call = b.mode === "confirm"
        ? { tool: "ui.confirm", args: { action: b.question, ...(b.detail ? { detail: b.detail } : {}) } }
        : { tool: "ui.ask", args: { question: b.question, options: b.options } };
      return "```tool\n" + JSON.stringify(call) + "\n```" + (b.answer ? `\n（用户选择了：${b.answer}）` : "\n（等待用户选择）");
    }
    if (b.type === "secret") return "```tool\n" + JSON.stringify({ tool: "ui.secret", args: { name: b.name, label: b.label } }) + "\n```" + (b.saved ? `\n（用户已保存，可用 {{secret:${b.name}}} 引用）` : "");
    return "";
  }).filter(Boolean).join("\n");
}
