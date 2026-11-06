import type { Group, GroupSettings } from "./group-registry";
import type { Store } from "./store";

/** 可发现的组队模板：建群时带目标 + 房间起步话术 */
export interface GroupStarter {
  id: string;
  name: string;
  blurb: string;
  goal: string;
  /** 按角色关键词挑成员（不够就用已选 / 前几个 bot） */
  roleHints: string[];
  /** 进房后可点的起步话术 */
  starters: string[];
}

export const GROUP_STARTERS: GroupStarter[] = [
  {
    id: "research-write",
    name: "调研写作组",
    blurb: "一人挖资料，一人成文；用 @ 交接。",
    goal: "先调研再成文：明确主题与受众 → 收集要点与来源 → 提纲确认后写完整稿。成员用 @ 交接，不要假装并行。",
    roleHints: ["调研", "研究", "搜索", "写作", "文案", "编辑", "报告"],
    starters: [
      "我们要写一份竞品简报，先定主题和受众",
      "@调研 先列资料提纲，写完 @写作 接",
      "先用一句话说明今天要交付什么",
    ],
  },
  {
    id: "triage",
    name: "分诊评审组",
    blurb: "复述需求 → 谁合适 → 定下一步。",
    goal: "分诊用户需求：复述约束 → 候选负责人与理由 → 简单任务 bot.ask，多人同场用 @ 交接 → 回执谁负责、下一步、何时更新。",
    roleHints: ["产品", "工程", "开发", "风险", "评审", "主控", "助手"],
    starters: [
      "帮我分诊：这个需求该谁先接？",
      "先复述一遍需求与约束，再提名负责人",
      "列出候选成员和理由，我来拍板",
    ],
  },
  {
    id: "daily-review",
    name: "日报复盘组",
    blurb: "主持串场，成员补完成/风险/明日。",
    goal: "日报复盘：主持人串场收集今日完成、进行中、风险阻塞、明日计划；结构输出 Markdown，不编造未确认事项。",
    roleHints: ["主持", "记录", "秘书", "助理", "主控", "助手"],
    starters: [
      "开始今日站会：各自说完成 / 进行中 / 风险",
      "主持人先汇总，缺信息再点名补充",
      "按完成 / 进行中 / 风险 / 明日 整理一版日报",
    ],
  },
];

export function groupStarterById(id: string): GroupStarter | undefined {
  return GROUP_STARTERS.find((s) => s.id === id);
}

/** 按角色/名字关键词挑成员；不够则用 fallback 补齐到至少 2 人 */
export function pickMembersForStarter(
  bots: Array<{ id: string; name: string; role?: string }>,
  starter: GroupStarter,
  fallbackIds: string[] = [],
  max = 4,
): string[] {
  const scored = bots.map((b) => {
    const blob = `${b.name} ${b.role || ""}`.toLowerCase();
    const hits = starter.roleHints.filter((h) => blob.includes(h.toLowerCase())).length;
    return { id: b.id, hits };
  }).filter((x) => x.hits > 0).sort((a, b) => b.hits - a.hits);

  const out: string[] = [];
  for (const x of scored) {
    if (out.length >= max) break;
    if (!out.includes(x.id)) out.push(x.id);
  }
  for (const id of fallbackIds) {
    if (out.length >= Math.max(2, max)) break;
    if (!out.includes(id)) out.push(id);
  }
  for (const b of bots) {
    if (out.length >= 2) break;
    if (!out.includes(b.id)) out.push(b.id);
  }
  return out.slice(0, max);
}

export function groupWelcomeText(
  group: Pick<Group, "name"> & { settings?: GroupSettings },
  memberNames: string[],
): string {
  const who = memberNames.length ? memberNames.join("、") : "成员";
  const goal = group.settings?.goal?.trim();
  const lines = [
    `这里是群聊「${group.name}」。在场：${who}。`,
    "怎么协作：@ 谁谁回；没 @ 时由主持人先说。成员也可以【交给】下一位。",
    goal ? `本群目标：${goal}` : "可以在右侧详情里写群目标，会注入每位成员的提示。",
    "点下面的建议开场，或直接打字。",
  ];
  return lines.join("\n");
}

export function groupStarterSuggestions(
  group: Pick<Group, "name" | "settings">,
  starterId?: string,
): string[] {
  const preset = starterId ? groupStarterById(starterId) : undefined;
  if (preset) return preset.starters.slice(0, 3);
  const goal = group.settings?.goal?.trim();
  const tips = [
    goal ? `围绕目标开场：${goal.slice(0, 40)}${goal.length > 40 ? "…" : ""}` : `大家好，我们在「${group.name}」里先对齐今天要做什么`,
    "主持人先说两句，再 @ 下一位",
    "有结论时请整理成决定与任务",
  ];
  return tips.slice(0, 3);
}

/** 新建群后种一间欢迎房；已有消息则不重复种 */
export function seedGroupWelcome(
  store: Store,
  group: Group,
  memberNames: string[],
  opts?: { starterId?: string },
): string {
  const sid = `group-${group.id}`;
  const existing = store.listSessionsPage({ botId: group.id, limit: 3 }).sessions
    .find((s) => (s.messageCount ?? 0) > 0);
  if (existing) return existing.id;

  store.ensureSession(sid, group.id, group.name);
  store.addMessage({
    sessionId: sid,
    from: "system",
    to: "user",
    role: "assistant",
    content: groupWelcomeText(group, memberNames),
    kind: "chat",
    createdAt: Date.now(),
    meta: {
      suggestions: groupStarterSuggestions(group, opts?.starterId),
      tag: "group-welcome",
    },
  });
  return sid;
}
