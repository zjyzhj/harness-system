// 主控面板逻辑 — 通过 preload 暴露的 window.harness 调用 core
// 面板脚本按 index.html 里的顺序加载，共享同一个全局作用域：这里是状态、通用工具和消息渲染
const api = window.harness;
const $ = (s) => document.querySelector(s);

let bots = [];
let currentBot = null;
let currentSession = null;

let previews = {};
let currentGroup = null;
let groupList = [];
/** 深度思考开关（全局记住） */
let thinkMode = localStorage.getItem("harness.think") === "1";
/** 当前会话（或还没发出第一句的新会话）所属项目 */
let sessionProject = null;
let projectList = [];
/** 回复完自动朗读 */
let autoSpeak = localStorage.getItem("harness.autoSpeak") === "1";
/** 连续语音对话进行中 */
let voiceMode = false;
const liveStatus = {};
const lastSeen = JSON.parse(localStorage.getItem("harness.lastSeen") || "{}");
function markSeen(botId) {
  if (!botId) return;
  lastSeen[botId] = Date.now();
  localStorage.setItem("harness.lastSeen", JSON.stringify(lastSeen));
}

async function refreshBots() {
  [bots, previews, groupList] = await Promise.all([api.bots.list(), api.bots.previews().catch(() => ({})), api.groups.list().catch(() => [])]);
  for (const b of bots) if (lastSeen[b.id] === undefined) lastSeen[b.id] = previews[b.id]?.at ?? 0;
  if (currentBot) markSeen(currentBot.id);
  const recent = (b) => previews[b.id]?.at ?? b.createdAt ?? 0;
  bots.sort((a, b) => {
    if (!!a.isMaster !== !!b.isMaster) return a.isMaster ? -1 : 1;
    const ao = a.order ?? Infinity, bo = b.order ?? Infinity;
    if (ao !== bo) return ao - bo;
    return recent(b) - recent(a);
  });
  if (currentBot) currentBot = bots.find((b) => b.id === currentBot.id) ?? null;
  renderBotList();
  renderHero();
}

function avatarHtml(b, fallback = "🤖") {
  if (b?.avatarPath) return `<img src="${esc(fileUrl(b.avatarPath))}" />`;
  if (validAvatar(b?.avatar)) return blobAvatarSvg(b.avatar, b.id);
  return fallback;
}

/** 群聊里的发言只算群里忙：单聊入口（侧栏、标题、详情）不跟着动 */
function isBusy(botId, inGroup = false) {
  const st = liveStatus[botId];
  if (!st) return !!previews[botId]?.running;
  return st.state === "running" && (inGroup || !st.sessionId?.startsWith("group-"));
}

/** bot 在处理任务时，所有显示它头像的地方一起动 */
function syncBusyAvatars() {
  document.querySelectorAll("[data-av-bot]").forEach((el) => el.classList.toggle("busy", isBusy(el.dataset.avBot, "avGroup" in el.dataset)));
}

function renderHero() {
  const hero = $("#side-hero");
  const b = bots.find((x) => x.isMaster) ?? currentBot ?? bots[0];
  hero.innerHTML = b ? `<div class="hero-avatar${isBusy(b.id) ? " busy" : ""}" data-av-bot="${esc(b.id)}">${avatarHtml(b)}${b.isMaster ? '<span class="hero-badge" title="主控">★</span>' : ""}</div><div class="hero-name">${esc(b.name)}${b.isMaster ? " · 主控" : ""}</div>` : "";
  hero.classList.toggle("active", !!b && currentBot?.id === b.id);
  hero.onclick = b ? () => selectBot(b) : null;
}

function renderBotList() {
  const list = $("#bot-list");
  list.innerHTML = "";
  if (bots.length === 0) {
    list.innerHTML = `<div class="d-empty" style="padding:8px">还没有 bot，点右上角 ＋ 创建第一个</div>`;
    return;
  }
  for (const b of bots) {
    const pv = previews[b.id];
    const st = liveStatus[b.id];
    const running = isBusy(b.id);
    const unread = currentBot?.id !== b.id && (pv?.at ?? 0) > (lastSeen[b.id] ?? 0);
    const el = document.createElement("div");
    el.className = "bot-item" + (currentBot?.id === b.id ? " active" : "") + (unread ? " unread" : "");
    el.dataset.botId = b.id;
    el.innerHTML = `
      <div class="bot-avatar${running ? " busy" : ""}" data-av-bot="${esc(b.id)}">${avatarHtml(b)}${running ? '<span class="run-dot"></span>' : ""}</div>
      <div class="bot-meta">
        <div class="bot-name">${esc(b.name)} ${b.petEnabled ? '<span class="bot-pet-badge">🐾</span>' : ""}</div>
        <div class="bot-preview">${running ? `<span class="busy">正在处理${st?.currentTask ? `：${esc(st.currentTask)}` : "…"}</span>` : esc(pv?.text || b.role || "通用助手")}</div>
      </div>${unread ? '<span class="unread-dot"></span>' : ""}`;
    el.onclick = () => selectBot(b);
    el.oncontextmenu = (e) => { e.preventDefault(); botContextMenu(e, b); };
    el.draggable = true;
    el.ondragstart = (e) => { e.dataTransfer.setData("text/bot-id", b.id); e.dataTransfer.effectAllowed = "move"; el.classList.add("dragging"); };
    el.ondragend = () => { el.classList.remove("dragging"); list.querySelectorAll(".drop-before,.drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after")); };
    el.ondragover = (e) => {
      e.preventDefault();
      const after = e.offsetY > el.clientHeight / 2;
      el.classList.toggle("drop-after", after);
      el.classList.toggle("drop-before", !after);
    };
    el.ondragleave = () => el.classList.remove("drop-before", "drop-after");
    el.ondrop = (e) => {
      e.preventDefault();
      const dragId = e.dataTransfer.getData("text/bot-id");
      const after = el.classList.contains("drop-after");
      el.classList.remove("drop-before", "drop-after");
      if (dragId && dragId !== b.id) reorderBots(dragId, b.id, after);
    };
    list.appendChild(el);
  }
  renderGroupList(list);
}

function renderGroupList(list) {
  const head = document.createElement("div");
  head.className = "list-head";
  head.innerHTML = `<span>群聊</span><button class="list-add" title="新建 / 管理群聊">＋</button>`;
  head.querySelector(".list-add").onclick = (e) => { e.stopPropagation(); groupsFlow(); };
  list.appendChild(head);
  if (!groupList.length) {
    const tip = document.createElement("div");
    tip.className = "d-empty";
    tip.style.padding = "2px 10px 8px";
    tip.textContent = "拉几个 bot 建群，大家在同一个会话里轮流接话";
    list.appendChild(tip);
  }
  for (const g of groupList) {
    const members = g.members.map(botById).filter(Boolean);
    const relay = groupRelayOf(g.id);
    const speaking = relay ? members.find((m) => m.name === relay.speaker) : null;
    const shown = speaking ? [speaking, ...members.filter((m) => m !== speaking)] : members;
    const el = document.createElement("div");
    el.className = "bot-item" + (currentGroup?.id === g.id ? " active" : "");
    el.dataset.groupId = g.id;
    el.innerHTML = `
      <div class="group-avatars">${groupAvatarsHtml(shown)}${relay ? '<i class="run-dot"></i>' : ""}</div>
      <div class="bot-meta">
        <div class="bot-name">${esc(g.name)}</div>
        <div class="bot-preview">${relay ? `<span class="busy">${esc(relay.speaker || "成员")} 正在发言…</span>` : esc(members.map((m) => m.name).join("、") || "还没有成员")}</div>
      </div>`;
    el.onclick = () => selectGroup(g);
    list.appendChild(el);
  }
}

function groupAvatarsHtml(members) {
  return members.slice(0, 3).map((m) => `<span class="${isBusy(m.id, true) ? "busy" : ""}" data-av-bot="${esc(m.id)}" data-av-group>${avatarHtml(m)}</span>`).join("") || "<span>👥</span>";
}

/** 群里正在进行的接力（侧栏头像、标题跟着动） */
function groupRelayOf(groupId) {
  for (const p of relayState.values()) if (p.groupId === groupId && p.state !== "done") return p;
  return null;
}

async function selectGroup(g, sid) {
  currentGroup = g;
  currentBot = null;
  if (voiceMode) stopVoiceMode();
  renderComposerTools();
  if (!sid) {
    const { sessions } = await api.sessions.page({ botId: g.id, limit: 1 }).catch(() => ({ sessions: [] }));
    sid = sessions[0]?.id ?? `group-${g.id}`;
  }
  currentSession = sid;
  document.querySelectorAll(".bot-item").forEach((el) => el.classList.toggle("active", el.dataset.groupId === g.id));
  $("#empty-state").style.display = "none";
  $("#input").placeholder = `发到群聊「${g.name}」，成员会依次接话`;
  const title = $("#chat-title");
  title.innerHTML = `<span class="group-avatars t-group">${groupAvatarsHtml(g.members.map(botById).filter(Boolean))}</span>${esc(g.name)}`;
  $("#chat-bar").classList.remove("hidden");
  title.onclick = () => toggleDetails(true);
  renderHero();
  if (!$("#details").classList.contains("hidden") || (detailsPinned && window.innerWidth >= 1100)) toggleDetails(true);
  clearMessages();
  await loadSessionMessages(currentSession, true);
  renderRelayBar();
}

async function reorderBots(dragId, targetId, after) {
  const ids = bots.map((x) => x.id).filter((id) => id !== dragId);
  const at = ids.indexOf(targetId) + (after ? 1 : 0);
  ids.splice(at, 0, dragId);
  await Promise.all(ids.map((id, i) => (botById(id)?.order === i ? null : api.bots.update(id, { order: i }))));
  await refreshBots();
}

function botContextMenu(e, b) {
  document.querySelectorAll(".ctx-menu").forEach((m) => m.remove());
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.cssText = "position:fixed;z-index:99;background:#17171c;border:1px solid #333;border-radius:8px;padding:4px;min-width:140px;font-size:12.5px;box-shadow:0 8px 30px rgba(0,0,0,.5)";
  menu.style.left = Math.min(e.clientX, window.innerWidth - 160) + "px";
  menu.style.top = Math.min(e.clientY, window.innerHeight - 100) + "px";
  menu.innerHTML = `
    <div class="ctx-item" data-act="master">${b.isMaster ? "☆ 取消主控" : "★ 设为主控"}</div>
    <div class="ctx-item" data-act="detail">⋯ 详情 / 设置</div>
    <div class="ctx-item danger" data-act="delete" style="color:#ff6b6b">🗑 删除 bot</div>`;
  document.body.appendChild(menu);
  const close = () => { menu.remove(); document.removeEventListener("click", outside); };
  const outside = (ev) => { if (!ev.target.closest(".ctx-menu")) close(); };
  setTimeout(() => document.addEventListener("click", outside), 0);
  menu.querySelectorAll(".ctx-item").forEach((it) => {
    it.style.padding = "7px 12px";
    it.style.borderRadius = "6px";
    it.style.cursor = "pointer";
    it.onmouseenter = () => (it.style.background = "#23232a");
    it.onmouseleave = () => (it.style.background = "transparent");
    it.onclick = async () => {
      close();
      if (it.dataset.act === "detail") return botDetailFlow(b);
      if (it.dataset.act === "master") { await api.bots.update(b.id, { isMaster: !b.isMaster }); return refreshBots(); }
      if (!confirm(`确定删除「${b.name}」？宠物窗口会一并关闭，会话记录保留。`)) return;
      await api.bots.remove(b.id);
      if (currentBot?.id === b.id) {
        currentBot = null;
        currentSession = null;
        clearMessages();
        $("#empty-state").style.display = "";
        $("#chat-bar").classList.add("hidden");
        $("#details").classList.add("hidden");
        $("#details-mask")?.classList.add("hidden");
        document.body.classList.remove("details-open");
      }
      await refreshBots();
    };
  });
}

/** bot 之间的会话 id 是 b2b-<提问方>-<回答方>；返回提问方（当前 bot 是回答方时） */
const isB2b = (sid) => typeof sid === "string" && sid.startsWith("b2b-");
function b2bAsker(sid, selfId) {
  if (!isB2b(sid) || !sid.endsWith(`-${selfId}`)) return null;
  const fromId = sid.slice(4, -(selfId.length + 1));
  return bots.find((x) => x.id === fromId) ?? { id: fromId, name: "另一个 bot" };
}
/** 编排阶段、定时任务在后台自动跑出来的会话：能查看，但不当作和用户聊天的会话 */
const BG_SESSIONS = { "plan-": "🧩 编排计划里的一个阶段", "sched-": "⏰ 定时任务" };
const bgKind = (sid) => typeof sid === "string" ? Object.entries(BG_SESSIONS).find(([k]) => sid.startsWith(k))?.[1] ?? null : null;
const isOwnSession = (sid) => !isB2b(sid) && !bgKind(sid);
const isForeign = (sid) => !!sid && !isOwnSession(sid);
const sessionTitle = (x, botId) => {
  const asker = b2bAsker(x.id, botId);
  if (asker) return `🤝 ${esc(asker.name)} 来找它`;
  const bg = bgKind(x.id);
  return bg ? `${bg}：${esc(x.title || "")}` : esc(x.title || "新会话");
};
/** 打开 bot 时：自己的会话和别的 bot 来找它的会话里，哪个最近更新就打开哪个 */
function pickSession(sessions, botId) {
  return sessions.find((x) => isOwnSession(x.id) || b2bAsker(x.id, botId)) ?? null;
}
function b2bBanner(sid) {
  const asker = currentBot && b2bAsker(sid, currentBot.id);
  const bg = currentBot && bgKind(sid);
  if (!asker && !bg) return null;
  const el = document.createElement("div");
  el.className = "b2b-banner";
  const what = asker
    ? `🤝 这是 <b>${esc(asker.name)}</b> 来找 <b>${esc(currentBot.name)}</b> 的对话（bot 之间自动进行）`
    : `${bg.slice(0, 2)} 这是 <b>${esc(currentBot.name)}</b> 在${bg.slice(3)}里自动运行的记录`;
  el.innerHTML = `${what}。在这里发消息会回到你和 ${esc(currentBot.name)} 自己的会话。<button class="ghost-btn">回到我的会话</button>`;
  el.querySelector("button").onclick = () => openOwnSession();
  return el;
}
async function openOwnSession() {
  if (!currentBot) return;
  const { sessions } = await api.sessions.page({ botId: currentBot.id, limit: 30 });
  const own = sessions.find((x) => isOwnSession(x.id));
  currentSession = own?.id ?? null;
  clearMessages();
  if (own) await loadSessionMessages(own.id, true);
  if (detailsTab === "sessions") renderDetails(currentBot);
}

async function selectBot(b) {
  currentBot = b;
  currentGroup = null;
  currentSession = null;
  sessionProject = null;
  if (voiceMode) stopVoiceMode();
  renderComposerTools();
  markSeen(b.id);
  markActiveBot(b);
  clearMessages();
  // G1：会话分页（每 bot 最新 30 个）
  const { sessions } = await api.sessions.page({ botId: b.id, limit: 30 });
  if (currentBot?.id !== b.id) return;
  const latest = pickSession(sessions, b.id);
  setSending();
  if (latest) {
    currentSession = latest.id;
    await loadSessionMessages(latest.id, true);
  } else rememberView();
}

/** 记住上次打开的 bot / 群聊和会话，重开软件时直接回到那里 */
function rememberView() {
  const view = currentGroup ? { group: currentGroup.id, sid: currentSession } : currentBot ? { bot: currentBot.id, sid: currentSession } : null;
  if (view) localStorage.setItem("harness.lastView", JSON.stringify(view));
}

async function restoreView() {
  let view = null;
  try { view = JSON.parse(localStorage.getItem("harness.lastView") || "null"); } catch {}
  const g = view?.group && groupList.find((x) => x.id === view.group);
  if (g) {
    const s = view.sid && (await api.sessions.get(view.sid).catch(() => null));
    return selectGroup(g, s ? view.sid : undefined);
  }
  const bot = (view?.bot && botById(view.bot)) || bots.find((b) => b.isMaster) || bots[0];
  if (!bot) return;
  const s = bot.id === view?.bot && view.sid && (await api.sessions.get(view.sid).catch(() => null));
  if (!s) return selectBot(bot);
  await selectBot(bot);
  if (currentBot?.id === bot.id && currentSession !== view.sid) {
    currentSession = view.sid;
    await loadSessionMessages(view.sid, true);
  }
}

/** G1：加载会话消息（分页窗口，tail=最新 N 条；加载更早时 prepend） */
async function loadSessionMessages(sid, initial = false) {
  if (initial) rememberView();
  const r = await api.messages.page(sid, { limit: initial ? 40 : 40 });
  const box = $("#messages");
  if (initial) clearMessages();
  const banner = initial && b2bBanner(sid);
  if (banner) box.prepend(banner);
  // 若还有更早消息，顶部插「加载更早」
  const exists = box.querySelector(`[data-loadmore="${sid}"]`);
  if (exists) exists.remove();
  if (r.hasMore) {
    const btn = document.createElement("button");
    btn.className = "load-more-btn";
    btn.dataset.loadmore = sid;
    btn.textContent = "↑ 加载更早消息";
    btn.onclick = async () => {
      const older = await api.messages.page(sid, { limit: 40, beforeId: r.msgs[0]?.id });
      btn.remove();
      const frag = document.createDocumentFragment();
      older.msgs.forEach((m) => frag.appendChild(makeMsgEl(m)));
      box.prepend(frag);
      if (older.hasMore) {
        const btn2 = document.createElement("button");
        btn2.className = "load-more-btn";
        btn2.dataset.loadmore = sid;
        btn2.textContent = "↑ 加载更早消息";
        btn2.onclick = btn.onclick;
        btn2.dataset.before = older.msgs[0]?.id;
        box.prepend(btn2);
        btn2.onclick = (ev) => loadOlder(ev, sid);
      }
    };
    btn.onclick = btn.onclick;
    box.prepend(btn);
  }
  const els = r.msgs.map((m) => appendMsg(m));
  if (initial) {
    const info = await api.sessions.get(sid).catch(() => null);
    if (info?.summary) box.prepend(compactNote(info));
    sessionProject = info?.projectId ?? null;
    renderComposerTools();
  }
  const live = pending.get(sid);
  if (initial && live) live.nodes.forEach((n) => box.appendChild(n));
  const lastIdx = r.msgs.findLastIndex((m) => m.kind !== "event");
  const last = r.msgs[lastIdx];
  if (initial && !live && last?.role === "assistant" && last.meta?.suggestions) showSuggestions(els[lastIdx], last.meta.suggestions);
  if (initial) box.scrollTop = box.scrollHeight;
  setSending();
}

async function loadOlder(ev, sid) {
  const btn = ev.currentTarget;
  const before = Number(btn.dataset.before) || (() => {
    const first = box_first();
    return first ? first.dataset.id : undefined;
  })();
  const r = await api.messages.page(sid, { limit: 40, beforeId: before });
  btn.remove();
  const frag = document.createDocumentFragment();
  r.msgs.forEach((m) => frag.appendChild(makeMsgEl(m)));
  const box = $("#messages");
  box.prepend(frag);
  if (r.hasMore) {
    const btn2 = document.createElement("button");
    btn2.className = "load-more-btn";
    btn2.dataset.loadmore = sid;
    btn2.dataset.before = (r.msgs[0]?.id);
    btn2.textContent = "↑ 加载更早消息";
    btn2.onclick = (e) => loadOlder(e, sid);
    box.prepend(btn2);
  }
}

function box_first() {
  const box = $("#messages");
  for (const el of box.children) if (el.dataset?.id) return el;
  return null;
}

/** 选中 bot：左栏高亮、顶部名片、右栏详情、输入框提示 */
function markActiveBot(b) {
  document.querySelectorAll(".bot-item").forEach((el) => el.classList.toggle("active", !!el.dataset.botId && el.dataset.botId === b.id));
  $("#empty-state").style.display = "none";
  $("#input").placeholder = `给 ${b.name} 发消息，输入 @ 让它去找其他 bot`;
  const title = $("#chat-title");
  title.innerHTML = `<span class="t-avatar${isBusy(b.id) ? " busy" : ""}" data-av-bot="${esc(b.id)}">${avatarHtml(b)}</span>${esc(b.name)}`;
  $("#chat-bar").classList.remove("hidden");
  title.onclick = () => toggleDetails(true);
  renderHero();
  if (detailsPinned && window.innerWidth >= 1100) toggleDetails(true);
  else if (!$("#details").classList.contains("hidden")) renderDetails(b);
}

/** 会话发生过上下文压缩：顶部提示，点开看发给模型的摘要 */
function compactNote(info) {
  const el = document.createElement("div");
  el.className = "compact-note";
  el.innerHTML = `<div class="cn-head">🗜 早期消息已压缩为摘要，模型只看到摘要和最近的对话 <span>查看摘要 ›</span></div><div class="cn-body hidden">${renderMarkdown(esc(info.summary))}</div>`;
  el.querySelector(".cn-head").onclick = () => el.querySelector(".cn-body").classList.toggle("hidden");
  return el;
}

function clearMessages() {
  const box = $("#messages");
  box.innerHTML = "";
  delete box.dataset.lastTs;
}

function botById(id) { return bots.find((b) => b.id === id); }

function fmtTime(ts) {
  const d = new Date(ts), now = new Date();
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/** bot.ask：一条「已发消息给 X」+ 一条「X 的回复」，按发生顺序夹在对话里，点开看原文 */
const askTarget = (call) => {
  const to = String(call.args?.to ?? "");
  return bots.find((x) => x.name === to) ?? bots.find((x) => to && (to.includes(x.name) || x.name.includes(to)));
};
function b2bWho(call) {
  const t = askTarget(call);
  const name = t?.name ?? (String(call.args?.to ?? "") || "bot");
  return `<span class="b2b-av">${avatarHtml(t, "🤖")}</span><a class="ref ref-bot b2b-name" data-ref="bot" data-id="${esc(name)}">${esc(name)}</a>${t?.role && t.role !== t.name ? `<span class="b2b-role">· ${esc(t.role)}</span>` : ""}`;
}
function b2bOutHtml(call) {
  return `<details class="b2b-msg out"><summary><span class="b2b-dir">已发消息给</span>${b2bWho(call)}<span class="b2b-caret">›</span></summary><div class="b2b-body">${renderMarkdown(esc(call.args?.message ?? ""))}</div></details>`;
}
function b2bInHtml(call) {
  const name = askTarget(call)?.name ?? String(call.args?.to ?? "");
  const answer = String(call.result ?? "").replace(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} 回复：`), "");
  const failed = answer.startsWith("❌");
  return `<details class="b2b-msg in ${failed ? "err" : ""}"><summary><span class="b2b-dir">${failed ? "没联系上" : "收到回复"}</span>${b2bWho(call)}<span class="b2b-caret">›</span></summary><div class="b2b-body">${renderMarkdown(esc(answer))}</div></details>`;
}
function b2bLiveHtml(call, text) {
  return `<div class="b2b-msg in live"><div class="b2b-sum"><span class="b2b-dir">等待回复</span>${b2bWho(call)}<span class="dots"></span></div>${text ? `<div class="b2b-body">${renderMarkdown(esc(text))}</div>` : ""}</div>`;
}

/** 技能引用的文字写成了 key 时换成技能名 */
let skillNameByKey = {};
const loadSkillNames = () => api.skills.list().then((list) => { skillNameByKey = Object.fromEntries(list.map((k) => [k.key, k.name])); }).catch(() => {});
loadSkillNames();
api.onAppChanged((what) => { if (what === "skills") loadSkillNames(); if (what === "groups" || what === "bots") refreshBots(); });

/** 正文里的 @bot名 → 可点的 bot 引用 */
function mentionLinks(html) {
  html = html.replace(/(<a class="ref ref-skill" data-ref="skill" data-id="([^"]+)"[^>]*><span class="ref-ico">🧩<\/span>)([^<]*)<\/a>/g,
    (m, head, key, label) => label === key && skillNameByKey[key] ? `${head}${esc(skillNameByKey[key])}</a>` : m);
  const names = bots.map((b) => b.name).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!names.length || !html.includes("@")) return html;
  const re = new RegExp(`@(${names.map((n) => esc(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
  return html.replace(/(<[^>]*>)|([^<]+)/g, (m, tag, text) => tag ? m : text.replace(re, (_, n) => `<a class="ref ref-bot" data-ref="bot" data-id="${n}">@${n}</a>`));
}

function msgText(m) {
  return typeof m.content === "string" ? m.content : (m.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
}

/** 代码块：轻量高亮（注释 / 字符串 / 数字 / 关键字）+ 复制按钮；code 内是已转义 HTML，先还原再逐 token 转义 */
const CODE_KW = /^(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|def|lambda|pass|None|True|False|self|elif|with|as|yield|fn|pub|struct|impl|enum|match|use|mod|mut|func|package|type|interface|go|defer|select|null|undefined|true|false|this|echo|then|fi|done|esac|local|export|sudo)$/;
function highlightCode(src) {
  const re = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;
  let out = "", last = 0, mt;
  while ((mt = re.exec(src))) {
    out += esc(src.slice(last, mt.index));
    const [tok, cm, str, num, word] = mt;
    if (cm) out += `<span class="hl-c">${esc(tok)}</span>`;
    else if (str) out += `<span class="hl-s">${esc(tok)}</span>`;
    else if (num) out += `<span class="hl-n">${esc(tok)}</span>`;
    else if (word && CODE_KW.test(word)) out += `<span class="hl-k">${esc(tok)}</span>`;
    else out += esc(tok);
    last = re.lastIndex;
  }
  return out + esc(src.slice(last));
}

function decorateCode(root) {
  root.querySelectorAll("pre.code-block").forEach((pre) => {
    if (pre.dataset.decorated) return;
    pre.dataset.decorated = "1";
    const code = pre.querySelector("code");
    const raw = code.textContent;
    code.innerHTML = highlightCode(raw);
    const btn = document.createElement("button");
    btn.className = "code-copy";
    btn.textContent = "复制";
    btn.onclick = (e) => {
      e.stopPropagation();
      api.system.copy(raw);
      btn.textContent = "已复制";
      setTimeout(() => (btn.textContent = "复制"), 1200);
    };
    pre.appendChild(btn);
  });
}

/** 消息悬浮操作：复制 / 重新生成（仅最后一条 bot 回复）/ 删除 */
function attachMsgActions(wrapper, m) {
  if (m.id === undefined || m.id === null) return;
  const bar = document.createElement("div");
  bar.className = "msg-actions";
  const mine = m.from === "user";
  bar.innerHTML = `<button data-a="copy" title="复制">⧉</button>${mine ? `<button data-a="edit" title="编辑后重新发送">✎</button>` : `<button data-a="speak" title="朗读">🔊</button><button data-a="quote" title="引用回复">↩</button><button data-a="regen" title="重新生成">↻</button>`}<button data-a="share" title="分享这段问答">⇪</button><button data-a="del" title="删除">🗑</button>`;
  bar.onclick = async (e) => {
    const a = e.target.closest("button")?.dataset.a;
    if (!a) return;
    if (a === "copy") { api.system.copy(msgText(m)); e.target.textContent = "✓"; setTimeout(() => (e.target.textContent = "⧉"), 1000); }
    if (a === "del") {
      if (!confirm("删除这条消息？")) return;
      await api.messages.remove(m.sessionId, [m.id]);
      await loadSessionMessages(m.sessionId, true);
    }
    if (a === "regen") regenerate(m);
    if (a === "speak") toggleSpeak(msgText(m), e.target.closest("button"));
    if (a === "share") shareFlow(m);
    if (a === "edit") editAndResend(wrapper, m);
    if (a === "quote") {
      const q = msgText(m).replace(/```tool[\s\S]*?```/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
      $("#input").value = `> ${q}${q.length >= 80 ? "…" : ""}\n` + $("#input").value;
      $("#input").focus();
      $("#input").dispatchEvent(new Event("input"));
    }
  };
  wrapper.appendChild(bar);
}

/** 编辑一条已发的消息：原地改字，发送后删掉它及之后的所有消息，用新内容重来 */
function editAndResend(wrapper, m) {
  const bubble = wrapper.querySelector(".bubble");
  if (!bubble || wrapper.querySelector(".edit-box") || pending.has(m.sessionId)) return;
  const box = document.createElement("div");
  box.className = "edit-box";
  box.innerHTML = `<textarea rows="3"></textarea><div class="edit-ops"><button class="ghost-btn" data-e="cancel">取消</button><button class="primary-btn" data-e="send">发送</button></div>`;
  const ta = box.querySelector("textarea");
  ta.value = msgText(m);
  bubble.replaceWith(box);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  box.querySelector("[data-e=cancel]").onclick = () => box.replaceWith(bubble);
  const go = async () => {
    const text = ta.value.trim();
    if (!text) return;
    const msgs = await api.messages.list(m.sessionId);
    const idx = msgs.findIndex((x) => x.id === m.id);
    if (idx < 0) return;
    await api.messages.remove(m.sessionId, msgs.slice(idx).map((x) => x.id));
    await loadSessionMessages(m.sessionId, true);
    (Array.isArray(m.content) ? m.content : []).filter((b) => b.type === "image" || b.type === "file").forEach(addPending);
    $("#input").value = text;
    send();
  };
  box.querySelector("[data-e=send]").onclick = go;
  ta.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); go(); }
    if (e.key === "Escape") box.replaceWith(bubble);
  };
}
