/**
 * 分享依赖清单：从私有技能 / Vault 元数据静态抽取，导入后 diff 本机缺口。
 * 只带名单与说明，绝不带密钥或 env 值。
 */
import type { BotNeeds, NeedEnv, NeedSecret, NeedSharedSkill } from "./types";

const SECRET_RE = /\{\{\s*secret\s*:\s*([A-Za-z_][\w]*)\s*\}\}/gi;
/** bash / 技能里常见的 $NAME / ${NAME}（至少 3 字符大写风格，避免 $1 $i） */
const ENV_RE = /\$\{?([A-Z][A-Z0-9_]{2,})\}?/g;
const MCP_RE = /\bmcp:([A-Za-z0-9_-]+)/gi;
const SKILL_LINK_RE = /app:skill\/([A-Za-z0-9_-]+)/gi;

export interface SkillLike {
  name: string;
  description: string;
  body: string;
  key?: string;
  requires?: string[];
}

export interface VaultMeta {
  secrets?: { name: string; label?: string; note?: string }[];
  env?: { key: string; label?: string; note?: string }[];
  mcp?: { id?: string; name: string }[];
}

export interface LocalReady {
  secretNames?: Iterable<string>;
  envKeys?: Iterable<string>;
  commands?: Iterable<string>;
  mcpNames?: Iterable<string>;
  /** 本机技能名或 key */
  skills?: Iterable<string>;
}

export interface NeedsDiff {
  missing: BotNeeds;
  present: BotNeeds;
}

export function emptyNeeds(): BotNeeds {
  return { secrets: [], env: [] };
}

export function hasNeeds(n?: BotNeeds | null): boolean {
  if (!n) return false;
  return !!(
    n.secrets?.length ||
    n.env?.length ||
    n.commands?.length ||
    n.mcp?.length ||
    n.sharedSkills?.length
  );
}

/** 硬缺口：密钥 / 环境（开箱必须补）；命令 / MCP / 共享技能为软提示 */
export function hasHardGaps(diff: NeedsDiff): boolean {
  return !!(diff.missing.secrets.length || diff.missing.env.length);
}

export function hasAnyGaps(diff: NeedsDiff): boolean {
  return hasNeeds(diff.missing);
}

function uniqBy<T>(items: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of items) {
    const k = key(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function setOf(iter?: Iterable<string>): Set<string> {
  return new Set([...(iter ?? [])].map((x) => x.trim()).filter(Boolean));
}

/** 从技能正文 / requires 抽出引用 */
export function extractFromSkills(skills: SkillLike[]): {
  secretNames: string[];
  envKeys: string[];
  commands: string[];
  mcpIds: string[];
  skillRefs: string[];
} {
  const secretNames: string[] = [];
  const envKeys: string[] = [];
  const commands: string[] = [];
  const mcpIds: string[] = [];
  const skillRefs: string[] = [];
  for (const sk of skills) {
    const text = `${sk.description}\n${sk.body}`;
    for (const m of text.matchAll(SECRET_RE)) secretNames.push(m[1]);
    for (const m of text.matchAll(ENV_RE)) {
      const k = m[1];
      // 已作为 secret 引用的不再当 env
      if (!secretNames.includes(k)) envKeys.push(k);
    }
    for (const m of text.matchAll(MCP_RE)) mcpIds.push(m[1]);
    for (const m of text.matchAll(SKILL_LINK_RE)) skillRefs.push(m[1]);
    if (sk.requires?.length) commands.push(...sk.requires);
  }
  return {
    secretNames: [...new Set(secretNames)],
    envKeys: [...new Set(envKeys)],
    commands: [...new Set(commands.map((c) => c.trim()).filter(Boolean))],
    mcpIds: [...new Set(mcpIds)],
    skillRefs: [...new Set(skillRefs)],
  };
}

/**
 * 组装分享用 needs：技能抽取 + Vault 元数据 enrichment + 私有 env/secret 名单。
 * shared：本机共享技能（仅 name/description），按正文引用或 always 提示。
 */
export function collectNeeds(opts: {
  privateSkills: SkillLike[];
  sharedSkills?: SkillLike[];
  vault?: VaultMeta;
  /** 该 bot 私有的 secret / env（即使技能未引用也带上） */
  ownedSecrets?: { name: string; label?: string; note?: string }[];
  ownedEnv?: { key: string; label?: string; note?: string }[];
}): BotNeeds {
  const extracted = extractFromSkills(opts.privateSkills);
  const vaultSecrets = opts.vault?.secrets ?? [];
  const vaultEnv = opts.vault?.env ?? [];
  const bySecret = new Map(vaultSecrets.map((s) => [s.name, s]));
  const byEnv = new Map(vaultEnv.map((e) => [e.key, e]));

  const secrets: NeedSecret[] = [];
  for (const name of extracted.secretNames) {
    const meta = bySecret.get(name);
    secrets.push({ name, label: meta?.label, note: meta?.note });
  }
  for (const s of opts.ownedSecrets ?? []) {
    if (!secrets.some((x) => x.name === s.name)) secrets.push({ name: s.name, label: s.label, note: s.note });
  }

  const env: NeedEnv[] = [];
  for (const key of extracted.envKeys) {
    // 若同名已在 secrets，不当 env
    if (secrets.some((s) => s.name === key)) continue;
    const meta = byEnv.get(key);
    env.push({ key, label: meta?.label, note: meta?.note });
  }
  for (const e of opts.ownedEnv ?? []) {
    if (secrets.some((s) => s.name === e.key)) continue;
    if (!env.some((x) => x.key === e.key)) env.push({ key: e.key, label: e.label, note: e.note });
  }

  const mcpMeta = opts.vault?.mcp ?? [];
  const mcp: string[] = [];
  for (const id of extracted.mcpIds) {
    const hit = mcpMeta.find((m) => m.id === id || m.name === id);
    mcp.push(hit?.name ?? id);
  }

  const sharedSkills: NeedSharedSkill[] = [];
  for (const sk of opts.sharedSkills ?? []) {
    const key = sk.key ?? sk.name;
    const mentioned =
      extracted.skillRefs.includes(key) ||
      extracted.skillRefs.includes(sk.name) ||
      opts.privateSkills.some((p) => p.body.includes(sk.name) || (sk.key && p.body.includes(sk.key)));
    if (mentioned) sharedSkills.push({ name: sk.name, description: sk.description });
  }

  return {
    secrets: uniqBy(secrets, (s) => s.name),
    env: uniqBy(env, (e) => e.key),
    commands: extracted.commands.length ? extracted.commands : undefined,
    mcp: mcp.length ? [...new Set(mcp)] : undefined,
    sharedSkills: sharedSkills.length ? uniqBy(sharedSkills, (s) => s.name) : undefined,
  };
}

export function diffNeeds(needs: BotNeeds | undefined | null, local: LocalReady): NeedsDiff {
  const n = needs ?? emptyNeeds();
  const secrets = setOf(local.secretNames);
  const envs = setOf(local.envKeys);
  const cmds = local.commands ? setOf(local.commands) : null;
  const mcps = local.mcpNames ? setOf(local.mcpNames) : null;
  const sks = local.skills ? setOf(local.skills) : null;

  const missSec: NeedSecret[] = [];
  const haveSec: NeedSecret[] = [];
  for (const s of n.secrets ?? []) {
    if (secrets.has(s.name)) haveSec.push(s);
    else missSec.push(s);
  }
  const missEnv: NeedEnv[] = [];
  const haveEnv: NeedEnv[] = [];
  for (const e of n.env ?? []) {
    if (envs.has(e.key)) haveEnv.push(e);
    else missEnv.push(e);
  }

  // 未传入本机检测集合时不记 missing（unknown），避免无法校验的项永远卡着开箱
  const missCmd: string[] = [];
  const haveCmd: string[] = [];
  for (const c of n.commands ?? []) {
    if (!cmds) continue;
    if (cmds.has(c)) haveCmd.push(c);
    else missCmd.push(c);
  }

  const missMcp: string[] = [];
  const haveMcp: string[] = [];
  for (const m of n.mcp ?? []) {
    if (!mcps) continue;
    const hit = [...mcps].some((x) => x === m || x.toLowerCase() === m.toLowerCase());
    if (hit) haveMcp.push(m);
    else missMcp.push(m);
  }

  const missSk: NeedSharedSkill[] = [];
  const haveSk: NeedSharedSkill[] = [];
  for (const s of n.sharedSkills ?? []) {
    if (!sks) continue;
    const hit = [...sks].some((x) => x === s.name || x.toLowerCase() === s.name.toLowerCase());
    if (hit) haveSk.push(s);
    else missSk.push(s);
  }

  return {
    missing: {
      secrets: missSec,
      env: missEnv,
      commands: missCmd.length ? missCmd : undefined,
      mcp: missMcp.length ? missMcp : undefined,
      sharedSkills: missSk.length ? missSk : undefined,
    },
    present: {
      secrets: haveSec,
      env: haveEnv,
      commands: haveCmd.length ? haveCmd : undefined,
      mcp: haveMcp.length ? haveMcp : undefined,
      sharedSkills: haveSk.length ? haveSk : undefined,
    },
  };
}

/** 导入预览 / 开箱消息用的可读列表 */
export function formatNeedsList(needs: BotNeeds | undefined | null, title = "需要你本机准备"): string {
  if (!hasNeeds(needs)) return "";
  const n = needs!;
  const lines: string[] = [];
  for (const s of n.secrets ?? []) {
    lines.push(`- 密钥 \`${s.name}\`${s.label ? `（${s.label}）` : ""}${s.note ? `：${s.note}` : ""}`);
  }
  for (const e of n.env ?? []) {
    lines.push(`- 配置 \`${e.key}\`${e.label ? `（${e.label}）` : ""}${e.note ? `：${e.note}` : ""}${e.hint ? ` · ${e.hint}` : ""}`);
  }
  for (const c of n.commands ?? []) lines.push(`- 命令 \`${c}\``);
  for (const m of n.mcp ?? []) lines.push(`- MCP「${m}」`);
  for (const s of n.sharedSkills ?? []) lines.push(`- 共享技能「${s.name}」：${s.description}`);
  return `【${title}】\n${lines.join("\n")}`;
}

/** 写入会话的开箱说明（用户可见） */
export function onboardGreeting(botName: string, needs: BotNeeds, diff: NeedsDiff): string {
  const parts = [
    `你好，我是从分享模板导入的「${botName}」。人设和私有技能已经就位；模型和密钥不会随链接带走，要用你本机的配置。`,
  ];
  if (hasHardGaps(diff) || hasAnyGaps(diff)) {
    parts.push("");
    parts.push(formatNeedsList(diff.missing, "还缺这些（我会引导你补齐）") || formatNeedsList(needs, "可能需要准备"));
    if (hasNeeds(diff.present)) {
      parts.push("");
      parts.push(formatNeedsList(diff.present, "你本机已有（会跳过）"));
    }
    parts.push("");
    parts.push("直接跟我说「开始配置」或随便打个招呼，我会用加密输入框 / 表单逐项请你填写；已经有的不会重复要。");
  } else if (hasNeeds(needs)) {
    parts.push("");
    parts.push("分享时声明的依赖你本机都已齐，可以直接开始用。");
  } else {
    parts.push("这个模板没有额外依赖声明，挂上模型就可以聊。");
  }
  return parts.join("\n");
}

/** 注入系统提示的开箱规则（模型可见） */
export function onboardPromptSection(diff: NeedsDiff): string {
  if (!hasAnyGaps(diff)) return "";
  const list = formatNeedsList(diff.missing, "开箱缺口（以本机 Vault 实测为准）");
  return `【开箱】你是刚从别人分享的模板导入的。先完成配置再正常接任务：
${list}
- 对照【已配置的环境】：已有的密钥 / 配置不要再 ui.secret / env.set。
- 缺的密钥用 ui.secret（name、label、note 写清用途）；缺的普通配置用 ui.form 一次收多项，或逐个 env.set。
- 缺命令 / MCP / 共享技能时，用一两句话告诉用户去哪装或怎么建，不要假装已经有了。
- 能低成本验证的（只读接口）填完后验证一次；全部硬缺口（密钥/配置）齐了再开始干活。
- 不要向用户念「开箱」或「系统附注」这些词，自然引导即可。`;
}
