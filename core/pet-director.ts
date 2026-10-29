/**
 * 一句话改宠物：支持多意图。
 * 规则可拆分的短句走快路径；复合/含糊句交给模型理解；失败再规则/chat 兜底。
 * 用户主动发起，不受 prefs.pet 自主开关限制。
 */
import { RECOMMENDED_PETDEX } from "./petdex";
import { expandPhraseToBeats, parseBeats, type PetBeat } from "./pet-script";

export type PetIntent =
  | { type: "setSkin"; skinId: string; label: string }
  | { type: "installPetdex"; slug: string; name: string }
  | { type: "generatePersona"; desc: string; style?: "default" | "pixel" | "cute" }
  | { type: "updatePersona"; persona: string }
  | { type: "setPace"; companionChat?: boolean; idleWork?: boolean; autoAppearance?: boolean; note: string }
  | { type: "remind"; delayMs: number; text: string }
  | { type: "revertSkin" }
  | { type: "evolveAccept" }
  | { type: "evolveReject" }
  | { type: "act"; action: "idle" | "walk" | "jump" | "sleep" | "celebrate" | "work" | "think"; holdSec?: number; note: string }
  | { type: "fx"; phrase: string }
  /** 娱乐节拍脚本（多拍动作/特效/台词）；不占用 bot 工作回合 */
  | { type: "script"; beats: PetBeat[]; note: string }
  | { type: "visit"; peerName: string }
  | { type: "chat"; text: string };

export interface PetDirectorContext {
  text: string;
  /** 已安装皮肤 id → name */
  skins: { id: string; name: string }[];
  /** 当前 skinId */
  skinId?: string;
  prevSkinId?: string;
  /** 可拜访的伙伴名（已上台或 petEnabled） */
  peers?: { id: string; name: string }[];
}

export const PET_ACTIONS = ["idle", "walk", "jump", "sleep", "celebrate", "work", "think"] as const;
export type PetActName = (typeof PET_ACTIONS)[number];

const GEN_RE = /^(?:生成|画|做)(?:一[个只条]|个)?(?:形象|外观|皮肤|头像)?[:：\s]*(.+)$/i;
const PERSONA_RE = /^(?:人设|性格|设定)(?:改成|换成|设为|为)?[:：\s]*(.+)$/;
const REMIND_RE = /^(?:提醒我|叫我|闹钟)(.+)$/;
const QUIET_RE = /安静|少说|话少|少讲话|少说话|别吵|闭嘴|不要主动|别搭话|安静一点/;
const LIVELY_RE = /活泼|多说|话多|主动一点|多搭话|热闹/;
const WORK_ON_RE = /(?:可以|允许|开启|打开).*(?:自己|空闲).*(?:做事|干活)|空闲做事/;
const WORK_OFF_RE = /(?:不要|别|关闭|关掉).*(?:自己|空闲).*(?:做事|干活)|别自己做事/;
const APPEAR_ON_RE = /(?:可以|允许|开启).*(?:自动换|自己换).*(?:形象|装|皮)/;
const APPEAR_OFF_RE = /(?:不要|别|关闭).*(?:自动换|自己换).*(?:形象|装|皮)/;
const REVERT_RE = /换回[去来]?|撤销换装|恢复上[一个]?形象|换回去/;
const EVOLVE_OK_RE = /^(好|可以|同意|接受|行|嗯|要|进化吧|就这样)([的啊呀哦吧！!。.]*)$/;
const EVOLVE_NO_RE = /^(不要|算了|拒绝|下次再说|先别)([的啊呀哦吧！!。.]*)$/;
const SWAP_RE = /^(?:换成|换上|换个|用|戴上|穿上)[:：\s]*(.+?)(?:吧|呀|啊|哦)?$/;
const ACT_RE = /^(?:来?|帮我?|给我?)?(跳一下|跳一跳|蹦一下|蹦蹦|庆祝一下|开心一下|挥挥手|挥手|睡一会儿|睡一下|睡觉|打个盹|走走|散个步|散步|思考一下|想想|工作一下|干会儿活)(?:吧|呀|啊|哦)?[!！.。]*$/;
const FX_RE = /^(?:放出|施展|来个|来一发|放个|整一个|表演一下|给我来个|帮我放)\s*(.+?)(?:吧|呀|啊|哦)?[!！.。]*$/;
const FX_BARE_RE = /^(龟派气功|气功波|冲击波|气场|比心|亮晶晶|星星闪)(?:！|!)?$/;
const VISIT_RE = /^(?:去找|拜访|串门找|去看|去找找)\s*(.+?)(?:玩|串门|一下|会儿)?(?:吧|呀|啊|哦)?[!！.。]*$/;
const CLAUSE_SPLIT = /\s*(?:[,，、；;]|然后|并且|同时|顺便|再|还要|另外)\s*/;

function parseAct(text: string): Extract<PetIntent, { type: "act" }> | null {
  const m = text.trim().match(ACT_RE);
  if (!m) return null;
  const phrase = m[1];
  if (/跳|蹦/.test(phrase)) return { type: "act", action: "jump", holdSec: 2, note: "好，跳一下～" };
  if (/庆祝|开心|挥/.test(phrase)) return { type: "act", action: "celebrate", holdSec: 3, note: "好嘞！" };
  if (/睡|盹/.test(phrase)) return { type: "act", action: "sleep", holdSec: 8, note: "那我眯一会儿…" };
  if (/走|散步/.test(phrase)) return { type: "act", action: "walk", holdSec: 4, note: "溜达一会儿～" };
  if (/思考|想/.test(phrase)) return { type: "act", action: "think", holdSec: 4, note: "让我想想…" };
  if (/工作|干活/.test(phrase)) return { type: "act", action: "work", holdSec: 5, note: "开工！" };
  return null;
}

function parseDelay(s: string): { delayMs: number; rest: string } | null {
  const m = s.match(/(?:过)?(\d+)\s*(秒|分钟|分|小时|钟头)(?:后)?(.+)?/);
  if (!m) {
    const half = s.match(/半\s*小时(?:后)?(.+)?/);
    if (half) return { delayMs: 30 * 60_000, rest: (half[1] || "").replace(/^[,，、\s]+/, "").trim() || "提醒" };
    return null;
  }
  const n = Number(m[1]);
  const unit = m[2];
  const mult = unit.startsWith("秒") ? 1000 : unit.startsWith("小时") || unit.startsWith("钟头") ? 3600_000 : 60_000;
  return { delayMs: n * mult, rest: (m[3] || "").replace(/^[,，、\s]+/, "").trim() || "提醒" };
}

function matchSkin(query: string, skins: { id: string; name: string }[]): { id: string; name: string } | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const exact = skins.find((s) => s.name.toLowerCase() === q || s.id.toLowerCase() === q);
  if (exact) return exact;
  const hit = skins.find((s) => s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q));
  return hit || null;
}

function matchPetdex(query: string): { slug: string; name: string } | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const exact = RECOMMENDED_PETDEX.find((r) => r.name.toLowerCase() === q || r.slug.toLowerCase() === q);
  if (exact) return { slug: exact.slug, name: exact.name };
  const hit = RECOMMENDED_PETDEX.find((r) => r.name.toLowerCase().includes(q) || r.slug.toLowerCase().includes(q) || r.group.toLowerCase().includes(q));
  return hit ? { slug: hit.slug, name: hit.name } : null;
}

/** 规则解析；无法识别返回 chat 兜底 */
export function parsePetIntent(ctx: PetDirectorContext): PetIntent {
  const text = ctx.text.trim();
  if (!text) return { type: "chat", text };

  if (REVERT_RE.test(text) && ctx.prevSkinId) return { type: "revertSkin" };
  if (EVOLVE_OK_RE.test(text)) return { type: "evolveAccept" };
  if (EVOLVE_NO_RE.test(text)) return { type: "evolveReject" };

  const act = parseAct(text);
  if (act) return act;

  const fx = text.match(FX_RE) || text.match(FX_BARE_RE);
  if (fx) {
    const phrase = (fx[1] || fx[0] || "").trim();
    if (phrase && phrase.length <= 40) {
      // 大招类短语优先展开为娱乐节拍脚本
      const beats = expandPhraseToBeats(phrase);
      if (beats && beats.length > 1) return { type: "script", beats, note: `好，来一段「${phrase.slice(0, 16)}」～` };
      return { type: "fx", phrase };
    }
  }

  const visit = text.match(VISIT_RE);
  if (visit?.[1] && ctx.peers?.length) {
    const q = visit[1].trim().replace(/[的地得]$/, "");
    const peer = ctx.peers.find((p) => p.name === q || p.name.includes(q) || q.includes(p.name));
    if (peer) return { type: "visit", peerName: peer.name };
  }

  const pace: PetIntent | null = (() => {
    if (QUIET_RE.test(text)) return { type: "setPace", companionChat: false, note: "好，我会安静一点，有事再叫我。" };
    if (LIVELY_RE.test(text)) return { type: "setPace", companionChat: true, note: "好，空闲时我会多跟你说说话。" };
    if (WORK_OFF_RE.test(text)) return { type: "setPace", idleWork: false, note: "好，我不会自己找事做了。" };
    if (WORK_ON_RE.test(text)) return { type: "setPace", idleWork: true, note: "好，空闲时我会自己找一件小事做，做完告诉你。" };
    if (APPEAR_OFF_RE.test(text)) return { type: "setPace", autoAppearance: false, note: "好，不会再自动换装了。" };
    if (APPEAR_ON_RE.test(text)) return { type: "setPace", autoAppearance: true, note: "好，偶尔我可以自己换个形象，不喜欢就说换回去。" };
    return null;
  })();
  if (pace) return pace;

  const remindHead = text.match(REMIND_RE);
  if (remindHead) {
    const d = parseDelay(remindHead[1].trim()) || parseDelay(text);
    if (d) return { type: "remind", delayMs: d.delayMs, text: d.rest || remindHead[1].trim() };
  }
  const delayAnywhere = parseDelay(text);
  if (delayAnywhere && /提醒|叫我|闹钟/.test(text)) {
    return { type: "remind", delayMs: delayAnywhere.delayMs, text: delayAnywhere.rest };
  }

  const gen = text.match(GEN_RE);
  if (gen?.[1]?.trim()) {
    const desc = gen[1].trim();
    const style = /像素/.test(text) ? "pixel" as const : /可爱|圆润/.test(text) ? "cute" as const : "default" as const;
    return { type: "generatePersona", desc, style };
  }

  const persona = text.match(PERSONA_RE);
  if (persona?.[1]?.trim()) return { type: "updatePersona", persona: persona[1].trim() };

  const swap = text.match(SWAP_RE);
  if (swap?.[1]) {
    const q = swap[1].trim();
    const skin = matchSkin(q, ctx.skins);
    if (skin) return { type: "setSkin", skinId: skin.id, label: skin.name };
    const pd = matchPetdex(q);
    if (pd) return { type: "installPetdex", slug: pd.slug, name: pd.name };
  }

  // 「Doro 卫衣」这类短句：整句像在点名形象
  if (text.length <= 24 && !/[?？]/.test(text)) {
    const skin = matchSkin(text, ctx.skins);
    if (skin && skin.id !== ctx.skinId) return { type: "setSkin", skinId: skin.id, label: skin.name };
    const pd = matchPetdex(text);
    if (pd) return { type: "installPetdex", slug: pd.slug, name: pd.name };
  }

  return { type: "chat", text };
}

/** 按标点/连词拆成子句 */
export function splitDesignClauses(text: string): string[] {
  const parts = text.trim().split(CLAUSE_SPLIT).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : [text.trim()].filter(Boolean);
}

/**
 * 规则多意图：子句都能解析且非 chat 才算成功。
 * 「换成咕嘎，话少一点」→ [setSkin/install, setPace]
 */
export function parsePetIntentsRule(ctx: PetDirectorContext): PetIntent[] | null {
  const clauses = splitDesignClauses(ctx.text);
  if (clauses.length <= 1) {
    const one = parsePetIntent(ctx);
    return one.type === "chat" ? null : [one];
  }
  const out: PetIntent[] = [];
  for (const c of clauses) {
    const i = parsePetIntent({ ...ctx, text: c });
    if (i.type === "chat") return null;
    out.push(i);
  }
  return out.length ? out : null;
}

/** 是否值得叫模型（复合句 / 规则吃不下） */
export function shouldUseDirectorModel(text: string, ruleIntents: PetIntent[] | null): boolean {
  if (ruleIntents && ruleIntents.length >= 1) return false;
  const t = text.trim();
  if (!t) return false;
  // 明显闲聊长问句交给 chat，不硬解设计意图
  if (t.length > 80 && /[?？]/.test(t)) return false;
  if (splitDesignClauses(t).length > 1) return true;
  // 单句规则失败，但像在下指令
  if (/换|安静|话少|话多|提醒|放出|跳|睡|生成|人设|拜访|串门|钉住|活泼/.test(t)) return true;
  return t.length <= 40 && !/[?？]/.test(t);
}

export function directorSystemPrompt(ctx: PetDirectorContext): string {
  const skins = ctx.skins.slice(0, 24).map((s) => s.name).join("、") || "（无）";
  const peers = (ctx.peers || []).map((p) => p.name).join("、") || "（无）";
  return [
    "你是桌宠「一句话设计」意图解析器。把用户话拆成 1～5 条可执行意图，只输出 JSON 数组，不要 markdown。",
    "可用 type：",
    '- setSkin / installPetdex：换形象，用 {"type":"setSkin","query":"形象名"}（已装用 setSkin，社区库用 installPetdex；不确定也写 setSkin+query）',
    '- setPace：节奏 {"type":"setPace","companionChat":true|false} 或 idleWork / autoAppearance',
    '- generatePersona：{"type":"generatePersona","desc":"...","style":"default|pixel|cute"}',
    '- updatePersona：{"type":"updatePersona","persona":"..."}',
    '- remind：{"type":"remind","delayMs":number,"text":"..."}',
    '- act：{"type":"act","action":"idle|walk|jump|sleep|celebrate|work|think"}',
    '- fx：{"type":"fx","phrase":"特效名"}',
    '- script：娱乐连招 {"type":"script","beats":[{"type":"action"|"fx"|"say"|"wait",...}]} 最多 6 拍；大招/表演优先用 script',
    '- visit：{"type":"visit","peerName":"伙伴名"}',
    '- revertSkin / evolveAccept / evolveReject',
    '- chat：只有整句都不是桌宠指令时才用',
    "桌宠是娱乐层：script/act/fx 不代替真正干活，不要把工作任务做成桌宠表演。",
    `已装形象：${skins}`,
    `可拜访伙伴：${peers}`,
    "一句可含多条（如「换成咕嘎，话少一点」→ 换皮 + companionChat:false）。不要编造不存在的形象名。",
  ].join("\n");
}

export function directorUserPrompt(text: string): string {
  return `用户说：${text.trim().slice(0, 120)}\n只输出 JSON 数组。`;
}

/** 把模型 JSON 收成 PetIntent[]；失败返回 null */
export function parseDirectorIntents(raw: string, ctx: PetDirectorContext): PetIntent[] | null {
  const m = (raw || "").trim().match(/\[[\s\S]*\]/);
  if (!m) return null;
  let arr: unknown[];
  try {
    arr = JSON.parse(m[0]) as unknown[];
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || !arr.length) return null;
  const out: PetIntent[] = [];
  for (const item of arr.slice(0, 5)) {
    if (!item || typeof item !== "object") continue;
    const j = item as Record<string, unknown>;
    const type = String(j.type || "");
    const hydrated = hydrateDraft(type, j, ctx);
    if (hydrated) out.push(hydrated);
  }
  return out.length ? out : null;
}

function hydrateDraft(type: string, j: Record<string, unknown>, ctx: PetDirectorContext): PetIntent | null {
  if (type === "setSkin" || type === "installPetdex") {
    const q = String(j.query ?? j.name ?? j.skin ?? "").trim();
    if (!q) return null;
    const skin = matchSkin(q, ctx.skins);
    if (skin) return { type: "setSkin", skinId: skin.id, label: skin.name };
    const pd = matchPetdex(q);
    if (pd) return { type: "installPetdex", slug: pd.slug, name: pd.name };
    return null;
  }
  if (type === "setPace") {
    const note =
      j.companionChat === false ? "好，我会少说话。"
      : j.companionChat === true ? "好，空闲时我会多说一点。"
      : j.idleWork === false ? "好，我不会自己找事做了。"
      : j.idleWork === true ? "好，空闲时我会自己找小事做。"
      : j.autoAppearance === false ? "好，不会自动换装了。"
      : j.autoAppearance === true ? "好，偶尔可以自己换形象。"
      : "好，已更新节奏。";
    return {
      type: "setPace",
      companionChat: typeof j.companionChat === "boolean" ? j.companionChat : undefined,
      idleWork: typeof j.idleWork === "boolean" ? j.idleWork : undefined,
      autoAppearance: typeof j.autoAppearance === "boolean" ? j.autoAppearance : undefined,
      note,
    };
  }
  if (type === "generatePersona") {
    const desc = String(j.desc ?? j.description ?? "").trim();
    if (!desc) return null;
    const style = j.style === "pixel" || j.style === "cute" ? j.style : "default";
    return { type: "generatePersona", desc, style };
  }
  if (type === "updatePersona") {
    const persona = String(j.persona ?? "").trim();
    return persona ? { type: "updatePersona", persona } : null;
  }
  if (type === "remind") {
    const delayMs = Number(j.delayMs) || 0;
    const text = String(j.text ?? "提醒").trim();
    return delayMs >= 5000 ? { type: "remind", delayMs, text } : null;
  }
  if (type === "act") {
    const action = String(j.action || "").toLowerCase() as PetActName;
    if (!PET_ACTIONS.includes(action)) return null;
    return { type: "act", action, holdSec: Number(j.holdSec) || 2, note: `好，${action}。` };
  }
  if (type === "fx") {
    const phrase = String(j.phrase ?? j.name ?? "").trim();
    return phrase ? { type: "fx", phrase } : null;
  }
  if (type === "script") {
    const beats = parseBeats(j.beats);
    if (!beats?.length) return null;
    return { type: "script", beats, note: String(j.note || "好，开演～").slice(0, 40) };
  }
  if (type === "visit") {
    const peerName = String(j.peerName ?? j.name ?? "").trim();
    return peerName ? { type: "visit", peerName } : null;
  }
  if (type === "revertSkin") return { type: "revertSkin" };
  if (type === "evolveAccept") return { type: "evolveAccept" };
  if (type === "evolveReject") return { type: "evolveReject" };
  if (type === "chat") return { type: "chat", text: String(j.text ?? ctx.text) };
  return null;
}
