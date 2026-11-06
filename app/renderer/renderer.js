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
/** 切 bot 的代数。慢返回到来时如果已经切走，就不要再改界面 */
let viewGen = 0;
/** 每个 bot 上次打开的会话，用来和会话列表并行拉消息 */
const lastSidByBot = new Map();
/** 离开某个 bot 时摘下的消息节点，切回来直接挂上，不必重画 markdown */
const transcriptCache = new Map();
function markSeen(botId) {
  if (!botId) return;
  lastSeen[botId] = Date.now();
  localStorage.setItem("harness.lastSeen", JSON.stringify(lastSeen));
}

function sidebarSig() {
  const botPart = bots.map((b) => [
    b.id, b.name, b.role || "", b.isMaster ? 1 : 0, b.pinned ? 1 : 0, b.hidden ? 1 : 0,
    b.section || "", b.petEnabled ? 1 : 0, b.order ?? "", b.avatarPath || "",
    b.avatar?.shape || "", b.avatar?.color || "",
  ].join("\u001f")).join("\u001e");
  const groupPart = groupList.map((g) => `${g.id}\u001f${g.name}\u001f${(g.members || []).join(",")}`).join("\u001e");
  return `${botPart}\u001d${groupPart}`;
}

/** 只改一行的在忙 / 预览，不要整栏拆掉重画（头像会重新加载） */
function patchBotRow(b) {
  const el = document.querySelector(`#bot-list .bot-item[data-bot-id="${CSS.escape(b.id)}"]`);
  if (!el) return false;
  const pv = previews[b.id];
  const st = liveStatus[b.id];
  const pc = presenceClass(b.id);
  const unread = currentBot?.id !== b.id && !currentGroup && (pv?.at ?? 0) > (lastSeen[b.id] ?? 0);
  el.classList.toggle("active", currentBot?.id === b.id && !currentGroup);
  el.classList.toggle("unread", unread);
  el.classList.toggle("pinned", !!b.pinned);
  const av = el.querySelector(".bot-avatar");
  if (av) {
    av.classList.toggle("busy", pc === "busy");
    av.classList.toggle("wait", pc === "wait");
    av.title = st?.currentTask || "";
    let dot = av.querySelector(".run-dot, .wait-dot");
    const want = pc === "busy" ? "run-dot" : pc === "wait" ? "wait-dot" : "";
    if (want) {
      if (!dot || !dot.classList.contains(want)) {
        dot?.remove();
        const s = document.createElement("span");
        s.className = want;
        av.appendChild(s);
      }
    } else dot?.remove();
  }
  const preview = el.querySelector(".bot-preview");
  if (preview) {
    const html = presencePreview(st);
    if (html) preview.innerHTML = html;
    else preview.textContent = pv?.text || b.role || "通用助手";
  }
  let ud = el.querySelector(".unread-dot");
  if (unread && !ud) {
    ud = document.createElement("span");
    ud.className = "unread-dot";
    el.appendChild(ud);
  } else if (!unread && ud) ud.remove();
  return true;
}

async function refreshBots() {
  const prevSig = bots.length ? sidebarSig() : "";
  [bots, previews, groupList] = await Promise.all([api.bots.list(), api.bots.previews().catch(() => ({})), api.groups.list().catch(() => [])]);
  for (const b of bots) if (lastSeen[b.id] === undefined) lastSeen[b.id] = previews[b.id]?.at ?? 0;
  if (currentBot) markSeen(currentBot.id);
  const recent = (b) => previews[b.id]?.at ?? b.createdAt ?? 0;
  bots.sort((a, b) => {
    if (!!a.isMaster !== !!b.isMaster) return a.isMaster ? -1 : 1;
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    const ao = a.order ?? Infinity, bo = b.order ?? Infinity;
    if (ao !== bo) return ao - bo;
    return recent(b) - recent(a);
  });
  if (currentBot) currentBot = bots.find((b) => b.id === currentBot.id) ?? null;
  const sameList = prevSig && prevSig === sidebarSig() && $("#bot-list [data-bot-id]");
  if (sameList && bots.filter((b) => !b.hidden).every((b) => patchBotRow(b))) {
    saveSidebarCache();
    if (currentBot && !currentGroup) await syncSetupBanner();
    return;
  }
  renderBotList();
  renderHero();
  saveSidebarCache();
  if (currentBot && !currentGroup) await syncSetupBanner();
}

const SIDEBAR_CACHE = "harness.sidebarCache";
/** 上次名单。重开时先画出来，不用等后面的脚本从磁盘读完。 */
function saveSidebarCache() {
  try {
    const preview = {};
    for (const [id, p] of Object.entries(previews || {})) preview[id] = { text: p?.text || "", at: p?.at || 0 };
    localStorage.setItem(SIDEBAR_CACHE, JSON.stringify({
      bots: bots.map((b) => ({
        id: b.id, name: b.name, role: b.role, isMaster: !!b.isMaster, pinned: !!b.pinned,
        hidden: !!b.hidden, section: b.section || "", petEnabled: !!b.petEnabled, order: b.order,
        avatar: b.avatar, avatarPath: b.avatarPath, createdAt: b.createdAt,
      })),
      previews: preview,
      groups: groupList.map((g) => ({ id: g.id, name: g.name, members: g.members || [] })),
      lastSids: Object.fromEntries(lastSidByBot),
    }));
  } catch { /* 配额满了就下次再记 */ }
}
function hydrateSidebar() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(SIDEBAR_CACHE) || "null"); } catch { return; }
  if (!raw?.bots?.length) return;
  bots = raw.bots;
  previews = raw.previews || {};
  groupList = raw.groups || [];
  if (raw.lastSids) {
    for (const [id, sid] of Object.entries(raw.lastSids)) if (sid) lastSidByBot.set(id, sid);
  }
  const list = $("#bot-list");
  if (list) list.removeAttribute("aria-busy");
  renderBotList();
  renderHero();
}
let botsReadyPromise = null;
function whenBotsReady() { return botsReadyPromise || refreshBots(); }

/** 首启空状态：配模型 → 建 bot → 选 bot 开聊 */
async function renderEmptyState() {
  const el = $("#empty-state");
  if (!el) return;
  el.style.display = "";
  $("#chat-bar")?.classList.add("hidden");
  clearMessages();
  if (typeof renderRelayBar === "function") renderRelayBar();
  const providers = await api.providers.list().catch(() => []);
  const step = providers.length <= 0 ? "provider" : bots.length <= 0 ? "bot" : "chat";
  const canGroup = bots.length >= 2;
  const copy = step === "provider"
    ? { title: "先接上一个模型", sub: "OpenAI 兼容 API，或本机 Claude / Codex / Cursor CLI。接好后不到十秒就能建好第一个 bot。", primary: "配置模型", secondary: "稍后再说，先建 bot" }
    : step === "bot"
      ? { title: "创建第一个 bot", sub: "起个名字，或一句话描述它是干什么的。创建后会带着欢迎语和起步建议。", primary: "新建 bot", secondary: "用一句话创建" }
      : { title: "选一个 bot 开始聊", sub: canGroup ? "也可以组队建群：调研写作、分诊、日报复盘。" : "也可以点侧栏右上角 ＋ 再建一个。", primary: "新建 bot", secondary: canGroup ? "组队建群" : undefined };
  const title = $("#empty-title");
  const sub = $("#empty-sub");
  const actions = $("#empty-actions");
  if (title) title.textContent = copy.title;
  if (sub) sub.textContent = copy.sub;
  if (actions) {
    actions.innerHTML = `
      <button class="primary-btn" id="empty-primary">${esc(copy.primary)}</button>
      ${copy.secondary ? `<button class="ghost-btn" id="empty-secondary">${esc(copy.secondary)}</button>` : ""}`;
    actions.querySelector("#empty-primary").onclick = () => {
      if (step === "provider") quickProviderFlow({ continueToBot: true });
      else if (typeof createBotFlow === "function") createBotFlow();
      else $("#new-bot-btn")?.click();
    };
    const sec = actions.querySelector("#empty-secondary");
    if (sec) {
      sec.onclick = () => {
        if (step === "provider") {
          if (typeof createBotFlow === "function") createBotFlow();
          else $("#new-bot-btn")?.click();
        } else if (step === "chat" && canGroup && typeof groupsFlow === "function") {
          groupsFlow();
        } else if (typeof createBotByTextFlow === "function") createBotByTextFlow();
        else $("#new-bot-btn")?.click();
      };
    }
  }
  const bar = $("#setup-banner");
  if (bar) { bar.classList.add("hidden"); bar.innerHTML = ""; }
}

/** 聊天中仍无模型时，顶条提醒去配置（离线人格也能回，但不火力全开） */
async function syncSetupBanner() {
  const bar = $("#setup-banner");
  if (!bar) return;
  if (!currentBot || currentGroup) {
    bar.classList.add("hidden");
    bar.innerHTML = "";
    return;
  }
  if (bar.dataset.dismissed === "1") {
    bar.classList.add("hidden");
    return;
  }
  const providers = await api.providers.list().catch(() => []);
  if (providers.length > 0) {
    bar.classList.add("hidden");
    bar.innerHTML = "";
    delete bar.dataset.dismissed;
    return;
  }
  bar.classList.remove("hidden");
  bar.innerHTML = `<span class="sb-text">还没配置模型，现在走离线回复。接上 API 或本机 CLI 后就能认真聊。</span>
    <button class="primary-btn" id="sb-setup">配置模型</button>
    <button class="ghost-btn" id="sb-dismiss" title="暂时隐藏">稍后</button>`;
  bar.querySelector("#sb-setup").onclick = () => quickProviderFlow({ continueToBot: false });
  bar.querySelector("#sb-dismiss").onclick = () => {
    bar.dataset.dismissed = "1";
    bar.classList.add("hidden");
  };
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
function isWaiting(botId) {
  return liveStatus[botId]?.state === "waiting";
}
function presenceClass(botId, inGroup = false) {
  if (isBusy(botId, inGroup)) return "busy";
  if (isWaiting(botId)) return "wait";
  return "";
}
function presencePreview(st) {
  if (st?.state === "running") return `<span class="busy">正在处理${st.currentTask ? `：${esc(st.currentTask)}` : "…"}</span>`;
  if (st?.state === "waiting") return `<span class="wait">等待你确认${st.currentTask ? `：${esc(st.currentTask)}` : ""}</span>`;
  if (st?.state === "error") return `<span class="fail">出错了</span>`;
  return null;
}

/** bot 在处理任务时，所有显示它头像的地方一起动 */
function syncBusyAvatars() {
  document.querySelectorAll("[data-av-bot]").forEach((el) => {
    const inGroup = "avGroup" in el.dataset;
    el.classList.toggle("busy", isBusy(el.dataset.avBot, inGroup));
    el.classList.toggle("wait", !isBusy(el.dataset.avBot, inGroup) && isWaiting(el.dataset.avBot));
  });
}

function renderHero() {
  const hero = $("#side-hero");
  const b = bots.find((x) => x.isMaster) ?? currentBot ?? bots[0];
  const pc = b ? presenceClass(b.id) : "";
  hero.innerHTML = b ? `<div class="hero-avatar${pc ? ` ${pc}` : ""}" data-av-bot="${esc(b.id)}" title="${esc(liveStatus[b.id]?.currentTask || b.role || "")}">${avatarHtml(b)}${b.isMaster ? '<span class="hero-badge" title="主控 / Primary">★</span>' : ""}</div><div class="hero-name">${esc(b.name)}${b.isMaster ? " · 主控" : ""}</div>` : "";
  hero.classList.toggle("active", !!b && currentBot?.id === b.id);
  hero.onclick = b ? () => selectBot(b) : null;
  hero.draggable = !!b;
  hero.ondragstart = b ? (e) => {
    e.dataTransfer.setData("text/bot-id", b.id);
    e.dataTransfer.effectAllowed = "copyMove";
  } : null;
}

function appendBotItem(list, b) {
  const pv = previews[b.id];
  const st = liveStatus[b.id];
  const pc = presenceClass(b.id);
  const unread = currentBot?.id !== b.id && (pv?.at ?? 0) > (lastSeen[b.id] ?? 0);
  const el = document.createElement("div");
  el.className = "bot-item" + (currentBot?.id === b.id ? " active" : "") + (unread ? " unread" : "") + (b.pinned ? " pinned" : "");
  el.dataset.botId = b.id;
  const preview = presencePreview(st) || esc(pv?.text || b.role || "通用助手");
  el.innerHTML = `
    <div class="bot-avatar${pc ? ` ${pc}` : ""}" data-av-bot="${esc(b.id)}" title="${esc(st?.currentTask || "")}">${avatarHtml(b)}${pc === "busy" ? '<span class="run-dot"></span>' : pc === "wait" ? '<span class="wait-dot"></span>' : ""}</div>
    <div class="bot-meta">
      <div class="bot-name">${b.pinned ? "📌 " : ""}${esc(b.name)} ${b.petEnabled ? '<span class="bot-pet-badge">🐾</span>' : ""}${b.isMaster ? '<span class="tag">主控</span>' : ""}</div>
      <div class="bot-preview">${preview}</div>
    </div>${unread ? '<span class="unread-dot"></span>' : ""}`;
  el.onclick = () => selectBot(b);
  el.oncontextmenu = (e) => { e.preventDefault(); botContextMenu(e, b); };
  el.draggable = true;
  el.ondragstart = (e) => { e.dataTransfer.setData("text/bot-id", b.id); e.dataTransfer.effectAllowed = "copyMove"; el.classList.add("dragging"); };
  el.ondragend = () => { el.classList.remove("dragging"); list.querySelectorAll(".drop-before,.drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after")); };
  el.ondragover = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
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

function renderBotList() {
  const list = $("#bot-list");
  list.innerHTML = `<div class="mx-h bot-list-h"><span>Bot</span><button class="list-add" id="bot-list-new" title="新建 bot">＋</button></div>`;
  const addBtn = list.querySelector("#bot-list-new");
  if (addBtn) addBtn.onclick = (e) => { e.stopPropagation(); $("#new-bot-btn")?.click(); };
  const visible = bots.filter((b) => !b.hidden);
  const hidden = bots.filter((b) => b.hidden);
  if (bots.length === 0) {
    const empty = document.createElement("div");
    empty.className = "d-empty";
    empty.style.padding = "8px";
    empty.textContent = "还没有 bot，点上方 ＋ 创建第一个";
    list.appendChild(empty);
    return;
  }
  const sections = [];
  for (const b of visible) {
    const sec = (b.section || "").trim() || "";
    if (!sections.includes(sec)) sections.push(sec);
  }
  for (const sec of sections) {
    if (sec) {
      const head = document.createElement("div");
      head.className = "list-head bot-section";
      head.innerHTML = `<span>${esc(sec)}</span>`;
      list.appendChild(head);
    }
    for (const b of visible.filter((x) => ((x.section || "").trim() || "") === sec)) appendBotItem(list, b);
  }
  if (hidden.length) {
    const head = document.createElement("div");
    head.className = "list-head bot-section muted";
    head.innerHTML = `<span>已隐藏 · ${hidden.length}</span><button class="list-add" id="bot-hidden-toggle" title="展开/收起">▾</button>`;
    list.appendChild(head);
    const wrap = document.createElement("div");
    wrap.className = "bot-hidden-list hidden";
    wrap.id = "bot-hidden-list";
    list.appendChild(wrap);
    for (const b of hidden) appendBotItem(wrap, b);
    head.querySelector("#bot-hidden-toggle").onclick = (e) => {
      e.stopPropagation();
      wrap.classList.toggle("hidden");
    };
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
  // relayState 在后面的脚本里。名单先画时还没有它，就当作没人在发言。
  if (typeof relayState === "undefined") return null;
  for (const p of relayState.values()) if (p.groupId === groupId && p.state !== "done") return p;
  return null;
}

async function selectGroup(g, sid) {
  const gen = ++viewGen;
  const sameGroup = currentGroup?.id === g.id;
  if (currentBot && !currentGroup) stashTranscript(currentBot);
  currentGroup = g;
  currentBot = null;
  if (voiceMode) stopVoiceMode();
  document.querySelectorAll(".bot-item").forEach((el) => el.classList.toggle("active", el.dataset.groupId === g.id));
  $("#empty-state").style.display = "none";
  const setupBar = $("#setup-banner");
  if (setupBar) { setupBar.classList.add("hidden"); setupBar.innerHTML = ""; }
  $("#input").placeholder = `发到群聊「${g.name}」，@ 谁谁回；没 @ 由主持人先说`;
  const title = $("#chat-title");
  title.innerHTML = `<span class="group-avatars t-group">${groupAvatarsHtml(g.members.map(botById).filter(Boolean))}</span>${esc(g.name)}`;
  $("#chat-bar").classList.remove("hidden");
  title.onclick = () => toggleDetails(true);
  renderHero();
  const sessP = sid ? null : api.sessions.page({ botId: g.id, limit: 1 }).catch(() => ({ sessions: [] }));
  if (typeof renderComposerTools === "function") renderComposerTools();
  scheduleDetails(g, gen, true);
  if (!sameGroup) clearMessages();
  if (!sid) {
    const { sessions } = await sessP;
    if (gen !== viewGen) return;
    sid = sessions[0]?.id ?? `group-${g.id}`;
  }
  currentSession = sid;
  await loadSessionMessages(currentSession, true);
  if (gen !== viewGen) return;
  api.groups.gaze(g.id, currentSession);
  const held = await api.groups.peek(currentSession).catch(() => null);
  if (held && !relayState.has(currentSession)) {
    relayState.set(currentSession, { sessionId: currentSession, groupId: g.id, state: "paused", turn: held.turns, max: held.max, next: held.next, board: held.board, reason: "接着说" });
  }
  renderRelayBar();
  $("#coding-term")?.classList.add("hidden");
  if (typeof paintCodingDock === "function") paintCodingDock();
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
    <div class="ctx-item" data-act="master">${b.isMaster ? "☆ 取消主控 / Primary" : "★ 设为主控 / Primary"}</div>
    <div class="ctx-item" data-act="pin">${b.pinned ? "取消钉住" : "📌 钉住"}</div>
    <div class="ctx-item" data-act="section">📁 分区…</div>
    <div class="ctx-item" data-act="hide">${b.hidden ? "显示在侧栏" : "从侧栏隐藏"}</div>
    <div class="ctx-item" data-act="dup">创建副本</div>
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
      if (it.dataset.act === "pin") { await api.bots.update(b.id, { pinned: !b.pinned }); return refreshBots(); }
      if (it.dataset.act === "hide") { await api.bots.update(b.id, { hidden: !b.hidden }); return refreshBots(); }
      if (it.dataset.act === "section") {
        const name = await askInput("分区名称", "如：工作 / 个人；留空取消分区", b.section || "");
        if (name == null) return;
        await api.bots.update(b.id, { section: name.trim() || null });
        return refreshBots();
      }
      if (it.dataset.act === "dup") {
        if (typeof duplicateBot === "function") return duplicateBot(b);
        const copy = await api.bots.duplicate(b.id);
        await refreshBots();
        if (copy) selectBot(bots.find((x) => x.id === copy.id) || copy);
        return;
      }
      if (!confirm(`确定删除「${b.name}」？宠物窗口会一并关闭，会话记录保留。`)) return;
      await api.bots.remove(b.id);
      if (currentBot?.id === b.id) {
        currentBot = null;
        currentSession = null;
        clearMessages();
        $("#chat-bar").classList.add("hidden");
        $("#details").classList.add("hidden");
        $("#details-mask")?.classList.add("hidden");
        document.body.classList.remove("details-open");
      }
      await refreshBots();
      if (!currentBot && !currentGroup) await renderEmptyState();
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
/** 历史编排阶段、定时任务在后台自动跑出来的会话：能查看，但不当作和用户聊天的会话 */
const BG_SESSIONS = { "plan-": "🧩 历史编排阶段", "sched-": "⏰ 定时任务" };
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

function stashTranscript(bot) {
  if (!bot) return;
  const box = $("#messages");
  if (!box) return;
  transcriptCache.set(bot.id, {
    sid: currentSession,
    nodes: [...box.childNodes],
    scroll: box.scrollTop,
    lastTs: box.dataset.lastTs || "",
    projectId: sessionProject,
  });
  if (currentSession) lastSidByBot.set(bot.id, currentSession);
}

function dropTranscript(sid) {
  if (!sid) return;
  for (const [botId, hit] of transcriptCache) if (hit.sid === sid) transcriptCache.delete(botId);
}

function restoreTranscript(botId) {
  const hit = transcriptCache.get(botId);
  if (!hit) return false;
  transcriptCache.delete(botId);
  const box = $("#messages");
  if (!box) return false;
  currentSession = hit.sid ?? null;
  sessionProject = hit.projectId ?? null;
  if (hit.lastTs) box.dataset.lastTs = hit.lastTs;
  else delete box.dataset.lastTs;
  box.replaceChildren(...(hit.nodes || []));
  const top = hit.scroll || 0;
  box.scrollTop = top;
  requestAnimationFrame(() => {
    if (currentBot?.id === botId && currentSession === hit.sid) box.scrollTop = top;
  });
  return true;
}

/** 屏幕上的消息 id 是否已经是这一页（切回来时不必重画） */
function transcriptMatches(r) {
  const box = $("#messages");
  if (!box || !r) return false;
  const ids = [...box.querySelectorAll(".msg[data-id]")].map((el) => el.dataset.id).filter((id) => id && id !== "undefined");
  const want = [];
  let prev = null;
  for (const m of r.msgs || []) {
    if (m.kind === "event" && prev?.kind === "event" && prev.content === m.content) continue;
    if (m.id != null) want.push(String(m.id));
    prev = m;
  }
  if (ids.length !== want.length) return false;
  for (let i = 0; i < want.length; i++) if (ids[i] !== want[i]) return false;
  return true;
}

function paintGroupShell(g) {
  const panel = $("#details");
  if (!panel) return;
  const key = `g:${g.id}`;
  if (panel.dataset.forBot === key && panel.querySelector(".d-tabs")) return;
  panel.dataset.forBot = key;
  panel.innerHTML = `
    <button class="icon-btn d-close" title="关闭">✕</button>
    <div class="d-hero"><div class="d-name">${esc(g.name)}</div></div>
    <div class="d-sec"><div class="d-empty">正在打开…</div></div>`;
  const close = panel.querySelector(".d-close");
  if (close) close.onclick = () => { if (typeof toggleDetails === "function") toggleDetails(false); };
}

function paintDetailsShell(b) {
  const panel = $("#details");
  if (!panel) return;
  if (panel.dataset.forBot === b.id && panel.querySelector(".d-tabs")) return;
  panel.dataset.forBot = b.id;
  panel.innerHTML = `
    <button class="icon-btn d-close" title="关闭">✕</button>
    <div class="d-hero">
      <div class="d-avatar${isBusy(b.id) ? " busy" : ""}" data-av-bot="${esc(b.id)}">${avatarHtml(b)}</div>
      <div class="d-name">${esc(b.name)}</div>
      <div class="d-role">${esc(b.role || "通用助手")}</div>
    </div>
    <div class="d-sec"><div class="d-empty">正在打开…</div></div>`;
  const close = panel.querySelector(".d-close");
  if (close) close.onclick = () => { if (typeof toggleDetails === "function") toggleDetails(false); };
}

/** 右栏先换上这个 bot 的名字，重数据等对话请求发出去再拉 */
function scheduleDetails(target, gen, isGroup) {
  const panel = $("#details");
  const pinned = typeof detailsPinned !== "undefined" && detailsPinned && window.innerWidth >= 1100;
  const showing = !!(panel && !panel.classList.contains("hidden"));
  if (panel && (pinned || showing)) {
    if (isGroup) paintGroupShell(target);
    else paintDetailsShell(target);
    panel.classList.remove("hidden");
    document.body.classList.add("details-open");
    $("#details-mask")?.classList.add("hidden");
  }
  setTimeout(() => {
    if (gen !== viewGen) return;
    if (isGroup) {
      if (currentGroup?.id !== target.id) return;
      if (typeof refreshWatchChip === "function") refreshWatchChip();
      if ((pinned || (panel && !panel.classList.contains("hidden"))) && typeof toggleDetails === "function") toggleDetails(true);
      return;
    }
    if (currentBot?.id !== target.id || currentGroup) return;
    if (typeof syncSetupBanner === "function") syncSetupBanner();
    if (typeof refreshWatchChip === "function") refreshWatchChip();
    if ((pinned || (panel && !panel.classList.contains("hidden"))) && typeof renderDetails === "function") renderDetails(target);
  }, 0);
}

async function selectBot(b) {
  if (typeof leaveRealm === "function" && typeof realmPresence !== "undefined" && realmPresence) leaveRealm({ silent: true });
  if (currentGroup) api.groups.gaze(currentGroup.id, null);
  const sameBot = currentBot?.id === b.id && !currentGroup;
  const gen = ++viewGen;
  if (!sameBot && currentBot && !currentGroup) stashTranscript(currentBot);
  currentBot = b;
  currentGroup = null;
  if (typeof renderRelayBar === "function") renderRelayBar();
  if (voiceMode && typeof stopVoiceMode === "function") stopVoiceMode();
  markSeen(b.id);
  markActiveBot(b);
  const restored = !sameBot && restoreTranscript(b.id);
  if (!sameBot && !restored) {
    currentSession = null;
    sessionProject = null;
    clearMessages();
  }
  const sidHint = lastSidByBot.get(b.id) || null;
  const sessP = api.sessions.page({ botId: b.id, limit: 30 });
  const prefetch = !sameBot && !!sidHint;
  const msgP = prefetch ? api.messages.page(sidHint, { limit: 40 }).catch(() => null) : null;
  const infoP = prefetch ? api.sessions.get(sidHint).catch(() => null) : null;
  if (typeof renderComposerTools === "function") renderComposerTools();
  scheduleDetails(b, gen, false);
  if (restored && typeof setSending === "function") setSending();
  const { sessions } = await sessP;
  if (gen !== viewGen || currentBot?.id !== b.id) return;
  const latest = pickSession(sessions, b.id);
  if (typeof setSending === "function") setSending();
  if (latest) {
    // 已在同一会话：不要 clear→reload（切回前台 / 重复点侧栏会闪空白）
    if (sameBot && currentSession === latest.id && $("#messages")?.children?.length) {
      rememberView();
      if (typeof syncCodingTerm === "function") syncCodingTerm();
      return;
    }
    if (prefetch && latest.id === sidHint) {
      const [r, info] = await Promise.all([msgP, infoP]);
      if (gen !== viewGen || currentBot?.id !== b.id) return;
      if (!r) {
        currentSession = latest.id;
        await loadSessionMessages(latest.id, true);
      } else if (restored && currentSession === latest.id && transcriptMatches(r)) {
        if (info) sessionProject = info.projectId ?? null;
        if (typeof renderComposerTools === "function") renderComposerTools();
        lastSidByBot.set(b.id, latest.id);
        rememberView();
        if (typeof setSending === "function") setSending();
        if (typeof syncCodingTerm === "function") syncCodingTerm();
        return;
      } else {
        currentSession = latest.id;
        await loadSessionMessages(latest.id, true, { r, info });
      }
    } else {
      currentSession = latest.id;
      await loadSessionMessages(latest.id, true);
    }
  } else {
    currentSession = null;
    clearMessages();
    rememberView();
  }
  if (gen !== viewGen) return;
  if (typeof syncCodingTerm === "function") syncCodingTerm();
}

/** 记住上次打开的 bot / 群聊和会话，重开软件时直接回到那里 */
function rememberView() {
  const view = currentGroup ? { group: currentGroup.id, sid: currentSession } : currentBot ? { bot: currentBot.id, sid: currentSession } : null;
  if (view) localStorage.setItem("harness.lastView", JSON.stringify(view));
  if (currentBot && currentSession && !currentGroup) lastSidByBot.set(currentBot.id, currentSession);
  saveSidebarCache();
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
  if (!bot) return renderEmptyState();
  const s = bot.id === view?.bot && view.sid && (await api.sessions.get(view.sid).catch(() => null));
  if (!s) return selectBot(bot);
  await selectBot(bot);
  if (currentBot?.id === bot.id && currentSession !== view.sid) {
    currentSession = view.sid;
    await loadSessionMessages(view.sid, true);
  }
}

/** G1：加载会话消息（分页窗口，tail=最新 N 条；加载更早时 prepend） */
async function loadSessionMessages(sid, initial = false, prefetched = null) {
  const gen = viewGen;
  if (initial) rememberView();
  // 先拉齐数据再建 DOM，避免 clear 后空白一闪（流式结束后「消失再刷回来」）
  const [r, info] = prefetched
    ? [prefetched.r, initial ? prefetched.info : null]
    : await Promise.all([
      api.messages.page(sid, { limit: 40 }),
      initial ? api.sessions.get(sid).catch(() => null) : Promise.resolve(null),
    ]);
  if (gen !== viewGen) return;
  const box = $("#messages");
  const pinBottom = !initial || (typeof messagesNearBottom === "function" ? messagesNearBottom(200) : true);
  const keepScroll = box.scrollTop;

  if (initial) {
    sessionProject = info?.projectId ?? null;
    if (typeof renderComposerTools === "function") renderComposerTools();
  }

  const frag = document.createDocumentFragment();
  let lastTs = 0;
  const pushEl = (el, ts) => {
    const t = Number(ts) || 0;
    if (t && (!lastTs || t - lastTs > 10 * 60_000)) {
      const sep = document.createElement("div");
      sep.className = "time-sep";
      sep.textContent = fmtTime(t);
      frag.appendChild(sep);
    }
    if (t) lastTs = t;
    frag.appendChild(el);
  };

  const banner = initial && b2bBanner(sid);
  if (banner) frag.appendChild(banner);
  if (initial && info?.summary) frag.appendChild(compactNote(info));

  if (r.hasMore) {
    const btn = document.createElement("button");
    btn.className = "load-more-btn";
    btn.dataset.loadmore = sid;
    btn.dataset.before = r.msgs[0]?.id;
    btn.textContent = "↑ 加载更早消息";
    btn.onclick = (ev) => loadOlder(ev, sid);
    frag.appendChild(btn);
  }

  // 相邻且文案完全相同的系统事件（如连点两次相同授权）只留一条，避免刷屏
  const visible = [];
  for (const m of r.msgs) {
    const prev = visible.at(-1);
    if (m.kind === "event" && prev?.kind === "event" && prev.content === m.content) continue;
    visible.push(m);
  }
  const els = visible.map((m) => {
    const el = makeMsgEl(m);
    if (initial) pushEl(el, m.createdAt);
    else box.appendChild(el);
    return el;
  });

  // 进行中的流式节点挂回去；乐观上屏的用户气泡若存档里已有同文，跳过，避免「发送一次显示两次」
  const live = pending.get(sid);
  if (initial && live) {
    const storeIds = new Set(visible.map((m) => (m.id != null ? String(m.id) : "")).filter(Boolean));
    const storeUserTexts = new Set(visible.filter((m) => m.from === "user").map((m) => msgText(m).trim()).filter(Boolean));
    for (const n of live.nodes) {
      const id = n.dataset?.id || "";
      if (id && storeIds.has(id)) continue;
      if (n.classList?.contains("user") && !id) {
        const t = (n.querySelector(".bubble")?.textContent || "").trim();
        if (t && storeUserTexts.has(t)) continue;
      }
      frag.appendChild(n);
    }
  }

  if (initial) {
    box.replaceChildren(frag);
    if (lastTs) box.dataset.lastTs = String(lastTs);
    else delete box.dataset.lastTs;
  }

  // 用 visible/els 下标，避免相邻重复 event 去重后 r.msgs 下标错位导致建议芯片挂不上
  const lastVis = visible.findLastIndex((m) => m.kind !== "event");
  const last = lastVis >= 0 ? visible[lastVis] : null;
  if (initial && !live && last?.role === "assistant" && last.meta?.suggestions) showSuggestions(els[lastVis], last.meta.suggestions);
  if (initial) box.scrollTop = pinBottom ? box.scrollHeight : keepScroll;
  if (initial && currentBot && !currentGroup) lastSidByBot.set(currentBot.id, sid);
  if (typeof setSending === "function") setSending();
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

/** 选中 bot：左栏高亮和顶栏立刻换。右栏和监听放到 scheduleDetails，免得堵住拉消息 */
function markActiveBot(b) {
  document.querySelectorAll(".bot-item").forEach((el) => {
    const on = !!el.dataset.botId && el.dataset.botId === b.id;
    el.classList.toggle("active", on);
    if (on) {
      el.classList.remove("unread");
      el.querySelector(".unread-dot")?.remove();
    }
  });
  $("#empty-state").style.display = "none";
  $("#input").placeholder = `给 ${b.name} 发消息，输入 @ 让它去找其他 bot`;
  const title = $("#chat-title");
  title.innerHTML = `<span class="t-avatar${isBusy(b.id) ? " busy" : ""}" data-av-bot="${esc(b.id)}">${avatarHtml(b)}</span>${esc(b.name)}`;
  $("#chat-bar").classList.remove("hidden");
  title.onclick = () => toggleDetails(true);
  renderHero();
}

/** 顶栏轻量监听状态：不占聊天气泡，点开详情「系统监听」 */
async function refreshWatchChip(prefetched) {
  const chip = $("#watch-chip");
  if (!chip) return;
  if (!currentBot || currentGroup || !api.systemWatch) {
    chip.className = "watch-chip hidden";
    chip.onclick = null;
    return;
  }
  const botId = currentBot.id;
  const st = prefetched || await api.systemWatch.status(botId).catch(() => null);
  if (!st || currentBot?.id !== botId) {
    if (!st) chip.className = "watch-chip hidden";
    return;
  }
  const watch = st.watch || {};
  const apps = st.apps || [];
  const live = apps.filter((a) => a.running).length;
  const total = (watch.apps || []).length;
  if (!watch.enabled) {
    chip.className = "watch-chip off";
    chip.textContent = "监听关";
  } else if (!total) {
    chip.className = "watch-chip empty";
    chip.textContent = "未选 App";
  } else {
    chip.className = "watch-chip" + (live ? " live" : "");
    const icons = apps.slice(0, 3).map((a) => {
      const tip = `${a.name}${a.running ? " · 在跑" : " · 未开"}`;
      if (a.iconDataUrl) return `<img src="${esc(a.iconDataUrl)}" alt="${esc(a.name)}" title="${esc(tip)}" />`;
      return `<span title="${esc(tip)}">${esc((a.name || "?").slice(0, 1))}</span>`;
    }).join("");
    chip.innerHTML = `<span class="wc-k">监听</span><span class="wc-icons">${icons}</span><span class="wc-txt">${live}/${total}</span>`;
  }
  chip.title = "查看系统监听";
  chip.onclick = (e) => {
    e.stopPropagation();
    openWatchPop(chip, st);
  };
}

/** 贴着顶栏这颗状态打开，不进详情栏，也不碰授权卡和交互弹窗 */
function openWatchPop(anchor, st) {
  const old = document.querySelector("#watch-pop");
  if (old) {
    old.remove();
    return;
  }
  const watch = st?.watch || {};
  const apps = st?.apps || [];
  const pop = document.createElement("div");
  pop.id = "watch-pop";
  pop.className = "watch-pop";
  const rows = !watch.enabled
    ? `<div class="wp-empty">监听已关</div>`
    : !apps.length
      ? `<div class="wp-empty">还没有要盯的 App</div>`
      : apps.map((a) => {
          const meta = a.running ? `在跑 · ${Number(a.cpu || 0).toFixed(1)}% · ${a.rssMb || 0} MB` : "未开";
          const icon = a.iconDataUrl
            ? `<img src="${esc(a.iconDataUrl)}" alt="" />`
            : `<span>${esc((a.name || "?").slice(0, 1))}</span>`;
          return `<div class="wp-row ${a.running ? "live" : ""}">${icon}<div><b>${esc(a.name)}</b><small>${esc(meta)}</small></div></div>`;
        }).join("");
  pop.innerHTML = `<div class="wp-head">系统监听</div>${rows}`;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  pop.style.left = `${Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8)}px`;
  pop.style.top = `${r.bottom + 8}px`;
  setTimeout(() => document.addEventListener("pointerdown", function off(ev) {
    if (pop.contains(ev.target) || anchor.contains(ev.target)) return;
    pop.remove();
    document.removeEventListener("pointerdown", off);
  }), 0);
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
  const raw = String(call.result ?? "");
  const answer = raw.replace(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} 回复：`), "");
  // 真正没打通：工具层失败 / 找不到人。对方回了 ❌（缺密钥等）算「联系上了但业务报错」
  const unreachable = /^(❌ 询问 |❌ 这一问已经转过|找不到名为|bot 间通信未启用)/.test(raw) || /^(❌ 询问 |❌ 这一问已经转过)/.test(answer);
  const peerErr = !unreachable && (/^❌/.test(answer) || /密钥未设置/.test(answer));
  const cls = unreachable ? "err" : peerErr ? "warn" : "";
  const dir = unreachable ? "没联系上" : peerErr ? "对方回了错误" : "收到回复";
  return `<details class="b2b-msg in ${cls}"><summary><span class="b2b-dir">${dir}</span>${b2bWho(call)}<span class="b2b-caret">›</span></summary><div class="b2b-body">${renderMarkdown(esc(answer))}</div></details>`;
}
function b2bLiveHtml(call, text) {
  return `<div class="b2b-msg in live"><div class="b2b-sum"><span class="b2b-dir">等待回复</span>${b2bWho(call)}<span class="dots"></span></div>${text ? `<div class="b2b-body">${renderMarkdown(esc(text))}</div>` : ""}</div>`;
}

/** 技能引用的文字写成了 key 时换成技能名 */
let skillNameByKey = {};
const loadSkillNames = () => api.skills.list().then((list) => { skillNameByKey = Object.fromEntries(list.map((k) => [k.key, k.name])); }).catch(() => {});
loadSkillNames();
api.onAppChanged((what) => {
  if (what === "skills") loadSkillNames();
  if (what === "groups" || what === "bots") refreshBots();
  if (what === "system-watch") {
    refreshWatchChip();
    if (currentBot && detailsTab === "info" && !$("#details")?.classList.contains("hidden")) renderDetails(currentBot);
  }
});
api.onBotCreated?.(async ({ botId, sessionId }) => {
  await refreshBots();
  const b = bots.find((x) => x.id === botId);
  if (!b) return;
  // 工具创建：跳到新 bot 并打开欢迎会话
  await selectBot(b);
  if (sessionId) {
    currentSession = sessionId;
    await loadSessionMessages(sessionId, true);
  }
});

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
  const inbound = m.from === "webhook" || m.from === "inbound" || (!!m.meta?.webhook && m.role === "user");
  const mine = m.from === "user" && !inbound;
  bar.innerHTML = `<button data-a="copy" data-tip="复制" aria-label="复制">⧉</button>${mine ? `<button data-a="edit" data-tip="编辑" aria-label="编辑后重新发送">✎</button>` : `<button data-a="speak" data-tip="朗读" aria-label="朗读">🔊</button><button data-a="quote" data-tip="引用" aria-label="引用回复">↩</button>${inbound ? "" : `<button data-a="regen" data-tip="重新生成" aria-label="重新生成">↻</button>`}`}<button data-a="share" data-tip="分享" aria-label="分享这段问答">⇪</button><button data-a="del" data-tip="删除" aria-label="删除">🗑</button>`;
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
      setComposerInput(`> ${q}${q.length >= 80 ? "…" : ""}\n` + $("#input").value, { focus: true, caret: "end" });
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
    setComposerInput(text);
    send();
  };
  box.querySelector("[data-e=send]").onclick = go;
  ta.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); go(); }
    if (e.key === "Escape") box.replaceWith(bubble);
  };
}

try { hydrateSidebar(); } catch (e) { console.error("[sidebar] 缓存名单没画出来", e); }
botsReadyPromise = refreshBots();
