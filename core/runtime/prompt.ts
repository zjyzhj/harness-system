// 系统提示与每条消息附注的组装：角色、软件现状、工具清单、交互约定、规范
import type { Bot, ToolCall } from "../types";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeDeps, RuntimeOptions } from "./types";
import { formatNow } from "./turn-helpers";
import { rulesWhereabouts } from "./rules-text";
import { isDemoTopic } from "../demo-skill";
import { diffNeeds, hasAnyGaps, onboardPromptSection } from "../bot-share-needs";

/** 可选提示词附加（娱乐侧车等挂载；默认空 = Bot 完整设计不受干扰） */
export type PromptExtras = {
  /** 稳定 system 里追加的一行/一节事实；返回空则不加 */
  stableFact?: (bot: Bot) => string | null | undefined;
  /** 易变上下文：按本轮 query 决定是否注入；返回空则不加 */
  volatile?: (bot: Bot, query: string) => string | null | undefined;
};

export class PromptBuilder {
  private extras: PromptExtras = {};
  constructor(private deps: RuntimeDeps, private toolsPrompt: () => string) {}

  setExtras(extras: PromptExtras): void {
    this.extras = extras;
  }

  /**
   * 组装系统提示：只放跨请求不变或很少变的内容，越稳定越靠前，
   * 让 DeepSeek 等端点的前缀缓存能命中（命中部分按约 1/10 计费）。
   * 时间、按本条消息检索的记忆等易变内容放在 volatileContext，随用户消息发送。
   */
  buildContext(bot: Bot, _query: string, opts?: RuntimeOptions): string {
    const parts: string[] = [];
    parts.push(bot.systemPrompt || `${bot.name}（${bot.role}）：${bot.persona}`);
    parts.push(`你是 ${bot.name}，角色：${bot.role}。人设：${bot.persona}`);
    if (opts?.extraSystem?.trim()) parts.push(opts.extraSystem.trim());
    if (opts?.unattended) parts.push("【无人值守】这是自动执行的任务，没有用户在场：不要反问、不要让用户选择或确认，也不要说「等你确认」。信息不全时自己做合理假设，在开头用一句话写明假设，然后直接交付完整产出。");
    // 软件真实状态放在交互约定前面，优先于对话里说过的旧话
    // 娱乐侧车事实（若有）经 PromptExtras.stableFact 注入，不进 Bot 核心
    parts.push(this.selfFacts(bot, opts));
    parts.push(...this.instructionSections(bot, opts));
    if (opts?.injectMemory !== false) {
      // 规范只在【规范】一节出现一次（带存放位置），记忆上下文里不再重复列；顺带带上其他 bot 的私有规范，避免主控误说「它没有」
      const ruleTexts = (ns: string) => this.deps.memory.list(ns).filter((e) => e.kind === "rule").sort((a, b) => a.updatedAt - b.updatedAt).slice(-40).map((e) => e.content);
      const teammates = this.deps.store.listBots()
        .filter((b) => b.id !== bot.id)
        .map((b) => ({ name: b.name, id: b.id, rules: ruleTexts(`bot:${b.id}`) }));
      parts.push(rulesWhereabouts(bot, this.deps.skills.list(), { own: ruleTexts(`bot:${bot.id}`), shared: ruleTexts("global"), teammates }));
    }
    return parts.join("\n\n");
  }

  /** bot 所在群的 id（群共享记忆 namespace = group:<id>） */
  groupIdsOf(bot: Bot): string[] {
    return this.deps.groups?.list(bot.id).map((g) => g.id) ?? [];
  }

  /** 每条消息都可能不同的上下文：当前时间、按这条消息检索到的记忆、侧车易变附加 */
  volatileContext(bot: Bot, query: string, opts?: RuntimeOptions): string {
    const parts = [`当前时间：${formatNow(new Date())}`];
    if (opts?.injectMemory !== false) {
      const mem = this.deps.memory.buildContext(bot.id, query, this.groupIdsOf(bot), { rules: false });
      if (mem) parts.push(mem);
    }
    const demo = this.deps.demo;
    if (demo && (demo.isRecording(bot.id) || isDemoTopic(query))) {
      parts.push(demo.playbook(bot.id));
    }
    const extra = this.extras.volatile?.(bot, query);
    if (extra?.trim()) parts.push(extra.trim());
    return parts.join("\n\n");
  }

  /** 工具清单与交互约定：只随技能 / MCP / 工作区变化 */
  instructionSections(bot: Bot, opts?: RuntimeOptions): string[] {
    const parts: string[] = [];
    if (opts?.injectSkills !== false) {
      const skills = this.deps.skills.toolDescriptions(bot.id);
      const mcpParams = (schema: any) => {
        const props = Object.keys(schema?.properties ?? {});
        const req = new Set<string>(schema?.required ?? []);
        return props.length ? ` 参数 {${props.map((k) => (req.has(k) ? `${k}*` : k)).join(", ")}}` : "";
      };
      const mcpTools = this.deps.mcp?.listTools().map((t) => `- mcp:${t.serverId}/${t.name}: ${(t.description ?? t.name).split("\n")[0].slice(0, 160)}${mcpParams(t.inputSchema)}`).join("\n") ?? "";
      const tools = [
        this.toolsPrompt(),
        skills ? `【技能】\n${skills}` : "",
        mcpTools ? `【MCP 工具】\n${mcpTools}` : "",
      ].filter(Boolean).join("\n\n");
      if (tools) {
        parts.push(opts?.nativeTools
          ? `【可用工具与技能】需要以下能力时，调用函数 call_tool：tool 填工具名或技能 key，args 填参数对象。不要在正文里写工具调用的 JSON。\n${tools}`
          : `【可用工具与技能】当需要以下能力时，在回复中输出工具块调用。\n${tools}\n工具块格式：\n\`\`\`tool\n{"tool":"<工具或技能key>","args":{...}}\n\`\`\``);
      }
    }
    const ws = this.workspaceOf(bot);
    if (ws) parts.push(`【工作区】你的工作目录是 ${ws}。生成的文件写到这里（fs.write 可写），做完用 file.send 交付给用户。`);
    parts.push(`【交互】
- 调用工具前先用一句话告诉用户你要做什么（这句话会单独显示成一条消息），然后再调用工具。
- 只要你打算让用户「选一个 / 挑一个 / 决定走哪条路」，就必须调用 ui.ask，把每个方案写成一个简短选项（界面显示成可点击按钮）；不要在正文里用列表让用户回复编号。可以先用一两句话说明背景，再调用 ui.ask，调用后这一轮就结束，等用户点选。
- 对外或不可逆的操作（发消息/通知到飞书、钉钉、Slack、邮件等外部渠道、上传、发布、提交、删除、付费、改线上数据）执行前，必须先调用 ui.confirm 工具（不要用文字代替），说明要做什么并等用户点「确认」，用户确认后再执行。软件里的群聊（[群名](app:group/…)）是内部的：用户让你往群里发话，直接用 group.send 发，不用确认，也不要转托别的 bot 代发。
- 只有工具结果里写明成功的事才能说「已发送 / 已完成」；没有对应工具就如实说做不到。
- 需要密码 / Token / App Secret 等敏感信息时，用 ui.secret（name, label, note 写清用途）让用户在加密输入框里填写，不要让用户直接发在聊天里；保存后 bash.run 里写 $名字，其它工具参数里写 {{secret:名字}}，你看不到真值。已经配置过的看【已配置的环境】，不要重复要。
- 改用户工程里的代码（大仓库、多文件、实现功能、修 bug）：用 cli.agent（task + cwd 或先 env.set PROJECT_ROOT）；会启动本机 Cursor/Claude/Codex 可写 Agent，须用户批准。白名单工作区里的小文件仍用 fs.write；不要把聊天用的 CLI Provider 当成会改仓库——派工只走 cli.agent。
- 问到新闻、价格、版本、政策等可能过时或你不确定的事实时，先用 web.search 联网查，必要时再用 web.fetch 打开具体网页；回答里用到网上的信息，就在那句话末尾标上来源序号，如 [1]、[2][3]（序号就是工具结果里给的编号），不要在末尾另列参考链接。
- 用户要画图、生成海报/头像/插画时用 image.generate；要改一张已有的图时用 image.edit。
- 用户给某类任务定规范、改要求、指出你做得不对时，规范要写到以后真正会用到的地方：
  1) 【技能】里有对应这类任务的技能 → 先 skill.get 看原文，再一次 skill.update 写进去：和旧规则冲突的用 replace 原地改掉旧原文；原文里没有对应条目的才放 append。同一条不要既 replace 又 append；回复只说工具结果里真实发生的改动；
  2) 没有对应技能、但这是会反复做的任务 → 用 skill.save 建一个私有技能，把规范写成指令；
  3) 关于用户本人、或不属于某个具体任务的通用要求（称呼、语言、回答风格、团队分工）→ 用 memory.add（kind: rule）；用户明说「所有 bot / 大家都」才加 scope: "all"。
  直接存，不要先问用户「存到哪里 / 哪一层」；存完把工具结果里的链接给用户，让他点开就能看到和改。
  写完在回复里用技能引用告诉用户写进了哪里；链接必须原样使用工具结果里的 app:skill/…，不要自己编 key。没调用 skill.save / skill.update / memory.add 就不要说「建好了 / 记下了 / 写进规范了」——否则侧栏看不到、点开会提示找不到。
- 记忆（对齐「相关才带、不每轮塞满」）：
  1) 日常用 memory.add / update / forget / list 管单条 fact/rule；用户说「记住 / 忘掉 / 你记得什么」走工具，不要空口说记得。
  2) 系统会在后台把单条蒸馏成 MEMORY.md，但不会每轮塞进上下文——只有问到记忆或内容相关时才会附上。你不必改 MEMORY.md；改单条即可。用户要看全文可给 [记忆](app:settings/memory)。
  问「你记得什么」时用 memory.list 按单条如实答；记错了用 update / forget，不要再 add 一条相反的。
- 提到软件里的东西时写成可点击的引用，用户点一下就能打开：技能 [技能名](app:skill/<key>)、bot [名字](app:bot/<名字>)、群聊 [群名](app:group/<群名>)、文件 [文件名](app:file/<绝对路径>)、项目 [项目名](app:project/<项目名>)；要用户去设置时给入口：[模型设置](app:settings/models)、[图片生成设置](app:settings/image)、[语音设置](app:settings/voice)、[技能管理](app:settings/skills)、[定时任务](app:settings/tasks)、[记忆](app:settings/memory)、[MCP 工具](app:settings/mcp)、[自定义指令](app:settings/instructions)、[系统权限](app:settings/access)。工具结果里已经给出的引用原样保留。`);
    parts.push(`回复要求：除非用户要求，用中文回答；需要调用技能时先输出工具块，工具结果返回后再给最终回复。要给用户看的文件、图片、产出物，一律用 file.send 交付到对话里，不要只贴路径。`);
    return parts;
  }

  /** bot 自己的工作目录（不存在就建） */
  workspaceOf(bot: Bot): string | null {
    if (!this.deps.workspaceRoot) return null;
    const dir = join(this.deps.workspaceRoot, "bots", bot.id);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** 这个软件里与你有关的真实情况：团队成员、配过的环境和密钥。放在前面，优先于对话里说过的旧话 */
  selfFacts(bot: Bot, opts?: RuntimeOptions): string {
    const bots = this.deps.store.listBots();
    const roster = this.teamRoster(bot);
    const canAsk = this.deps.askBot && (opts?.depth ?? 0) === 0;
    const team = `【团队】你在 harness 里，共有 ${bots.length} 个 bot（含你自己「${bot.name}」）。其他成员：\n${roster || "（没有其他成员）"}` +
      (bot.isMaster ? `\n你是团队主控：用户的复杂需求由你拆解，把子任务用 bot.ask 分派给合适的成员，再汇总结果回复用户。` : "") +
      (canAsk && roster ? `\n需要其他成员的专长时，用工具块 {"tool":"bot.ask","args":{"to":"<bot名>","message":"<要问的话>"}} 直接问它，拿到回复后再整合回答用户。` +
        `\n同一轮里的多个 bot.ask 会同时发出：互不依赖的才放在同一轮；后一步要用前一步的结果时，这一轮只问第一个，拿到回复再问下一个，不要先给还没轮到的成员发「稍等」之类的占位消息。` +
        (this.deps.plans ? `\n用户明确说「编排 / 流水线 / 后台跑」，或任务有 3 步以上、要跑很久时，用 plan.start 发起编排在后台运行，告诉用户已开始，结果会自动发回对话；两三步的简单接力直接用 bot.ask 当场完成。` : "") : "");

    const env = this.deps.env?.visibleTo(bot.id) ?? [];
    const secrets = this.deps.secrets?.list(bot.id) ?? [];
    const who = (id?: string) => (id ? (id === bot.id ? "你" : this.deps.store.getBot(id)?.name ?? "用户") : "用户");
    const envLines = env.map((e) => `  - ${e.key}=${e.value.length > 120 ? `${e.value.slice(0, 120)}…` : e.value}${e.label ? `（${e.label}）` : ""}${e.note ? `：${e.note}` : ""}${e.botId ? "" : " [所有 bot 共用]"}`);
    const secretLines = secrets.map((s) => `  - ${s.name}${s.label && s.label !== s.name ? `（${s.label}）` : ""}${s.note ? `：${s.note}` : ""}${s.botId ? "" : " [所有 bot 共用]"} · ${who(s.savedBy)}在 ${new Date(s.savedAt).toISOString().slice(0, 10)} 配置`);
    const config = [
      `【已配置的环境】用户给过的配置都存在这里，重启后还在；需要时直接用，不要再问用户要。查看 / 修改：[环境配置](app:settings/env)`,
      envLines.length ? `- 环境变量（bash.run 执行时自动注入，命令里直接写 $KEY）：\n${envLines.join("\n")}` : "- 环境变量：还没有",
      secretLines.length ? `- 密钥（加密保存，你看不到值；bash.run 里写 $NAME，其它工具参数里写 {{secret:NAME}}）：\n${secretLines.join("\n")}` : "- 密钥：还没有",
      "用户给你接口地址、账号名、项目 ID 这类普通配置时用 env.set 存；密码 / Token / Secret 用 ui.secret 让用户加密填写，不要明文存，也不要让用户发在聊天里。配置有变化就更新原来那项。\n用户刚给完配置或密钥（用户说已在加密框里填好，或 env.set 成功）后，如果能低成本验证（如调一次只读接口、登录测试），用 bash.run 验证一次并告诉用户结果；验证失败就说明原因，请用户检查后用 ui.secret（overwrite:true）或 env.set 更新。",
    ].join("\n");

    const app = `【软件现状】\n${this.appSnapshot(bot).lines.join("\n")}`;
    const demoBrief = this.deps.demo?.brief(bot.id)?.trim();
    const side = this.extras.stableFact?.(bot)?.trim();
    const onboard = this.shareOnboardSection(bot);
    const blocks = [team, demoBrief, side, app, config, onboard].filter(Boolean);
    return `${blocks.join("\n\n")}\n\n以上是这个软件当前的真实状态。用户问到软件里的任何东西（bot、群聊、定时任务、编排、项目、技能、配置），以这里为准回答，并附上可点的引用；这里没写全或要细节时调用 app.state 查，不要说「看不到 / 没有这类信息」。如果你之前在对话里说过查不到或说错了，直接按这里纠正。`;
  }

  /** 分享导入开箱：对照本机 Vault 的实时缺口 */
  private shareOnboardSection(bot: Bot): string {
    if (!bot.shareOnboard) return "";
    const diff = diffNeeds(bot.shareOnboard, {
      secretNames: (this.deps.secrets?.list(bot.id) ?? []).map((s) => s.name),
      envKeys: (this.deps.env?.visibleTo(bot.id) ?? []).map((e) => e.key),
      mcpNames: (this.deps.mcpManage?.list() ?? this.deps.mcp?.status() ?? []).map((m: { name: string }) => m.name),
      skills: this.deps.skills.list().flatMap((s) => [s.name, s.key]),
    });
    if (!hasAnyGaps(diff)) {
      // 可校验缺口已齐：收尾提一下未自动检测的软依赖，然后清掉挂起标记
      const soft = softOnboardTips(bot.shareOnboard);
      if (bot.shareOnboard) {
        const next = { ...bot };
        delete next.shareOnboard;
        this.deps.store.saveBot(next);
      }
      return soft;
    }
    // 命令不做 PATH 探测，单独口头提醒；MCP/共享技能已进 diff.missing
    return onboardPromptSection(diff) + softOnboardTips(bot.shareOnboard);
  }

  /** 回复里声称问过 / 转述了某个 bot，却没调用 bot.ask：返回那个 bot 的名字 */
  fakedDelegation(bot: Bot, text: string, calls: ToolCall[], mentioned: string[] = []): string | null {
    const asked = calls.filter((c) => c.tool === "bot.ask").map((c) => String(c.args?.to ?? "")).filter(Boolean);
    const wasAsked = (name: string) => asked.some((a) => a === name || name.includes(a) || a.includes(name));
    const skipped = mentioned.find((n) => !wasAsked(n));
    if (skipped) return skipped;
    const names = this.deps.store.listBots().filter((b) => b.id !== bot.id).map((b) => b.name).sort((a, b) => b.length - a.length);
    const sentences = text.split(/(?<=[。！？!?\n])/);
    for (const name of names) {
      if (wasAsked(name)) continue;
      const n = `${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\s*\\d)`;
      const re = new RegExp(`(去问|问问|问一下|问下|找一下|已经问|问过|问了)\\s*(一下)?\\s*${n}|${n}\\s*(说|回复|回答|表示|答复|告诉我)`);
      const hit = sentences.find((x) => re.test(x));
      if (hit && !/要不要|需要我|要我|可以帮你|如果你|[？?]\s*$/.test(hit)) return name;
    }
    return null;
  }

  /** 贴在本轮用户消息前的简短现状：离模型最近，压过历史里自己说过的旧结论（不落盘、不显示） */
  /** 软件现状：群聊、定时任务、编排、项目、技能。full = app.state 工具的完整版 */
  appSnapshot(bot: Bot, full = false): { lines: string[]; brief: string } {
    const nameOf = (id: string) => (id === "user" ? "用户" : this.deps.store.getBot(id)?.name ?? id);
    const groups = this.deps.groups?.list() ?? [];
    const tasks = this.deps.tasks?.list?.() ?? this.deps.tasks?.listForBot(bot.id) ?? [];
    const facts = this.deps.appFacts?.() ?? { plans: [], projects: [] };
    const skills = this.deps.skills.list();
    const mcps = this.deps.mcpManage?.list() ?? this.deps.mcp?.status() ?? [];
    const cap = (arr: string[], n: number) => (full || arr.length <= n ? arr : [...arr.slice(0, n), `…还有 ${arr.length - n} 个（用 app.state 查全部）`]);
    const lines = [
      `- 群聊 ${groups.length} 个${groups.length ? "：" : ""}${cap(groups.map((g) => `[${g.name}](app:group/${encodeURIComponent(g.name)})（成员：${g.members.map(nameOf).join("、")}）`), 10).join("；")}`,
      `- 定时任务 ${tasks.length} 个${tasks.length ? "：" : ""}${cap(tasks.map((t) => `${t.name}（${nameOf(t.botId)} · ${t.cron}${t.enabled ? "" : " · 已停用"}）`), 10).join("；")}`,
      `- 编排计划 ${facts.plans.length} 个${facts.plans.length ? "：" : ""}${cap(facts.plans.map((x) => `${x.title}（${x.status}）`), 5).join("；")}`,
      `- 项目 ${facts.projects.length} 个${facts.projects.length ? "：" : ""}${cap(facts.projects.map((x) => `[${x.name}](app:project/${encodeURIComponent(x.name)})`), 10).join("、")}`,
      `- 技能 ${skills.length} 个${skills.length ? "：" : ""}${cap(skills.map((k) => `[${k.name}](app:skill/${k.key})`), 15).join("、")}`,
      `- MCP ${mcps.length} 个${mcps.length ? "：" : ""}${cap(mcps.map((s) => `${s.name}（${s.error ? "连接失败" : `${s.tools} 工具`}）`), 10).join("、")}${this.deps.mcpManage ? " · 只用 mcp.list / mcp.add / mcp.remove（热加载，禁止手改 config.json，也禁止让用户重启软件）" : ""}`,
      `- 电脑操控（内置）：用 mcp:computer/macos_snapshot 看界面元素，再用 macos_act / macos_click / macos_type 等操作；先 mcp:computer/macos_doctor 检查辅助功能与屏幕录制权限。不要说「没有 computer use」`,
    ];
    const brief = `群聊 ${groups.length} 个${groups.length ? `（${groups.map((g) => g.name).join("、")}）` : ""}，定时任务 ${tasks.length} 个，编排计划 ${facts.plans.length} 个，项目 ${facts.projects.length} 个，技能 ${skills.length} 个，MCP ${mcps.length} 个`;
    return { lines, brief };
  }

  /** 用户消息里 @ 到的其他 bot（长名字优先，「@灵感助手 2」不会被当成「@灵感助手」） */
  mentionedBots(bot: Bot, text: string): string[] {
    let rest = text;
    const out: string[] = [];
    for (const b of this.deps.store.listBots().filter((x) => x.id !== bot.id).sort((x, y) => y.name.length - x.name.length)) {
      if (!rest.includes(`@${b.name}`)) continue;
      out.push(b.name);
      rest = rest.split(`@${b.name}`).join(" ");
    }
    return out;
  }

  stateNote(bot: Bot, mentioned: string[] = [], extra = ""): string {
    const bots = this.deps.store.listBots();
    const names = bots.map((b) => `${b.name}${b.id === bot.id ? "（你）" : ""}${b.isMaster ? "（主控）" : ""}`).join("、");
    const env = this.deps.env?.visibleTo(bot.id).map((e) => e.key) ?? [];
    const sec = this.deps.secrets?.list(bot.id).map((x) => x.name) ?? [];
    return `<系统附注，不是用户写的>当前团队共 ${bots.length} 个 bot：${names}。软件里还有：${this.appSnapshot(bot).brief}（详见系统提示【软件现状】，可用 app.state 查）。` +
      `你可用的配置：${env.length ? env.join("、") : "无"}；密钥：${sec.length ? sec.join("、") : "无"}。` +
      `这是此刻的真实状态；你在之前的对话里如果说过看不到 bot 列表、群聊、任务、配置等，那是错的，需要时直接按这里回答并纠正。不要向用户提起这段附注。` +
      (mentioned.length ? `用户这条消息 @ 了 ${mentioned.join("、")}：意思是让你去和 ${mentioned.join("、")} 沟通。用 bot.ask 把用户要说的话转达给对方（消息里的「他 / 它 / 对方」指被 @ 的 bot），拿到真实回复后再告诉用户；不要找其他 bot，也不要自己替对方回答。` : "") +
      (extra.trim() ? `\n\n${extra.trim()}\n` : "") +
      `</系统附注>`;
  }

  teamRoster(self: Bot): string {
    return this.deps.store.listBots()
      .filter((b) => b.id !== self.id)
      .map((b) => {
        const pet = b.petEnabled ? "，桌宠上台中" : "";
        return `- ${b.name}（${b.role || "通用助手"}${b.isMaster ? "，主控" : ""}${pet}${b.name === self.name ? "，和你同名但不是你，是另一个 bot" : ""}）${b.persona ? `：${b.persona.slice(0, 40)}` : ""}`;
      })
      .join("\n");
  }
}

/** 命令不做本机 PATH 探测，开箱时口头提醒 */
function softOnboardTips(needs: Bot["shareOnboard"]): string {
  if (!needs?.commands?.length) return "";
  const bits = needs.commands.map((c) => `命令 \`${c}\``);
  return `\n另有分享时声明、需本机自行准备的项：${bits.join("；")}。有则用，没有就如实告诉用户怎么准备。`;
}
