/**
 * 桌宠工具实现 — 娱乐侧车专用；不进入 BotRuntime 核心 switch。
 */
import type { Bot } from "../types";
import type { Store } from "../store";
import { defaultAvatar } from "../avatar";
import type { ToolOutcome } from "../tool-registry";
import type { PetHost } from "./host-port";

export interface PetToolDeps {
  store: Store;
  host: PetHost;
  onAppChanged?: (what: string) => void;
}

export async function runPetTool(
  bot: Bot,
  tool: string,
  args: Record<string, unknown>,
  deps: PetToolDeps,
): Promise<ToolOutcome> {
  const host = deps.host;
  const store = deps.store;
  const str = (k: string) => (args[k] === undefined || args[k] === null ? undefined : String(args[k]).trim());
  const find = (q: string) => {
    const all = store.listBots();
    return all.find((b) => b.name === q) ?? all.find((b) => b.id === q) ?? all.find((b) => b.name.includes(q) || q.includes(b.name));
  };
  const isSelfQuery = (q?: string) => !q || q === "me" || q === "自己" || q === bot.name || q === bot.id;
  const describe = (b: Bot) => {
    const skin = host.skinLabel(b.id);
    const shown = host.isShown?.(b.id);
    const xp = host.xp?.(b.id) ?? 0;
    const level = Math.floor(Math.sqrt(xp / 100)) + 1;
    const stage = !b.petEnabled ? "未上台" : shown === false ? "已上台但藏着" : shown === true ? "桌面可见" : (b.petEnabled ? "已上台" : "未上台");
    return `${b.name}：${stage}；形象「${skin}」；Lv.${level}（${xp} XP）`;
  };
  switch (tool) {
    case "pet.list": {
      // 全员桌宠一览（含未上台）；all=true 时列出全部 bot，否则默认只列已上台 + 自己
      const all = args.all === true || args.all === 1 || String(args.all ?? "") === "true";
      const bots = store.listBots();
      const rows = all
        ? bots
        : bots.filter((b) => b.petEnabled || b.id === bot.id);
      if (!rows.length) return { output: "还没有桌宠。用户可在 bot 详情打开「桌面宠物」，或对我说「出来」。" };
      const on = rows.filter((b) => b.petEnabled).length;
      return {
        output: [
          `【桌宠 ${on}/${bots.length} 上台】` + (all ? "（含未上台）" : "（仅上台+自己；要全员加 all:true）"),
          ...rows.map((b) => `- ${describe(b)}${b.id === bot.id ? "（你）" : ""}`),
        ].join("\n"),
      };
    }
    case "pet.status": {
      const q = str("name") ?? str("bot");
      if (q && !isSelfQuery(q)) {
        const target = find(q);
        if (!target) return { output: `找不到「${q}」` };
        return { output: describe(target) };
      }
      const peers = store.listBots().filter((b) => b.id !== bot.id && b.petEnabled);
      const lines = [describe(store.getBot(bot.id) || bot)];
      if (peers.length) lines.push(`其他上台：${peers.map((p) => p.name).join("、")}`);
      else lines.push("其他上台：无");
      const prefs = host.prefs?.(bot.id);
      if (prefs) {
        const on = (k: string, label: string) => prefs[k] ? label : null;
        const flags = [
          on("companionChat", "空闲搭话"), on("proactiveFollowup", "主动跟进"),
          on("idleWork", "空闲做事"), on("autoAppearance", "自动换装"),
          on("agentMaySpawn", "可召唤伙伴"), on("selfEvolve", "自进化"),
          on("petVisit", "互访"),
        ].filter(Boolean);
        lines.push(`智能开关：${flags.length ? flags.join("、") : "全关（仅基础桌宠）"}`);
      }
      const pending = host.evolveList?.(bot.id, "pending") ?? [];
      if (pending.length) lines.push(`待确认进化 ${pending.length} 条（pet.evolve action=list）`);
      lines.push("完整名单用 pet.list；只要上台伙伴用 pet.peers。");
      return { output: lines.join("\n") };
    }
    case "pet.peers": {
      const peers = store.listBots().filter((b) => b.id !== bot.id && b.petEnabled);
      if (!peers.length) return { output: "还没有其他上台的桌宠。" };
      return { output: peers.map((p) => describe(p)).join("\n") };
    }
    case "pet.skin": {
      const want = str("skin") ?? str("name") ?? str("id");
      const skins = host.listSkins?.() ?? [];
      if (want === "prev" || want === "revert" || want === "换回去" || want === "上一套" || args.revert === true) {
        if (!host.revertSkin) return { output: "❌ 换回未就绪" };
        const r = host.revertSkin(bot.id);
        if (!r.ok) return { output: `❌ ${r.error}` };
        deps.onAppChanged?.("bots");
        return { output: `已换回「${r.label}」` };
      }
      if (!want || want === "list" || want === "列表") {
        if (!skins.length) return { output: "本地还没有形象。用 pet.search 搜社区库，再 pet.install 下载。" };
        const cur = host.skinLabel(bot.id);
        return { output: `当前「${cur}」。本地已装：\n${skins.map((s) => `- ${s.name}（${s.id}）`).join("\n")}\n没有想要的可用 pet.search / pet.install 从 petdex 下载；换回去用 skin=prev。` };
      }
      if (!host.setSkin) return { output: "❌ 换装未就绪" };
      const hit = skins.find((s) => s.id === want || s.name === want)
        ?? skins.find((s) => s.name.includes(want) || want.includes(s.name));
      if (!hit) {
        // 本地没有 → 引导搜库 / 直接尝试安装
        if (host.installCatalog) {
          const inst = await host.installCatalog(want, { wearBotId: bot.id });
          if (inst.ok) {
            deps.onAppChanged?.("bots");
            return { output: `本地没有「${want}」，已从 petdex 下载「${inst.label}」并换上（已加入形象列表）。` };
          }
          return { output: `本地没有「${want}」。${inst.error} 可先 pet.search query="${want}" 看看有没有近似的。` };
        }
        return { output: `找不到形象「${want}」。先 pet.skin 看本地列表，或 pet.search / pet.install 从社区下载。` };
      }
      // 默认只给自己换；给别人换装等同「操作他人桌宠」，需召唤开关
      const whoQ = str("bot") ?? str("to");
      let target = bot;
      if (whoQ && !isSelfQuery(whoQ)) {
        if (!host.maySpawn()) return { output: "❌ 给其他桌宠换装需要打开「允许召唤/创建桌宠」" };
        const t = find(whoQ);
        if (!t) return { output: `找不到「${whoQ}」` };
        target = t;
      }
      const r = host.setSkin(target.id, hit.id);
      if (!r.ok) return { output: `❌ ${r.error}` };
      deps.onAppChanged?.("bots");
      return { output: `已为 ${target.name} 换上「${r.label}」` };
    }
    case "pet.search": {
      if (!host.searchCatalog) return { output: "❌ 形象库搜索未就绪" };
      const q = str("query") ?? str("q") ?? str("name") ?? str("skin") ?? "";
      const rows = await host.searchCatalog(q);
      if (!rows.length) return { output: q ? `没搜到「${q}」。换个关键词，或去 petdex.dev 看看。` : "推荐列表为空。" };
      const head = q ? `搜「${q}」：` : "推荐形象：";
      return {
        output: [
          head,
          ...rows.map((r) => `- ${r.name}（slug: ${r.slug}${r.installed ? "，已安装" : ""}）`),
          "下载并加入列表：pet.install slug=…（默认换到自己身上；只要入库设 wear:false）",
        ].join("\n"),
      };
    }
    case "pet.install": {
      if (!host.installCatalog) return { output: "❌ 形象下载未就绪" };
      const slug = str("slug") ?? str("skin") ?? str("name") ?? str("query") ?? "";
      if (!slug) return { output: "pet.install 需要 slug 或 name（可先 pet.search）" };
      const wearRaw = args.wear;
      const wear = wearRaw === false || wearRaw === "false" || wearRaw === 0 ? false : true;
      const r = await host.installCatalog(slug, { name: str("label") ?? str("displayName"), wearBotId: wear ? bot.id : undefined });
      if (!r.ok) return { output: `❌ ${r.error}` };
      deps.onAppChanged?.("bots");
      return {
        output: r.worn
          ? `已下载「${r.label}」加入形象列表，并换到自己身上。`
          : `已下载「${r.label}」加入形象列表（未换装；要穿上用 pet.skin skin="${r.label}"）。`,
      };
    }
    case "pet.show": {
      const q = str("name") ?? str("bot");
      // 自己出台 = 基础能力，不需要「允许召唤」
      if (isSelfQuery(q)) {
        const me = store.getBot(bot.id) || bot;
        store.saveBot({ ...me, petEnabled: true });
        host.show(me.id);
        deps.onAppChanged?.("bots");
        return { output: "我已出台到桌面。" };
      }
      if (!host.maySpawn()) return { output: "❌ 用户已关闭「允许召唤/创建桌宠」；我只能操作自己的桌宠。" };
      const target = find(q!);
      if (!target) return { output: `找不到「${q}」。现有：${store.listBots().map((b) => b.name).join("、")}` };
      store.saveBot({ ...target, petEnabled: true });
      host.show(target.id);
      deps.onAppChanged?.("bots");
      return { output: `已让 [${target.name}](app:bot/${encodeURIComponent(target.name)}) 出台桌宠` };
    }
    case "pet.hide": {
      const q = str("name") ?? str("bot");
      if (isSelfQuery(q)) {
        host.hide(bot.id);
        return { output: "已暂时藏起自己（没有关掉桌宠，托盘「全部显示」可回来）" };
      }
      if (!host.maySpawn()) return { output: "❌ 藏起其他桌宠需要打开「允许召唤/创建桌宠」" };
      const target = find(q!);
      if (!target) return { output: `找不到「${q}」` };
      host.hide(target.id);
      return { output: `已暂时藏起 ${target.name}` };
    }
    case "pet.disable": {
      if (!host.disable) return { output: "❌ 下台未就绪" };
      const q = str("name") ?? str("bot");
      if (!isSelfQuery(q)) {
        if (!host.maySpawn()) return { output: "❌ 关掉其他桌宠需要打开「允许召唤/创建桌宠」" };
        const target = find(q!);
        if (!target) return { output: `找不到「${q}」` };
        host.disable(target.id);
        deps.onAppChanged?.("bots");
        return { output: `已关闭 ${target.name} 的桌宠（彻底下台，不是藏起来）` };
      }
      host.disable(bot.id);
      deps.onAppChanged?.("bots");
      return { output: "已关闭自己的桌宠（彻底下台）。要再出台用 pet.show。" };
    }
    case "pet.generate": {
      if (!host.generatePersona) return { output: "❌ 形象生成未就绪" };
      const desc = str("desc") ?? str("prompt") ?? str("text") ?? "";
      if (!desc) return { output: "pet.generate 需要 desc（一句话描述，如「戴耳机的橘猫」）" };
      const r = await host.generatePersona(bot.id, desc, str("style") ?? undefined);
      if (!r.ok) return { output: `❌ ${r.error}` };
      deps.onAppChanged?.("bots");
      // 诚实回报：有图 / 换了皮 / 只改了卡；绝不假装「画出来了」
      const extra = r.suggestions?.length
        ? `\n其它可选项：${r.suggestions.map((s) => `${s.name}(${s.kind})`).join("、")}`
        : "";
      return { output: `${r.message}${extra}` };
    }
    case "pet.prefs": {
      const action = (str("action") ?? str("op") ?? "get").toLowerCase();
      if (action === "get" || action === "list" || action === "read") {
        const p = host.prefs?.(bot.id);
        if (!p) return { output: "❌ 偏好未就绪" };
        const line = (k: string, label: string) => `- ${label}：${p[k] ? "开" : "关"}`;
        return {
          output: [
            "【对本宠生效的智能偏好】（全局默认 ⊕ 单宠覆盖）",
            line("companionChat", "空闲搭话"),
            line("proactiveFollowup", "主动跟进"),
            line("idleWork", "空闲做事"),
            line("autoAppearance", "自动换装"),
            line("agentMaySpawn", "允许召唤伙伴"),
            line("selfEvolve", "自进化提议"),
            line("autoEvolve", "自动接受进化"),
            line("petVisit", "多宠互访"),
            `节奏：空闲 ${p.idleMinutes} 分钟才开口；每天最多搭话 ${p.maxChatPerDay} / 做事 ${p.maxWorkPerDay}；每周自动换装 ${p.maxAppearPerWeek}`,
            "改自己节奏：pet.prefs action=set companionChat=false（只影响你）；进阶总开关请用户去设置页开。",
          ].join("\n"),
        };
      }
      if (action === "set" || action === "patch") {
        if (!host.setPrefs) return { output: "❌ 偏好写入未就绪" };
        const patch: Record<string, unknown> = {};
        const boolKeys = ["companionChat", "proactiveFollowup", "idleWork", "autoAppearance", "agentMaySpawn", "selfEvolve", "autoEvolve", "petVisit"] as const;
        for (const k of boolKeys) {
          if (args[k] === undefined) continue;
          patch[k] = args[k] === true || args[k] === "true" || args[k] === 1;
        }
        for (const k of ["idleMinutes", "maxChatPerDay", "maxWorkPerDay", "maxAppearPerWeek"] as const) {
          if (args[k] === undefined) continue;
          const n = Number(args[k]);
          if (Number.isFinite(n)) patch[k] = n;
        }
        if (!Object.keys(patch).length) return { output: "没有可写的字段。例：companionChat=false 或 idleMinutes=60" };
        // 进阶总闸门：bot 只允许改节奏类；开关类里 companion/idle/appear 可以，spawn/visit/evolve 建议用户去设置
        const locked = ["agentMaySpawn", "selfEvolve", "autoEvolve", "petVisit"].filter((k) => k in patch);
        for (const k of locked) delete patch[k];
        if (!Object.keys(patch).length) {
          return { output: "召唤/互访/自进化请用户在「桌面宠物智能」里开；我只能改自己的搭话/做事/换装节奏。" };
        }
        host.setPrefs(bot.id, patch);
        return { output: `已更新本宠偏好：${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join("、")}` };
      }
      return { output: "pet.prefs action 用 get 或 set" };
    }
    case "pet.evolve": {
      if (!host.evolveList || !host.evolveDecide) return { output: "❌ 进化未就绪" };
      const action = (str("action") ?? str("op") ?? "list").toLowerCase();
      if (action === "list" || action === "pending") {
        const rows = host.evolveList(bot.id, "pending");
        if (!rows.length) return { output: "没有待确认的进化提议。" };
        return {
          output: [
            "【待确认进化】",
            ...rows.map((r) => `- ${r.title}（${r.kind}，id=${r.id.slice(0, 8)}）\n  ${r.detail.slice(0, 100)}`),
            "接受：pet.evolve action=accept；拒绝：action=reject（可带 id）",
          ].join("\n"),
        };
      }
      if (action === "history" || action === "log") {
        const rows = host.evolveList(bot.id, "history");
        if (!rows.length) return { output: "还没有进化记录。" };
        const label: Record<string, string> = { pending: "待确认", accepted: "已接受", rejected: "已拒绝" };
        return {
          output: [
            "【进化历史】",
            ...rows.slice(0, 15).map((r) => `- [${label[r.status] || r.status}] ${r.title}`),
          ].join("\n"),
        };
      }
      if (action === "accept" || action === "reject") {
        const r = host.evolveDecide(bot.id, action, str("id") ?? undefined);
        if (!r.ok) return { output: `❌ ${r.error}` };
        deps.onAppChanged?.("bots");
        return { output: action === "accept" ? `已接受：${r.title}` : `已拒绝：${r.title}` };
      }
      return { output: "pet.evolve action 用 list / history / accept / reject" };
    }
    case "pet.visits": {
      if (!host.visitHistory) return { output: "❌ 拜访记录未就绪" };
      const rows = host.visitHistory(bot.id, 15);
      if (!rows.length) return { output: "还没有拜访记录。" };
      return {
        output: rows.map((r) => {
          const mine = r.fromId === bot.id;
          const when = new Date(r.at).toLocaleString();
          return `- ${mine ? "去找" : "来访"} ${mine ? r.toName : r.fromName}（${when}）：${mine ? r.lineFrom : r.lineTo}`;
        }).join("\n"),
      };
    }
    case "pet.remind": {
      if (!host.remind) return { output: "❌ 提醒未就绪" };
      const text = str("text") ?? str("message") ?? str("prompt") ?? "提醒";
      let delayMs = Number(args.delayMs ?? args.ms ?? 0);
      if (!delayMs) {
        const inn = str("in");
        if (inn) {
          const m = inn.match(/^(\d+)\s*(m|min|分钟|h|小时|s|秒)?$/i);
          if (m) {
            const n = Number(m[1]);
            const u = (m[2] || "m").toLowerCase();
            delayMs = /h|小时/.test(u) ? n * 3600_000 : /s|秒/.test(u) ? n * 1000 : n * 60_000;
          }
        }
      }
      if (!delayMs && args.minutes != null) delayMs = Number(args.minutes) * 60_000;
      if (!delayMs || delayMs < 5000) return { output: "pet.remind 需要 in（如 30m）或 minutes / delayMs，且至少 5 秒" };
      const r = host.remind(bot.id, delayMs, text);
      if (!r.ok) return { output: `❌ ${r.error}` };
      const mins = Math.round(delayMs / 60_000);
      return { output: `好，大约 ${mins < 1 ? "不到 1 分钟" : mins + " 分钟"}后我会在桌面提醒你：${text}` };
    }
    case "pet.create": {
      if (!host.maySpawn()) return { output: "❌ 用户已关闭「允许召唤/创建桌宠」" };
      const name = str("name");
      if (!name) return { output: "pet.create 需要 name" };
      if (store.listBots().some((b) => b.name === name)) {
        const existing = store.listBots().find((b) => b.name === name)!;
        store.saveBot({ ...existing, petEnabled: true });
        host.show(existing.id);
        deps.onAppChanged?.("bots");
        return { output: `已有叫「${name}」的 bot，已帮它出台` };
      }
      const id = `bot-${Date.now().toString(36)}`;
      const nb: Bot = {
        id, name,
        role: str("role") ?? "桌宠伙伴",
        persona: str("persona") ?? "友好、会陪伴用户",
        providerId: bot.providerId || "",
        petEnabled: true,
        avatar: defaultAvatar(id),
        createdAt: Date.now(),
      };
      store.saveBot(nb);
      host.show(id);
      deps.onAppChanged?.("bots");
      return { output: `已创建桌宠 [${name}](app:bot/${encodeURIComponent(name)}) 并出台` };
    }
    case "pet.visit": {
      if (host.mayVisit && !host.mayVisit()) return { output: "❌ 用户已关闭「多宠互访」" };
      if (!host.visit) return { output: "❌ 互访未就绪" };
      const q = str("name") ?? str("to") ?? str("bot") ?? "";
      if (!q) return { output: "pet.visit 需要 name（要去拜访的伙伴）" };
      const target = find(q);
      if (!target) return { output: `找不到「${q}」` };
      if (!target.petEnabled) {
        if (!host.maySpawn()) return { output: `「${target.name}」还没上台，且不允许自动召唤` };
        store.saveBot({ ...target, petEnabled: true });
        host.show(target.id);
      }
      // 自己也要上台才能串门
      const me = store.getBot(bot.id) || bot;
      if (!me.petEnabled) {
        store.saveBot({ ...me, petEnabled: true });
        host.show(me.id);
        deps.onAppChanged?.("bots");
      }
      const r = await host.visit(bot.id, target.id);
      return { output: r.ok ? r.line : `❌ ${r.error}` };
    }
    case "pet.mind": {
      if (!host.mind) return { output: "❌ 心智投影未就绪" };
      const q = str("name") ?? str("bot");
      const target = q && !isSelfQuery(q) ? find(q) : bot;
      if (!target) return { output: `找不到「${q}」` };
      const r = host.mind(target.id);
      if (!r.ok) return { output: `❌ ${r.error}` };
      return { output: `【桌宠心智 · 娱乐只读】\n${r.prompt}` };
    }
    case "pet.activity": {
      if (!host.activity) return { output: "❌ 活动日志未就绪" };
      const q = str("name") ?? str("bot");
      const targetId = q && !isSelfQuery(q) ? find(q)?.id : bot.id;
      const rows = host.activity(targetId, args.limit != null ? Number(args.limit) : 12);
      if (!rows.length) return { output: "还没有桌宠自主行动记录（娱乐向；开智能开关后才会有）。" };
      return {
        output: [
          "【桌宠活动 · 娱乐】",
          ...rows.map((a) => `- ${new Date(a.at).toLocaleString()} · ${a.via} · ${a.kind}${a.blocked ? "（未执行）" : ""}：${a.note}`),
        ].join("\n"),
      };
    }
    case "pet.act": {
      if (!host.act) return { output: "❌ 动作未就绪" };
      const action = (str("action") ?? str("act") ?? str("motion") ?? "").toLowerCase();
      if (!action) return { output: "pet.act 需要 action（idle/walk/jump/sleep/celebrate/work/think）；这是娱乐表演，不代替真正干活" };
      const hold = args.hold != null ? Number(args.hold) : args.seconds != null ? Number(args.seconds) : undefined;
      const r = host.act(bot.id, action, Number.isFinite(hold) ? hold : undefined);
      return { output: r.ok ? `已做娱乐动作：${r.action}` : `❌ ${r.error}` };
    }
    case "pet.say": {
      if (!host.say) return { output: "❌ 气泡说话未就绪" };
      const text = str("text") ?? str("message") ?? str("line") ?? "";
      if (!text) return { output: "pet.say 需要 text" };
      const r = host.say(bot.id, text, {
        title: str("title"),
        action: str("action") ?? undefined,
        holdSec: args.hold != null ? Number(args.hold) : undefined,
      });
      return { output: r.ok ? `已冒泡：${text.slice(0, 40)}` : `❌ ${r.error}` };
    }
    case "pet.fx": {
      if (!host.fx) return { output: "❌ 特效未就绪" };
      const action = (str("action") ?? str("op") ?? "play").toLowerCase();
      // phrase 别名；play 时空参交给 host 即兴起名，不再硬失败
      const phrase = str("phrase") ?? str("text") ?? str("fx") ?? str("name") ?? undefined;
      const r = await host.fx(bot.id, {
        action,
        phrase,
        name: str("name") ?? undefined,
        sticky: args.sticky === true || args.sticky === "true",
      });
      if (!r.ok) return { output: `❌ ${r.error}` };
      if (r.list?.length) {
        return {
          output: [
            r.message,
            ...r.list.slice(0, 20).map((e) => `- ${e.name}（${e.kind}${e.sticky ? ",钉住" : ""} · 用过${e.useCount}次）`),
          ].join("\n"),
        };
      }
      return { output: r.message };
    }
    default:
      return { output: `未知工具 ${tool}` };
  }
}

