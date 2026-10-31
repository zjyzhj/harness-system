import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import { MemorySystem } from "../core/memory-system";
import { SkillRegistry } from "../core/skill-registry";
import { BotRuntime } from "../core/bot-runtime";
import { attachPetEntertainment, type PetHost } from "../core/pet";
import { ProviderCenter } from "../core/provider-center";
import type { Bot, ContentBlock } from "../core/types";

const tool = (name: string, args: object = {}) => "```tool\n" + JSON.stringify({ tool: name, args }) + "\n```";

function setup(script: string[], opts?: { maySpawn?: boolean; mayVisit?: boolean; petA?: boolean }) {
  const home = mkdtempSync(join(tmpdir(), "harness-pet-tools-"));
  const store = new Store(home);
  let i = 0;
  class P extends ProviderCenter {
    override async streamComplete(_p: any, req: any): Promise<any> {
      const text = script[Math.min(i++, script.length - 1)];
      req._onChunk({ type: "text", text });
      return { text, content: [{ type: "text", text }] };
    }
  }
  const providers = new P(store);
  providers.addProvider({ kind: "openai-compat", name: "默认", baseUrl: "https://fake/v1", apiKey: "x", model: "m", isDefault: true });
  const mk = (id: string, name: string, pet = false): Bot => ({
    id, name, role: "助手", persona: "", providerId: "", petEnabled: pet, skinId: "live2d-hiyori", createdAt: Date.now(),
  });
  const a = mk("a", "阿A", opts?.petA !== false);
  const b = mk("b", "阿B", false);
  store.saveBot(a);
  store.saveBot(b);
  store.savePet({ botId: "a", x: 1, y: 2, visible: true, xp: 100 });

  const shown = new Set<string>(a.petEnabled ? ["a"] : []);
  const skins = [
    { id: "live2d-hiyori", name: "Hiyori" },
    { id: "live2d-haru", name: "Haru" },
  ];
  let currentSkin = "live2d-hiyori";
  const catalog = [
    { slug: "guga-2", name: "咕嘎", id: "pd-guga-2", installed: false },
    { slug: "doro-5", name: "Doro 卫衣", id: "pd-doro-5", installed: false },
  ];
  let prevSkin: string | undefined;
  const evolves = [
    { id: "e1", title: "更简洁", detail: "先给结论", status: "pending", kind: "habit", createdAt: 1, botId: "a" },
  ];
  const visits = [
    { fromId: "a", toId: "b", fromName: "阿A", toName: "阿B", lineFrom: "去找阿B", lineTo: "阿A来了", at: Date.now() },
  ];
  const prefState: Record<string, unknown> = { companionChat: false, proactiveFollowup: false, idleWork: false, autoAppearance: false, agentMaySpawn: false, selfEvolve: false, autoEvolve: false, petVisit: false, idleMinutes: 45, maxChatPerDay: 4, maxWorkPerDay: 2, maxAppearPerWeek: 1 };

  const host: PetHost = {
      show: (id) => { shown.add(id); },
      hide: (id) => { shown.delete(id); },
      skinLabel: () => skins.find((s) => s.id === currentSkin)?.name || currentSkin,
      isShown: (id) => shown.has(id),
      xp: (id) => store.listPets().find((p) => p.botId === id)?.xp ?? 0,
      listSkins: () => skins,
      setSkin: (id, skinId) => {
        const hit = skins.find((s) => s.id === skinId);
        if (!hit) return { ok: false as const, error: "无此皮肤" };
        prevSkin = currentSkin;
        currentSkin = skinId;
        const bot = store.getBot(id)!;
        store.saveBot({ ...bot, skinId, prevSkinId: prevSkin });
        return { ok: true as const, label: hit.name };
      },
      revertSkin: (id) => {
        const bot = store.getBot(id)!;
        if (!bot.prevSkinId && !prevSkin) return { ok: false as const, error: "没有可恢复的上一套形象" };
        const back = bot.prevSkinId || prevSkin!;
        const label = skins.find((s) => s.id === back)?.name || back;
        currentSkin = back;
        store.saveBot({ ...bot, skinId: back, prevSkinId: undefined });
        return { ok: true as const, label };
      },
      generatePersona: async (_id, desc) => ({
        ok: true as const,
        name: desc.slice(0, 8) || "新形象",
        message: `未配置生图，已更新角色卡（${desc.slice(0, 12)}）`,
        imaged: false,
        suggestions: [{ kind: "live2d", id: "live2d-hiyori", name: "日和" }],
      }),
      disable: (id) => {
        const bot = store.getBot(id)!;
        store.saveBot({ ...bot, petEnabled: false });
        shown.delete(id);
      },
      prefs: () => ({ ...prefState }),
      setPrefs: (_id, patch) => { Object.assign(prefState, patch); return { ...prefState }; },
      evolveList: (_id, mode) => mode === "pending" ? evolves.filter((e) => e.status === "pending") : evolves,
      evolveDecide: (_id, action, id) => {
        const e = id ? evolves.find((x) => x.id === id) : evolves.find((x) => x.status === "pending");
        if (!e || e.status !== "pending") return { ok: false as const, error: "没有待确认的进化提议" };
        e.status = action === "accept" ? "accepted" : "rejected";
        return { ok: true as const, title: e.title, status: e.status };
      },
      visitHistory: () => visits,
      remind: (_id, delayMs, text) => ({ ok: true as const, at: Date.now() + delayMs, text } as any),
      searchCatalog: async (query) => {
        const q = query.trim().toLowerCase();
        if (!q) return catalog;
        return catalog.filter((c) => c.name.includes(query) || c.slug.includes(q));
      },
      installCatalog: async (slug, o) => {
        const hit = catalog.find((c) => c.slug === slug || c.name === slug || c.name.includes(slug));
        if (!hit) return { ok: false as const, error: `找不到 ${slug}` };
        if (!skins.find((s) => s.id === hit.id)) skins.push({ id: hit.id, name: hit.name });
        hit.installed = true;
        let worn = false;
        if (o?.wearBotId) {
          prevSkin = currentSkin;
          currentSkin = hit.id;
          const bot = store.getBot(o.wearBotId)!;
          store.saveBot({ ...bot, skinId: hit.id, prevSkinId: prevSkin });
          worn = true;
        }
        return { ok: true as const, id: hit.id, label: hit.name, worn };
      },
      maySpawn: () => opts?.maySpawn === true,
      mayVisit: () => opts?.mayVisit === true,
      visit: (fromId, toId) => ({ ok: true as const, line: `${fromId}->${toId}` }),
      act: (_id, action) => ({ ok: true as const, action }),
      say: (_id, text) => ({ ok: true as const, echoed: text } as any),
      fx: async (_id, args) => {
        if ((args.action || "play") === "list") {
          return { ok: true as const, message: "特效列表", list: [{ id: "fx-kamehameha", name: "龟派气功", kind: "builtin", useCount: 1 }] };
        }
        const given = (args.phrase || args.name || "").trim();
        const phrase = given || "星屑雨";
        return {
          ok: true as const,
          message: `已放出「${phrase}」${given ? "" : "（你没起名，我用了「星屑雨」）"}`,
          effect: { id: "fx-x", name: phrase, kind: "custom", created: true },
        };
      },
    };
  const rt = new BotRuntime({
    store,
    providers,
    memory: new MemorySystem(home),
    skills: new SkillRegistry(join(home, "skills")),
  });
  attachPetEntertainment(rt, { store, host });

  const result = (r: { content?: ContentBlock[] }, name: string) =>
    (r.content?.find((x) => x.type === "tool_call" && (x as any).tool === name) as any)?.result as string;

  return {
    rt, a, b, store, shown, result,
    getSkin: () => currentSkin,
    revert: () => {
      if (!prevSkin) return { ok: false as const, error: "没有可恢复的上一套形象" };
      const label = skins.find((s) => s.id === prevSkin)?.name || prevSkin;
      const back = prevSkin;
      currentSkin = back;
      prevSkin = undefined;
      const bot = store.getBot("a")!;
      store.saveBot({ ...bot, skinId: back, prevSkinId: undefined });
      return { ok: true as const, label };
    },
  };
}

describe("Bot 操作桌宠", () => {
  test("pet.status 描述自己", async () => {
    const { rt, a, result } = setup([tool("pet.status"), "好"]);
    const r = await rt.handleStream({ bot: a, from: "user", text: "状态", sessionId: "s1" }, { onBlock: () => {} });
    expect(result(r, "pet.status")).toContain("阿A");
    expect(result(r, "pet.status")).toContain("XP");
  });

  test("pet.list 列出上台；all 含未上台", async () => {
    const on = setup([tool("pet.list", {}), "好"]);
    const r1 = await on.rt.handleStream({ bot: on.a, from: "user", text: "有哪些宠物", sessionId: "s1b" }, { onBlock: () => {} });
    expect(on.result(r1, "pet.list")).toContain("阿A");
    expect(on.result(r1, "pet.list")).not.toContain("阿B");

    const all = setup([tool("pet.list", { all: true }), "好"]);
    const r2 = await all.rt.handleStream({ bot: all.a, from: "user", text: "全部宠物", sessionId: "s1c" }, { onBlock: () => {} });
    expect(all.result(r2, "pet.list")).toContain("阿B");
    expect(all.result(r2, "pet.list")).toMatch(/未上台|0\/|上台/);
  });

  test("pet.show 自己无需召唤开关", async () => {
    const { rt, a, store, result } = setup([tool("pet.show", {}), "好了"], { maySpawn: false, petA: false });
    expect(store.getBot("a")!.petEnabled).toBe(false);
    const r = await rt.handleStream({ bot: a, from: "user", text: "出来", sessionId: "s2" }, { onBlock: () => {} });
    expect(result(r, "pet.show")).toContain("出台");
    expect(store.getBot("a")!.petEnabled).toBe(true);
  });

  test("pet.show 别人受允许召唤闸门", async () => {
    const blocked = setup([tool("pet.show", { name: "阿B" }), "好"], { maySpawn: false });
    const r1 = await blocked.rt.handleStream({ bot: blocked.a, from: "user", text: "叫阿B", sessionId: "s3" }, { onBlock: () => {} });
    expect(blocked.result(r1, "pet.show")).toContain("允许召唤");

    const ok = setup([tool("pet.show", { name: "阿B" }), "好"], { maySpawn: true });
    const r2 = await ok.rt.handleStream({ bot: ok.a, from: "user", text: "叫阿B", sessionId: "s4" }, { onBlock: () => {} });
    expect(ok.result(r2, "pet.show")).toContain("阿B");
    expect(ok.store.getBot("b")!.petEnabled).toBe(true);
  });

  test("pet.skin 列表与换装", async () => {
    const list = setup([tool("pet.skin", {}), "好"]);
    const r1 = await list.rt.handleStream({ bot: list.a, from: "user", text: "有什么形象", sessionId: "s5" }, { onBlock: () => {} });
    expect(list.result(r1, "pet.skin")).toContain("Hiyori");

    const change = setup([tool("pet.skin", { skin: "Haru" }), "换好了"]);
    const r2 = await change.rt.handleStream({ bot: change.a, from: "user", text: "换成 Haru", sessionId: "s6" }, { onBlock: () => {} });
    expect(change.result(r2, "pet.skin")).toContain("Haru");
    expect(change.getSkin()).toBe("live2d-haru");
  });

  test("pet.visit 受互访开关；pet.peers 列出上台伙伴", async () => {
    const off = setup([tool("pet.visit", { name: "阿B" }), "好"], { mayVisit: false, maySpawn: true });
    off.store.saveBot({ ...off.b, petEnabled: true });
    const r1 = await off.rt.handleStream({ bot: off.a, from: "user", text: "拜访", sessionId: "s7" }, { onBlock: () => {} });
    expect(off.result(r1, "pet.visit")).toContain("多宠互访");

    const peers = setup([tool("pet.peers"), "好"], { mayVisit: true });
    peers.store.saveBot({ ...peers.b, petEnabled: true });
    const r2 = await peers.rt.handleStream({ bot: peers.a, from: "user", text: "谁在", sessionId: "s8" }, { onBlock: () => {} });
    expect(peers.result(r2, "pet.peers")).toContain("阿B");

    const visit = setup([tool("pet.visit", { name: "阿B" }), "去了"], { mayVisit: true, maySpawn: true });
    visit.store.saveBot({ ...visit.b, petEnabled: true });
    const r3 = await visit.rt.handleStream({ bot: visit.a, from: "user", text: "拜访阿B", sessionId: "s9" }, { onBlock: () => {} });
    expect(visit.result(r3, "pet.visit")).toContain("a->b");
  });

  test("pet.search / pet.install 下载并加入列表", async () => {
    const search = setup([tool("pet.search", { query: "咕嘎" }), "好"]);
    const r1 = await search.rt.handleStream({ bot: search.a, from: "user", text: "搜咕嘎", sessionId: "s11" }, { onBlock: () => {} });
    expect(search.result(r1, "pet.search")).toContain("咕嘎");
    expect(search.result(r1, "pet.search")).toContain("guga-2");

    const inst = setup([tool("pet.install", { slug: "guga-2" }), "装好了"]);
    const r2 = await inst.rt.handleStream({ bot: inst.a, from: "user", text: "下载咕嘎", sessionId: "s12" }, { onBlock: () => {} });
    expect(inst.result(r2, "pet.install")).toContain("咕嘎");
    expect(inst.result(r2, "pet.install")).toContain("加入形象列表");
    expect(inst.getSkin()).toBe("pd-guga-2");

    const only = setup([tool("pet.install", { name: "Doro 卫衣", wear: false }), "好"]);
    const r3 = await only.rt.handleStream({ bot: only.a, from: "user", text: "只要入库", sessionId: "s13" }, { onBlock: () => {} });
    expect(only.result(r3, "pet.install")).toContain("未换装");
    expect(only.getSkin()).toBe("live2d-hiyori");
  });

  test("pet.skin 本地没有时自动尝试下载", async () => {
    const { rt, a, result, getSkin } = setup([tool("pet.skin", { skin: "咕嘎" }), "好"]);
    const r = await rt.handleStream({ bot: a, from: "user", text: "换成咕嘎", sessionId: "s14" }, { onBlock: () => {} });
    expect(result(r, "pet.skin")).toContain("下载");
    expect(getSkin()).toBe("pd-guga-2");
  });

  test("pet.hide 藏起自己", async () => {
    const { rt, a, shown, result } = setup([tool("pet.hide", {}), "藏好了"]);
    expect(shown.has("a")).toBe(true);
    const r = await rt.handleStream({ bot: a, from: "user", text: "藏起来", sessionId: "s10" }, { onBlock: () => {} });
    expect(result(r, "pet.hide")).toContain("藏起");
    expect(shown.has("a")).toBe(false);
  });

  test("pet.generate / evolve / prefs / visits / disable / remind", async () => {
    const gen = setup([tool("pet.generate", { desc: "戴耳机橘猫" }), "好"]);
    const rg = await gen.rt.handleStream({ bot: gen.a, from: "user", text: "生成", sessionId: "s24" }, { onBlock: () => {} });
    expect(gen.result(rg, "pet.generate")).toContain("戴耳机");

    const ev = setup([tool("pet.evolve", { action: "list" }), "好"]);
    const re = await ev.rt.handleStream({ bot: ev.a, from: "user", text: "进化", sessionId: "s25" }, { onBlock: () => {} });
    expect(ev.result(re, "pet.evolve")).toContain("更简洁");
    const ev2 = setup([tool("pet.evolve", { action: "accept" }), "好"]);
    const re2 = await ev2.rt.handleStream({ bot: ev2.a, from: "user", text: "接受", sessionId: "s26" }, { onBlock: () => {} });
    expect(ev2.result(re2, "pet.evolve")).toContain("已接受");

    const pf = setup([tool("pet.prefs", { action: "set", companionChat: true }), "好"]);
    const rp = await pf.rt.handleStream({ bot: pf.a, from: "user", text: "活泼", sessionId: "s27" }, { onBlock: () => {} });
    expect(pf.result(rp, "pet.prefs")).toContain("companionChat=true");

    const vs = setup([tool("pet.visits"), "好"]);
    const rv = await vs.rt.handleStream({ bot: vs.a, from: "user", text: "拜访记录", sessionId: "s28" }, { onBlock: () => {} });
    expect(vs.result(rv, "pet.visits")).toContain("阿B");

    const rm = setup([tool("pet.remind", { in: "10m", text: "喝水" }), "好"]);
    const rr = await rm.rt.handleStream({ bot: rm.a, from: "user", text: "提醒", sessionId: "s29" }, { onBlock: () => {} });
    expect(rm.result(rr, "pet.remind")).toContain("喝水");

    const dis = setup([tool("pet.disable"), "好"]);
    const rd = await dis.rt.handleStream({ bot: dis.a, from: "user", text: "下台", sessionId: "s30" }, { onBlock: () => {} });
    expect(dis.result(rd, "pet.disable")).toContain("下台");
    expect(dis.store.getBot("a")!.petEnabled).toBe(false);
  });

  test("pet.act / pet.fx", async () => {
    const act = setup([tool("pet.act", { action: "jump", hold: 2 }), "好"]);
    const ra = await act.rt.handleStream({ bot: act.a, from: "user", text: "跳", sessionId: "s40" }, { onBlock: () => {} });
    expect(act.result(ra, "pet.act")).toContain("jump");

    const fx = setup([tool("pet.fx", { phrase: "龟派气功" }), "喝"]);
    const rf = await fx.rt.handleStream({ bot: fx.a, from: "user", text: "气功", sessionId: "s41" }, { onBlock: () => {} });
    expect(fx.result(rf, "pet.fx")).toContain("龟派气功");

    const list = setup([tool("pet.fx", { action: "list" }), "好"]);
    const rl = await list.rt.handleStream({ bot: list.a, from: "user", text: "特效", sessionId: "s42" }, { onBlock: () => {} });
    expect(list.result(rl, "pet.fx")).toContain("龟派气功");

    // 空 phrase：即兴起名，不再报「需要 phrase」
    const improv = setup([tool("pet.fx", {}), "好"]);
    const ri = await improv.rt.handleStream({ bot: improv.a, from: "user", text: "现场发明特效配方", sessionId: "s43" }, { onBlock: () => {} });
    const out = improv.result(ri, "pet.fx");
    expect(out).not.toContain("需要 phrase");
    expect(out).toMatch(/已放出|星屑雨|即兴/);
  });

  test("换装后再换回去", async () => {
    const s = setup([tool("pet.skin", { skin: "Haru" }), "ok"]);
    await s.rt.handleStream({ bot: s.a, from: "user", text: "换Haru", sessionId: "s31" }, { onBlock: () => {} });
    expect(s.getSkin()).toBe("live2d-haru");
    expect(s.revert().ok).toBe(true);
    expect(s.getSkin()).toBe("live2d-hiyori");

    // 从未换过 → 无可恢复
    const u = setup([tool("pet.skin", { revert: true }), "好"]);
    const ru = await u.rt.handleStream({ bot: u.a, from: "user", text: "换回去", sessionId: "s33" }, { onBlock: () => {} });
    expect(u.result(ru, "pet.skin")).toContain("没有可恢复");
  });
});
