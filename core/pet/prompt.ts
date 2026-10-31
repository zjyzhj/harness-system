/**
 * 桌宠提示词片段 — 仅 entertain 侧车注入；Bot 默认 system 不含本节。
 */
import type { Bot } from "../types";
import type { PetHost } from "./host-port";

/** 用户这轮是否在谈桌宠（决定要不要附操作手册） */
export function isPetTopic(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  return /宠物|桌宠|形象|换装|换皮|皮肤|串门|拜访|出台|下台|藏起来|Live2D|petdex|咕嘎|奶龙|进化提议|桌面宠物|龟派|气功|特效|配方|发明特效|pet\.(show|hide|skin|list|status|visit|install|search|generate|evolve|remind|mind|activity|act|fx)/i.test(t);
}

/** 稳定前缀里一行桌宠事实（省 token + 利缓存） */
export function petSelfBrief(bot: Bot, host: PetHost): string {
  const skin = host.skinLabel(bot.id) || bot.skinId || "默认";
  const shown = host.isShown?.(bot.id);
  const stage = !bot.petEnabled ? "未上台" : shown === false ? "已上台但窗口藏着" : "在桌面";
  return `【桌宠·娱乐】你当前${stage}；形象「${skin}」。桌宠是娱乐侧车，不干扰工作任务。用户问外形/在不在桌面时按这里说；操作手册仅在谈桌宠时附上。`;
}

/** 仅在用户这轮像在谈桌宠时注入 */
export function petPlaybook(bot: Bot, host: PetHost): string {
  const maySpawn = host.maySpawn() === true;
  const mayVisit = host.mayVisit?.() === true;
  return [
    "【桌宠操作 · 纯娱乐】桌宠表演/串门/换装不代替真正干活；用户要做事时用正常工具，不要用 pet.act/fx 糊弄。",
    "查：pet.status / list / peers / prefs / visits / mind（心智只读）/ activity（自主行动日志）；进化 pet.evolve action=list|history|accept|reject。",
    "形象：pet.skin / pet.search→install。pet.generate：有生图才画头像；没有则只改角色卡并换已有 Live2D/社区皮，绝不伪造占位图——做不到就照工具结果如实说。",
    "动作：pet.act action=jump|walk|sleep|celebrate|think|work；pet.say text=… 冒泡。",
    "特效：pet.fx 必带 phrase（有画面感的短名，如「龟派气功」「星屑雨」）。用户只说「发明特效」没起名时，你先自己起一个再调用，不要空着调。有相近则复用并说明；否则现场发明配方并记住。list / pin / forget / gc；不改皮肤。",
    "上台：pet.show / hide（藏窗）/ disable（彻底下台）；pet.remind in=30m text=… 纯气泡闹钟。",
    maySpawn
      ? "允许召唤已开：可 pet.show/hide/disable 别人、pet.create。"
      : "未开「允许召唤」：只操作自己，不要 pet.create / 对别人 show。",
    mayVisit
      ? "互访已开：pet.peers → pet.visit(name)。"
      : "未开「多宠互访」：不要 pet.visit。",
  ].join("\n");
}
