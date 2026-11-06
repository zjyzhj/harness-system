/**
 * 从回复正文识别「给用户选项」的形态。
 * - hard：逼用户拍板 → 应打回 ui.ask
 * - soft：建议/方案列表 → 提成可点软芯片（不阻断）
 * - null：说明性列表或无关
 */

export type ChoiceOffer =
  | { kind: "hard"; question: string; options: string[] }
  | { kind: "soft"; options: string[] };

const HARD_ASK = /(?:请?(?:你)?选(?:一个|哪个|哪条|哪一)|要哪(?:个|条)|你来定|你定一下|让我选|请选择|二选一|三选一|选一条路|走哪条|哪个方案|哪套)/;
const SOFT_HINT = /(?:建议|方案|可以|不妨|也可以|下一步|几种(?:做法|办法|方案)|可选|或者先|你也可以)/;
/** 纯说明，没有「让你选」语义时不算出卡 */
const EXPLAIN_ONLY = /^(?:首先|其次|再次|最后|第一|第二|第三|综上|总之|另外|此外|说明|注意|例如|比如)/;

const ENUM_LINE =
  /^\s*(?:(?:\d{1,2}|[A-Da-d]|[一二三四五六七八])[.、:：\)）]\s+|\([0-9A-Da-d]\)\s+|[-•*]\s+)(.+?)\s*$/;

function stripFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "").trim();
}

function cleanOption(raw: string): string {
  let s = raw
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // 「标题——说明」/「标题：说明」只取短标题，方便做芯片
  const cut = s.split(/(?:——+|—|：|:)/)[0]?.trim() ?? s;
  if (cut.length >= 2 && cut.length <= 28) s = cut;
  return s.replace(/[。！？!?；;]+$/g, "").trim();
}

/** 抽出连续枚举行；至少 2 条、每条不太长（芯片/选项卡用） */
export function extractEnumOptions(text: string): string[] {
  const lines = stripFences(text).split(/\n+/);
  const found: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length >= 2) found.push(...run);
    run = [];
  };
  for (const line of lines) {
    const m = line.match(ENUM_LINE);
    if (!m) {
      flush();
      continue;
    }
    const opt = cleanOption(m[1] ?? "");
    // 芯片/选项要短；带句读的长句多半是步骤说明不是可点选项
    if (!opt || opt.length > 28 || EXPLAIN_ONLY.test(opt) || /[。，；;,.]/.test(opt)) {
      flush();
      continue;
    }
    run.push(opt);
  }
  flush();
  // 去重保序，最多 4 条（软芯片）/ 硬卡后面再 slice
  const out: string[] = [];
  for (const o of found) {
    if (!out.some((x) => x === o || x.includes(o) || o.includes(x))) out.push(o);
  }
  return out.slice(0, 6);
}

function inferQuestion(text: string, options: string[]): string {
  const plain = stripFences(text);
  const hit = plain.match(/[^\n。！？!?]{0,40}(?:选(?:一个|哪个|哪条)|要哪|请选择|哪个方案|走哪条)[^\n。！？!?]{0,20}/);
  if (hit) return cleanOption(hit[0]).slice(0, 40) || "你想怎么做？";
  if (options.length >= 2) return "你想选哪一个？";
  return "你想怎么做？";
}

/**
 * 识别回复是否在给用户选项。
 * hard：带明确点选话术；soft：有建议/方案味的枚举且无硬点选。
 */
export function detectChoiceOffer(text: string): ChoiceOffer | null {
  const body = stripFences(text);
  if (body.length < 8) return null;
  const options = extractEnumOptions(body);
  if (options.length < 2) return null;

  const hard = HARD_ASK.test(body);
  const soft = SOFT_HINT.test(body);
  if (hard) {
    return { kind: "hard", question: inferQuestion(body, options), options: options.slice(0, 6) };
  }
  if (soft) {
    return { kind: "soft", options: options.slice(0, 4) };
  }
  // 仅有 A/B/C 或 1/2/3、且前文短问句收尾（「呢？」「吗？」）也视为 soft
  if (/[吗呢？?]\s*$/m.test(body.slice(0, 200)) || /(?:还是|或者)/.test(body)) {
    return { kind: "soft", options: options.slice(0, 4) };
  }
  // 正文几乎全是短枚举（无引导句）→ soft，避免「1/2/3 短标题」落到追问模型另造一句
  // 「今天做了三件事」这类回顾不算
  const lines = body.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const enumLines = lines.filter((l) => ENUM_LINE.test(l));
  const otherText = lines.filter((l) => !ENUM_LINE.test(l)).join("").replace(/[\s\p{Extended_Pictographic}]/gu, "");
  if (enumLines.length >= 2 && otherText.length === 0) {
    return { kind: "soft", options: options.slice(0, 4) };
  }
  return null;
}
