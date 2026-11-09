// 系统提示与每条消息附注的组装：角色、软件现状、工具清单、交互约定、规范
import type { Bot, ToolCall } from "../types";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeDeps, RuntimeOptions } from "./types";
import { formatNow } from "./turn-helpers";
import { rulesWhereabouts } from "./rules-text";
import { isDemoTopic } from "../demo-skill";
import { diffNeeds, hasAnyGaps, onboardPromptSection } from "../bot-share-needs";
import { formatCodingAgentsPromptLine } from "../coding-agents";
import { threadStub } from "../coding-thread";
import { formatCodingDirLine, formatPresenceLine } from "../coding-presence";
import { formatBrowserPresenceLine } from "../browser-presence";
import { readBotWatch } from "../system-watch";

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
    if (opts?.unattended) parts.push("【例行】这是用户已经定下的吩咐，现在到点了，没有人在场。不要反问，不要 ui.ask / ui.confirm / ui.secret。信息不全就写明假设，然后把准备、核对、草稿做完。查阅、整理、写草稿、在已指定目录里改代码可以直接做。出站 webhook.post，以及 secret.delete / skill.delete / sys.purge / task.delete / webhook.remove / env.delete，会停在批准点，除非这个 bot 是 Always。工具返回「停在批准点」时，把待批准的事写进回复，不要假装已经完成。没有新数据就报告失败，不要拿旧数据凑。用户明确禁止的命令不要做。");
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
    parts.push(formatCodingDirLine(bot));
    if (bot.agentCwd && this.deps.codingThreads) {
      const stub = threadStub(this.deps.codingThreads.get(bot.id, bot.agentCwd));
      if (stub) parts.push(stub);
    }
    const presence = formatPresenceLine(this.deps.codingPresence?.snapshot(bot.id) ?? null);
    if (presence) parts.push(presence);
    const browserLine = formatBrowserPresenceLine(this.deps.browserPresence?.snapshot(bot.id) ?? null);
    if (browserLine) parts.push(browserLine);
    try {
      const watch = readBotWatch(this.deps.store.readConfig(), bot.id);
      if (watch.enabled && watch.apps.length) {
        parts.push(`【系统监听】本 bot 正在听：${watch.apps.join("、")}。查现状用 sys.observe / sys.processes（默认按此名单）；改名单让用户在详情「系统监听」里勾选。`);
      } else if (watch.enabled) {
        parts.push("【系统监听】已开但未选 App。需要盯 Cursor/Codex 等时，请用户在详情「系统监听」里添加。");
      }
    } catch { /* ignore */ }
    return parts.join("\n\n");
  }

  /** 工具清单与交互约定：只随技能 / MCP / 工作区变化 */
  instructionSections(bot: Bot, opts?: RuntimeOptions): string[] {
    const parts: string[] = [];
    if (opts?.injectSkills !== false) {
      const skills = this.deps.skills.toolDescriptions(bot.id, bot);
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
- 只要你打算让用户「选一个 / 挑一个 / 决定走哪条路」，就必须调用 ui.ask（不要写 ui.choice / ui.select，没有这些工具），把每个方案写成一个简短选项（界面显示成可点击按钮）；不要在正文里用列表让用户回复编号。可以先用一两句话说明背景，再调用 ui.ask，调用后这一轮就结束，等用户点选。
- 只有拿不准、而且用户在场时才停下来问。对外或不可逆的操作（发到飞书、钉钉、Slack、邮件、上传、发布、提交、删除、付费、改线上数据），用户没说过「不要再问」、bot 也不是 Auto / Always 时，先 ui.confirm。用户定过规范不要再问，或 bot 是 Auto / Always，就直接做。软件里的群聊（[群名](app:group/…)）直接 group.send，不用确认。
- 只有工具结果里写明成功的事才能说「已发送 / 已完成」；没有对应工具就如实说做不到。
- 需要密码 / Token / App Secret 等敏感信息时，用 ui.secret（name, label, note 写清用途）让用户在加密输入框里填写，不要让用户直接发在聊天里。密钥与普通配置默认是**账号级保险库**（对齐 Grok Vault）：本机所有 bot 都能用，交接不必再传凭据。已经配置过的看【已配置的环境】，不要重复要。已经信任的目录（「总是允许此目录」，或 bot 为 Auto / Always）里，新打开的终端环境带上普通配置和保险库密钥，命令里写 $名字；任务里写 {{secret:名字}} 也会换成真值。没信任的目录不会把密钥交进终端。网页搜索和打开网页仍然不能带密钥。
- 碰用户电脑按路径选工具（意图清晰就直接干；含糊才 ui.ask）：
  1) **看/找/交文件**：fs.list / fs.read / file.send。本机任意可读路径都可以（桌面、下载、任意文件夹；~ 可用）；**不会**打开终端面板。不要 bash ls，也不要因为「不在工程名单」就去 MCP / 绕路。工程名单只表示终端/派工槽，不限制浏览。
  2) **交互现场（shell）**：term.open 亮起面板并开 shell；用户点「打开」同义。
  3) **派工改仓（Coding CLI）**：cli.agent 同槽切到 Cursor/Claude/Codex 并打任务——**进 Cursor / Coding CLI 必须调 cli.agent**，禁止空口说「已切到 / 已进入」。之后用 term.read/write/keys。fs.write 只写 bot 工作区。同一目录点过一次「总是允许此目录」后，开终端、打字和派工都不再问。规范留在你自己这边，不要贴进终端。
  4) **网页登录与站点操作（bot 自己的浏览器）**：browser.open / goto / snapshot / click / type / keys / read / stop。每个 bot 一块内部浏览器，cookie 按 bot 隔离，不是用户的 Chrome/Safari，也不是电脑操控去点别人的窗口。登录、填表、点按钮走这条；验证码让用户在浏览器面板里接手，聊里再说「继续」。browser.type 在已批准浏览器（或 Auto / Always）时可用 {{secret:名字}}。只读公开页仍用 web.fetch；本机 App 仍用电脑操控 MCP。
  短命令（构建、脚本、启动本机面板 / launcher、碰 $HOME / \`Application Support\` / \`~/.claude\` 或 GUI）用 bash.run：不抢终端面板。命令已「总是允许」，或 bot 为 Auto / Always 时，普通命令不再弹卡；被拒绝就别换写法重试。
  **不要**先塞进聊天沙箱或 Coding CLI 再因「沙箱拦了」改口「改用 bash.run」——能预见要碰家目录 / Application Support / 弹面板 / 出工程外，**第一下就 bash.run**（或 term）；禁止先撞墙再解释。
- **两级选择卡**（意图含糊时用 ui.ask，禁止空口猜一条路；意图已清晰则禁止多此一举出卡）：
  1) 用户话说不清走哪条路径（如「搞一下这个项目」）→ 必须 ui.ask，question 可用「这件事你想怎么做？」，options 语义固定：\`只看/找文件（不打开终端）\`、\`打开终端 shell\`、\`进 Coding CLI 改仓库\`、\`用 bot 浏览器打开网页\`（措辞可微调）。点选后再调用对应工具。
  2) 用户选了「进 Coding CLI 改仓库」之后：若【已配置的环境】里可派工/已安装的 Coding CLI ≥2 家、用户未点名、且 bot 无 agentCli 偏好 → 再 ui.ask 一张 CLI 卡，options 只用探测到的已安装项（不要编造未装的）；点选后再 cli.agent，args.cli 对上所选。只有一家、用户已说「用 Cursor/Claude/Codex」、或 bot 已有 agentCli 偏好 → 直接 cli.agent，不出第二张卡。
  清晰意图示例（直接干、不出卡）：「看看桌面有什么」「列一下 src」「用 Cursor 修登录 bug」「打开终端」「登录 DeepSeek」「在网页里点发送」。
- 可调哪些 Coding CLI 以【已配置的环境】里实时探测为准。
- 问到新闻、价格、版本、政策等可能过时或你不确定的事实时，先用 web.search 联网查，必要时再用 web.fetch 打开具体网页；回答里用到网上的信息，就在那句话末尾标上来源序号，如 [1]、[2][3]（序号就是工具结果里给的编号），不要在末尾另列参考链接。要登录或交互站点用 browser.*，不要 web.fetch。
- 用户要画图、生成海报/头像/插画时用 image.generate；要改一张已有的图时用 image.edit。
- 边界（对齐 Grok）：**能力**（工具 / 技能 / 密钥 / 共用配置）账号级可交接；**情境**（记忆、例行任务、角色规范）跟 bot。群聊共享对话上下文，不自动合并各 bot 私有记忆。
- 区分一次性任务 vs 长期约定（Grok：ordinary message vs lasting rule）：
  - 「把这十二个账号的跟进写好」→ 当场做，不记。
  - 「以后对外发消息前都先问我」→ 长期规范，必须 memory.add / 写入技能。
- 用户给某类任务定规范、改要求、指出你做得不对时，规范要写到以后真正会用到的地方（直接存，不要先问「存哪一层」）：
  1) 【技能】里有对应这类任务的技能 → 先 skill.get 看原文，再一次 skill.update：冲突用 replace，没有才 append。
  2) 没有对应技能、但会反复做 → skill.save 建私有技能（how）；要定时/事件触发再用 task.create（when = Routine）。
  3) **关于用户本人的稳定事实**（姓名、时区、称呼、偏好）→ memory.add（kind: fact）；这类默认 scope:"all"（全员共享的少量用户事实，对齐 Grok）。
  4) **对本角色的做事要求**（语气、审批边界、分工）→ memory.add（kind: rule），默认只给你；用户明说「所有 bot / 大家都」才 scope:"all"。
  存完把工具结果里的链接原样给用户。没调用 skill.save / skill.update / memory.add 就不要说「建好了 / 记下了」——否则侧栏看不到。
- 记忆（Grok：稳定偏好 + 角色情境 + 工作摘要；相关才带进本轮）：
  1) 发现值得长期留的偏好/边界时自己 memory.add，不必先问「要不要记」；用户说「记住 / 忘掉 / 你记得什么」必须走 memory.add / forget / list。
  2) 登录态、地址、卡号、Token 进保险库（ui.secret / env），不要写进记忆。
  3) **记忆不是真相源**：会过期的数据（库存、价格、工单状态）去源头查；重要决策不要只靠记忆，纠正用 update / forget，不要再 add 一条相反的。
  4) 系统会后台蒸馏 MEMORY.md；只在问记忆或内容相关时附上。看/改以对话为主（「你记得什么」「忘掉…」）；需要面板时可给 [记忆](app:settings/memory)。
- 提到软件里的东西时写成可点击的引用，用户点一下就能打开：技能 [技能名](app:skill/<key>)、bot [名字](app:bot/<名字>)、群聊 [群名](app:group/<群名>)、文件 [文件名](app:file/<绝对路径>)、项目 [项目名](app:project/<项目名>)、例行 [例行名](app:task/<例行名>)；要用户去设置时给入口：[模型设置](app:settings/models)、[图片生成设置](app:settings/image)、[语音设置](app:settings/voice)、[技能管理](app:settings/skills)、[定时任务](app:settings/tasks)、[记忆](app:settings/memory)、[MCP 工具](app:settings/mcp)、[Connect / Webhook](app:settings/webhooks)、[入站网关](app:settings/gateway)、[短链分享](app:settings/share)、[自定义指令](app:settings/instructions)、[系统权限](app:settings/access)。不要写 app:tasks（缺斜杠打不开）；工具结果里已经给出的引用原样保留。
- 用户说「创建 / 建 webhook」：先问清出站（本软件 POST 出去）还是入站（外系统触发我）。出站有 URL 就 webhook.add；入站用 task.create + webhook:true（默认仅 Webhook、不到点跑）。用户只要「每天几点」定时：task.create 只传 cron，不要带 webhook。禁止根据 app.state 里没看到字样就说「软件没有 webhook」——有工具就有能力。`);
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
    const canAsk = this.deps.askBot && (opts?.depth ?? 0) < 2;
    const team = `【团队】你在 harness 里，共有 ${bots.length} 个 bot（含你自己「${bot.name}」）。其他成员：\n${roster || "（没有其他成员）"}` +
      (bot.isMaster ? `\n你是团队主控：用户的复杂需求由你拆解，把有实质内容的子任务用 bot.ask 分派给合适的成员，再汇总结果回复用户。` : "") +
      (canAsk && roster ? `\n需要其他成员的专长时，用工具块 {"tool":"bot.ask","args":{"to":"<bot名>","message":"<要问的话>"}} 直接问它，拿到回复后再整合回答用户。` +
        `\n同一轮里的多个 bot.ask 会同时发出：互不依赖的才放在同一轮；后一步要用前一步的结果时，这一轮只问第一个，拿到回复再问下一个，不要先给还没轮到的成员发「稍等」之类的占位消息。` +
        `\nbot.ask 只问有实质内容的问题；不要对多个成员轮流发同一句空提示。需要多人在同一场景里说话：用 group.send 发一次（要全员就在 message 里写 @所有人），或请用户去群聊；没有合适群就自己简短介绍团队。多步协作用群聊交接或依次 bot.ask。` : "");

    const env = this.deps.env?.visibleTo(bot.id) ?? [];
    const secrets = this.deps.secrets?.list(bot.id) ?? [];
    const who = (id?: string) => (id ? (id === bot.id ? "你" : this.deps.store.getBot(id)?.name ?? "用户") : "用户");
    const envLines = env.map((e) => `  - ${e.key}=${e.value.length > 120 ? `${e.value.slice(0, 120)}…` : e.value}${e.label ? `（${e.label}）` : ""}${e.note ? `：${e.note}` : ""}${e.botId ? "" : " [所有 bot 共用]"}`);
    const secretLines = secrets.map((s) => `  - ${s.name}${s.label && s.label !== s.name ? `（${s.label}）` : ""}${s.note ? `：${s.note}` : ""} [账号级共用] · ${who(s.savedBy)}在 ${new Date(s.savedAt).toISOString().slice(0, 10)} 配置`);
    const agentPref = [
      "工程目录可以有多个，正在看哪一个写在每轮的【工程目录】里",
      bot.agentCli ? `偏好 cli=${bot.agentCli}（未装则自动换）` : "无偏好（按探测顺序）",
    ].join("；");
    const config = [
      `【已配置的环境】用户给过的配置都存在这里，重启后还在；需要时直接用，不要再问用户要。查看 / 修改：[环境配置](app:settings/env)`,
      envLines.length ? `- 环境变量（终端和 bash.run 里直接写 $KEY）：\n${envLines.join("\n")}` : "- 环境变量：还没有",
      secretLines.length ? `- 密钥（账号级加密库，所有 bot 共用。已信任的终端里用 $NAME，或在任务里写 {{secret:NAME}}）：\n${secretLines.join("\n")}` : "- 密钥：还没有",
      formatCodingAgentsPromptLine(),
      `  bot 偏好：${agentPref}。改默认用 app.updateSelf（agentCwd / agentCli）。`,
      "用户给你接口地址、账号名、项目 ID 这类普通配置时用 env.set 存；密码 / Token / Secret 用 ui.secret 让用户加密填写，不要明文存，也不要让用户发在聊天里。配置有变化就更新原来那项。\n用户刚给完配置或密钥（用户说已在加密框里填好，或 env.set 成功）后，如果能低成本验证（如调一次只读接口、登录测试），用 bash.run 验证一次并告诉用户结果；验证失败就说明原因，请用户检查后用 ui.secret（overwrite:true）或 env.set 更新。",
    ].join("\n");

    const app = `【软件现状】\n${this.appSnapshot(bot).lines.join("\n")}`;
    const demoBrief = this.deps.demo?.brief(bot.id)?.trim();
    const side = this.extras.stableFact?.(bot)?.trim();
    const onboard = this.shareOnboardSection(bot);
    const blocks = [team, demoBrief, side, app, config, onboard].filter(Boolean);
    return `${blocks.join("\n\n")}\n\n以上是这个软件当前的真实状态。用户问到软件里的任何东西（bot、群聊、定时任务、项目、技能、配置），以这里为准回答，并附上可点的引用；这里没写全或要细节时调用 app.state 查，不要说「看不到 / 没有这类信息」。如果你之前在对话里说过查不到或说错了，直接按这里纠正。`;
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
  /** 软件现状：群聊、定时任务、项目、技能、Webhook、MCP。full = app.state 工具的完整版 */
  appSnapshot(bot: Bot, full = false): { lines: string[]; brief: string } {
    const nameOf = (id: string) => (id === "user" ? "用户" : this.deps.store.getBot(id)?.name ?? id);
    const groups = this.deps.groups?.list() ?? [];
    const tasks = this.deps.tasks?.list?.() ?? this.deps.tasks?.listForBot(bot.id) ?? [];
    const facts = this.deps.appFacts?.() ?? { projects: [] };
    const skills = this.deps.skills.list();
    const mcps = this.deps.mcpManage?.list() ?? this.deps.mcp?.status() ?? [];
    const hooks = this.deps.connectors?.listWebhooks() ?? [];
    const inbound = tasks.filter((t) => !!(t as { webhookToken?: string }).webhookToken);
    const cap = (arr: string[], n: number) => (full || arr.length <= n ? arr : [...arr.slice(0, n), `…还有 ${arr.length - n} 个（用 app.state 查全部）`]);
    const lines = [
      `- 群聊 ${groups.length} 个${groups.length ? "：" : ""}${cap(groups.map((g) => `[${g.name}](app:group/${encodeURIComponent(g.name)})（成员：${g.members.map(nameOf).join("、")}）`), 10).join("；")}`,
      `- 定时任务 / 例行 ${tasks.length} 个${tasks.length ? "：" : ""}${cap(tasks.map((t) => `${t.name}（${nameOf(t.botId)} · ${t.cron}${t.enabled ? "" : " · 已停用"}${(t as { webhookToken?: string }).webhookToken ? " · 入站Webhook" : ""}）`), 10).join("；")}`,
      `- 项目 ${facts.projects.length} 个${facts.projects.length ? "：" : ""}${cap(facts.projects.map((x) => `[${x.name}](app:project/${encodeURIComponent(x.name)})`), 10).join("、")}`,
      `- 技能 ${skills.length} 个${skills.length ? "：" : ""}${cap(skills.map((k) => `[${k.name}](app:skill/${k.key})`), 15).join("、")}`,
      `- MCP ${mcps.length} 个${mcps.length ? "：" : ""}${cap(mcps.map((s) => `${s.name}（${s.error ? "连接失败" : `${s.tools} 工具`}）`), 10).join("、")}${this.deps.mcpManage ? " · 只用 mcp.list / mcp.add / mcp.remove（热加载，禁止手改 config.json，也禁止让用户重启软件）" : ""}`,
      this.deps.connectors
        ? `- 出站 Webhook ${hooks.length} 个${hooks.length ? "：" : ""}${cap(hooks.map((w) => `${w.name} → ${w.url}`), 8).join("；")} · 用户说「创建 webhook」且要 POST 到外部 URL：用 webhook.add（再 webhook.post）；列表用 webhook.list。入口 [Connect · Webhook](app:settings/webhooks)。不要说「软件没有 webhook」`
        : "",
      this.deps.tasks
        ? `- 入站 Webhook（外系统触发本 bot）：已开通 ${inbound.length} 个例行 · 用 task.create + webhook:true；POST JSON \`{"message":"…"}\` 注入对话。普通等当前轮结束；\`priority:"urgent"\` 或头 X-Harness-Priority:urgent 可打断并通知。触发 URL 让用户到例行面板 🪝 复制（需 [入站网关](app:settings/gateway)）`
        : "",
      `- bot 内部浏览器：browser.open / goto / snapshot / click / type / keys / read / stop。每个 bot 一块，登录态按 bot 隔离；不是用户 Chrome，也不是电脑操控`,
      `- 电脑操控（内置）：用 mcp:computer/macos_snapshot 看界面元素，再用 macos_act / macos_click / macos_type 等操作；先 mcp:computer/macos_doctor 检查辅助功能与屏幕录制权限。本机 App 用它；网页登录用 browser.*。不要说「没有 computer use」`,
    ].filter(Boolean);
    const brief = [
      `群聊 ${groups.length} 个${groups.length ? `（${groups.map((g) => g.name).join("、")}）` : ""}`,
      `定时任务 ${tasks.length} 个`,
      `项目 ${facts.projects.length} 个`,
      `技能 ${skills.length} 个`,
      `MCP ${mcps.length} 个`,
      this.deps.connectors ? `出站Webhook ${hooks.length} 个` : "",
      this.deps.tasks ? `入站Webhook例行 ${inbound.length} 个` : "",
    ].filter(Boolean).join("，");
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
