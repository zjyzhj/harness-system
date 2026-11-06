// 终端面板：只服务「交互现场」。term.open / 用户点打开 / cli.agent 启动时才抢焦点。
// bash.run、fs.*、file.send 绝不自动打开本面板。默认 shell；cli.agent 把同槽切到 Coding CLI。
const CT_KEYS = {
  Enter: "\r",
  Backspace: "\u007f",
  Tab: "\t",
  ArrowUp: "\u001b[A",
  ArrowDown: "\u001b[B",
  ArrowRight: "\u001b[C",
  ArrowLeft: "\u001b[D",
  Escape: "\u001b",
};

let codingView = null;
let codingTermOpen = false;
let codingTermCollapsed = false;
let codingDirs = [];
let xterm = null;
let xtermFit = null;
let attachedCwd = "";
let attachedStartedAt = 0;
let pendingCwd = "";
let pinCwd = "";
let pinBotId = "";
let replayQueue = [];
let attachToken = 0;

function codingTermEls() {
  return {
    box: $("#coding-term"),
    title: $("#ct-title"),
    path: $("#ct-path"),
    status: $("#ct-status"),
    dirs: $("#ct-dirs"),
    screen: $("#ct-screen"),
    host: $("#ct-xterm"),
    stop: $("#ct-stop"),
    open: $("#ct-open"),
    send: $("#ct-send"),
    brk: $("#ct-break"),
    hide: $("#ct-hide"),
    pick: $("#ct-pick"),
    empty: $("#ct-empty"),
    emptyText: $("#ct-empty-text"),
    emptyAct: $("#ct-empty-act"),
  };
}

function setShown(el, on) {
  if (el) el.style.display = on ? "" : "none";
}

function xtermReady() {
  return !!(window.HarnessXterm && window.HarnessXterm.Terminal && window.HarnessXterm.FitAddon);
}

function ensureXterm() {
  if (!xtermReady()) return null;
  if (xterm) return xterm;
  const { host } = codingTermEls();
  if (!host) return null;
  const XT = window.HarnessXterm;
  xterm = new XT.Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    theme: { background: "#161615", foreground: "#eceae4", cursor: "#3ddc84", selectionBackground: "rgba(47,143,78,.35)" },
  });
  xtermFit = new XT.FitAddon();
  xterm.loadAddon(xtermFit);
  xterm.open(host);
  xterm.onData((data) => writeCodingTerm(data));
  xterm.onResize(({ cols, rows }) => {
    if (!currentBot || !codingView || codingView.phase === "exited") return;
    api.coding.resize(currentBot.id, cols, rows, codingView.cwd);
  });
  return xterm;
}

function fitCodingTerm() {
  if (!xtermFit) return;
  requestAnimationFrame(() => {
    try { xtermFit.fit(); } catch { /* 面板还没尺寸 */ }
  });
}

function shortDir(cwd) {
  const parts = String(cwd || "").split("/").filter(Boolean);
  return parts.slice(-2).join("/") || cwd || "目录";
}

function termProgLabel(d) {
  if (!d) return "";
  if (d.program?.kind === "shell" || d.cli === "shell") return "shell";
  return d.cli || "agent";
}

function termLive(d) {
  if (!d || d.phase === "exited") return false;
  // starting 但已带失败原因 / 无 pid：僵尸，当未打开
  if (d.phase === "starting" && (d.exitReason || !d.pid)) return false;
  return true;
}

function termFace(d) {
  if (d?.cold) return { key: "off", label: "未打开" };
  if (!d || d.phase === "exited") return { key: "off", label: d?.exitReason ? "没打开" : "已关掉" };
  if (d.phase === "starting" && (d.exitReason || !d.pid)) return { key: "off", label: "没打开" };
  const prog = termProgLabel(d);
  const isAgent = d.program?.kind === "agent" || (d.cli && d.cli !== "shell");
  if (d.phase === "starting") return { key: "run", label: `${prog}·打开中` };
  // 屏幕姿态优先于 phase=busy：Cursor 已停在 follow-up 时及时显示空闲/等送出
  if (d.posture === "composing") return { key: "wait", label: isAgent ? `${prog}·等送出` : `${prog}·等回车` };
  if (d.posture === "prompt") return { key: "idle", label: `${prog}·空闲` };
  if (d.posture === "running" || d.phase === "busy") return { key: "run", label: `${prog}·正在跑` };
  return { key: "idle", label: `${prog}·空闲` };
}

/** 胶囊只标正在跑、等送出。空闲和「未打开」不重复写。 */
function chipFace(d) {
  if (!termLive(d) || d.phase === "starting") return null;
  if (d.posture === "composing") return termFace(d);
  if (d.posture === "running" || d.phase === "busy") return termFace(d);
  return null;
}

function botDirs() {
  return typeof botCodingDirs === "function" ? botCodingDirs(currentBot) : [];
}

/** pin 只属于当前这只 bot。换 bot 或目录已从名单拿掉就清掉；刚开起来、名单还没刷新的活终端先留着。 */
function alignPin(incoming) {
  if (!currentBot || pinBotId !== currentBot.id) {
    pinCwd = "";
    pinBotId = currentBot?.id || "";
    if (codingView?.botId && codingView.botId !== currentBot?.id) codingView = null;
  }
  if (!pinCwd) return;
  const dirs = botDirs();
  if (dirs.includes(pinCwd)) return;
  const keep = (v) => !!(v && termLive(v) && v.cwd === pinCwd && (!v.botId || v.botId === currentBot.id));
  if (keep(incoming) || keep(codingView)) return;
  pinCwd = "";
}

function lookingCwd(incoming) {
  alignPin(incoming);
  if (pinCwd) return pinCwd;
  const dirs = botDirs();
  const agent = currentBot?.agentCwd || "";
  if (agent && dirs.includes(agent)) return agent;
  return dirs[0] || "";
}

function setPin(cwd) {
  pinCwd = cwd || "";
  pinBotId = cwd ? (currentBot?.id || "") : "";
}

/** 画面跟正在看的目录走。另一块活终端的快照不能把这块面板拽走。 */
function screenFor(view, chosen) {
  if (!chosen) return null;
  if (view?.cwd === chosen) return view;
  return codingDirs.find((d) => d?.cwd === chosen && termLive(d)) || null;
}

/** 终端面板轻提示（切 CLI / 驱逐时告诉人） */
function codingToast(msg) {
  if (!msg) return;
  document.querySelectorAll(".toast.ct-toast").forEach((n) => n.remove());
  const el = document.createElement("div");
  el.className = "toast ct-toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/** 按目录记住上一回的程序，用来提示 shell↔agent 切换 */
const termProgMemo = new Map();

function noticeTermTransition(view) {
  if (!view?.cwd) return;
  const prev = termProgMemo.get(view.cwd);
  const now = termProgLabel(view);
  if (view.phase === "exited") {
    termProgMemo.delete(view.cwd);
    const why = view.exitReason || "";
    if (/太多|最久没用/.test(why)) codingToast(`终端已关掉 · ${shortDir(view.cwd)}（同时开太多，腾出位置）`);
    else if (/Coding CLI|换成|换了 CLI/.test(why)) {
      /* 紧接着会有 starting；等新程序起来再提示 */
    } else if (why && !/空闲|用户|bot 结束|应用退出|结束这块/.test(why)) {
      codingToast(`终端已关掉 · ${shortDir(view.cwd)}（${why}）`);
    }
    return;
  }
  if (view.phase === "starting" || view.phase === "idle" || view.phase === "busy") {
    if (prev && prev !== now) {
      if (now === "shell") codingToast(`已回到 shell · ${shortDir(view.cwd)}`);
      else if (prev === "shell") codingToast(`已切到 ${now} · ${shortDir(view.cwd)}`);
      else codingToast(`CLI 换成 ${now} · ${shortDir(view.cwd)}`);
    }
    termProgMemo.set(view.cwd, now);
  }
}

function termDockHidden() {
  try { return localStorage.getItem("harness.termDockHidden") === "1"; } catch { return false; }
}

function setTermDockHidden(on) {
  try { localStorage.setItem("harness.termDockHidden", on ? "1" : "0"); } catch { /* 这次关掉即可 */ }
  paintCodingDock();
  paintCodingToggle();
}

function paintCodingToggle() {
  const toggle = $("#ct-toggle");
  if (!toggle) return;
  const panel = codingTermOpen && termLive(codingView);
  const live = panel || codingDirs.some((d) => termLive(d)) || termLive(codingView);
  const dockVisible = !$("#ct-dock")?.classList.contains("hidden");
  toggle.classList.toggle("on", panel || live || dockVisible);
  toggle.title = panel ? "收起终端" : live ? "终端还开着" : dockVisible ? "隐藏终端条" : "显示终端条";
}

function hideCodingTerm() {
  codingTermCollapsed = true;
  codingTermOpen = false;
  codingTermEls().box?.classList.add("hidden");
  paintCodingDock();
  paintCodingToggle();
}

function renderCodingDirs(view) {
  const { dirs } = codingTermEls();
  if (!dirs) return;
  const seen = new Map();
  for (const cwd of (typeof botCodingDirs === "function" ? botCodingDirs(currentBot) : [])) {
    seen.set(cwd, { cwd, cold: true });
  }
  for (const d of codingDirs) {
    if (d && d.cwd && d.phase !== "exited") seen.set(d.cwd, { ...d, cold: false });
  }
  if (view && view.phase !== "exited") seen.set(view.cwd, { ...view, cold: false });
  for (const o of view?.others || []) seen.set(o.cwd, { ...seen.get(o.cwd), ...o, cold: false });
  const looking = (view && view.phase !== "exited" && view.cwd) || lookingCwd();
  dirs.innerHTML = "";
  if (seen.size < 2) return;
  for (const d of seen.values()) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ct-dir" + (d.cwd === looking ? " on" : "");
    const name = document.createElement("span");
    name.textContent = shortDir(d.cwd);
    b.append(name);
    const chip = chipFace(d);
    if (chip) {
      const st = document.createElement("span");
      st.className = "ct-dir-st";
      st.textContent = chip.label;
      b.append(st);
    }
    b.title = d.cwd;
    b.onclick = () => focusCodingDir(d.cwd);
    dirs.appendChild(b);
  }
}

let termResizing = false;

function termMaxWidth(box) {
  const parent = box.parentElement;
  if (!parent) return 960;
  return Math.max(320, parent.clientWidth - 16);
}

function clearTermWidth(box) {
  box.style.width = "";
  box.style.alignSelf = "";
  box.style.marginLeft = "";
  box.style.marginRight = "";
}

function restoreTermWidth(box) {
  const w = Number(localStorage.getItem("harness.termWidth"));
  const maxW = termMaxWidth(box);
  if (!(w >= 320) || w >= maxW - 12) {
    clearTermWidth(box);
    return;
  }
  const anchor = localStorage.getItem("harness.termAnchor") === "right" ? "right" : "left";
  const inset = Number(localStorage.getItem("harness.termInset"));
  const pad = Number.isFinite(inset) && inset >= 0 ? inset : 24;
  box.style.width = Math.min(w, maxW) + "px";
  if (anchor === "right") {
    box.style.alignSelf = "flex-end";
    box.style.marginRight = pad + "px";
    box.style.marginLeft = "auto";
  } else {
    box.style.alignSelf = "flex-start";
    box.style.marginLeft = pad + "px";
    box.style.marginRight = "auto";
  }
}

function rememberTermWidth(box) {
  const maxW = termMaxWidth(box);
  const w = Math.round(box.getBoundingClientRect().width);
  if (w >= maxW - 12) {
    clearTermWidth(box);
    try {
      localStorage.removeItem("harness.termWidth");
      localStorage.removeItem("harness.termAnchor");
      localStorage.removeItem("harness.termInset");
    } catch { /* 拉满就回到默认宽度 */ }
    return;
  }
  const parent = box.parentElement?.getBoundingClientRect();
  const rect = box.getBoundingClientRect();
  const anchor = box.style.alignSelf === "flex-end" ? "right" : "left";
  const inset = parent ? (anchor === "right" ? parent.right - rect.right : rect.left - parent.left) : 24;
  try {
    localStorage.setItem("harness.termWidth", String(w));
    localStorage.setItem("harness.termAnchor", anchor);
    localStorage.setItem("harness.termInset", String(Math.max(8, Math.round(inset))));
  } catch { /* 记不住就用这次的宽度 */ }
}

function applyTermHeight(live) {
  const box = $("#coding-term");
  if (!box || termResizing) return;
  box.classList.toggle("is-idle", !live);
  if (!live) {
    box.style.height = "";
    clearTermWidth(box);
    return;
  }
  const saved = Number(localStorage.getItem("harness.termHeight"));
  const h = saved >= 180 ? saved : 360;
  box.style.height = Math.min(h, Math.round(window.innerHeight * 0.78)) + "px";
  restoreTermWidth(box);
}

function dirBaseName(cwd) {
  const parts = String(cwd || "").split("/").filter(Boolean);
  return parts[parts.length - 1] || cwd || "";
}

function dirParent(cwd) {
  const parts = String(cwd || "").split("/").filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : "";
}

function paintTermIdle(text, chosen) {
  const { screen, host, empty, emptyText, emptyAct } = codingTermEls();
  setShown(host, false);
  setShown(screen, false);
  setShown(empty, true);
  if (emptyText) emptyText.textContent = text;
  if (emptyAct) {
    emptyAct.textContent = chosen ? "打开" : "选择目录";
    emptyAct.dataset.act = chosen ? "open" : "pick";
    setShown(emptyAct, true);
  }
}

function showCodingTerm(view) {
  const { box, title, path, status, screen, host, stop, send, brk, open, pick } = codingTermEls();
  if (!box) return;
  const chosen = lookingCwd(view);
  const mine = screenFor(view, chosen);
  codingView = mine;
  view = mine;
  const live = termLive(view);
  if (!codingTermOpen || !live) {
    box.classList.add("hidden");
    if (!live) {
      attachedCwd = "";
      attachedStartedAt = 0;
      pendingCwd = "";
    }
    paintCodingToggle();
    paintCodingDock();
    return;
  }
  box.classList.remove("hidden");
  const face = termFace(view);
  const isAgent = !!(view.program?.kind === "agent" || (view.cli && view.cli !== "shell"));
  applyTermHeight(true);
  box.classList.remove("is-bare");
  setShown(open, false);
  setShown(stop, true);
  setShown(pick, false);
  setShown(codingTermEls().hide, true);
  setShown(send, isAgent && view?.posture === "composing");
  setShown(brk, view?.posture === "running" || (view?.phase === "busy" && view?.posture !== "prompt" && view?.posture !== "composing"));
  noticeTermTransition(view);
  if (status) {
    status.textContent = "";
    status.className = "ct-status " + face.key;
    status.title = face.label;
  }
  const prog = $("#ct-prog");
  if (prog) prog.textContent = termProgLabel(view);
  if (title) title.textContent = dirBaseName(view.cwd);
  if (path) {
    path.textContent = view.cwd;
    path.title = view.cwd;
  }
  const switcher = $("#ct-switch");
  if (switcher) switcher.title = `${face.label} · 点击切换目录`;
  paintCodingToggle();
  paintCodingDock();
  const { empty } = codingTermEls();
  setShown(empty, false);
  if (xtermReady()) {
    setShown(screen, false);
    setShown(host, true);
    attachCodingScreen(view);
    return;
  }
  setShown(host, false);
  if (!screen) return;
  setShown(screen, true);
  const atBottom = screen.scrollTop + screen.clientHeight >= screen.scrollHeight - 8;
  screen.textContent = view.screen || "（等待输出）";
  if (atBottom) screen.scrollTop = screen.scrollHeight;
}

function faceShort(d) {
  const label = termFace(d).label;
  const i = label.indexOf("·");
  return i >= 0 ? label.slice(i + 1) : label;
}

function codingDirChoices() {
  const seen = new Map();
  for (const cwd of botDirs()) seen.set(cwd, { cwd, cold: true });
  for (const d of codingDirs) {
    if (d?.cwd && d.phase !== "exited") seen.set(d.cwd, { ...d, cold: false });
  }
  if (codingView && termLive(codingView)) seen.set(codingView.cwd, { ...codingView, cold: false });
  for (const o of codingView?.others || []) {
    if (o?.cwd) seen.set(o.cwd, { ...seen.get(o.cwd), ...o, cold: false });
  }
  return [...seen.values()];
}

function paintCodingDock() {
  const dock = $("#ct-dock");
  if (!dock) return;
  const inChat = !!(currentBot && !currentGroup && (typeof realmPresence === "undefined" || !realmPresence));
  const showing = codingTermOpen && termLive(codingView);
  if (!inChat || showing || termDockHidden()) {
    dock.classList.add("hidden");
    return;
  }
  dock.classList.remove("hidden");
  const chosen = lookingCwd();
  const main = $("#ct-dock-main");
  const more = $("#ct-dock-more");
  const name = $("#ct-dock-name");
  const sub = $("#ct-dock-sub");
  const act = $("#ct-dock-act");
  const liveHere = !!(codingView && termLive(codingView) && (!chosen || codingView.cwd === chosen));
  dock.classList.toggle("is-live", liveHere);
  if (!chosen) {
    if (name) name.textContent = "工程终端";
    if (sub) sub.textContent = "选一个目录，你和 Bot 看同一块屏幕";
    if (act) act.textContent = "选择";
  } else if (liveHere) {
    if (name) name.textContent = dirBaseName(chosen);
    if (sub) sub.textContent = `${termProgLabel(codingView)} · ${faceShort(codingView)}`;
    if (act) act.textContent = "展开";
  } else {
    if (name) name.textContent = dirBaseName(chosen);
    if (sub) sub.textContent = dirParent(chosen) || shortDir(chosen);
    if (act) act.textContent = "打开";
  }
  if (main) main.title = chosen || "选一个工程目录";
  if (more) more.classList.toggle("hidden", !chosen);
}

function codingDirMenu(anchor) {
  if (typeof popMenu !== "function" || !anchor) return;
  const looking = lookingCwd();
  const items = codingDirChoices().map((d) => {
    const sub = termLive(d) ? faceShort(d) : "未打开";
    return {
      html: `${esc(shortDir(d.cwd))}<span class="pf-sub">${esc(sub)}</span>`,
      on: d.cwd === looking,
      run: () => focusCodingDir(d.cwd),
    };
  });
  if (items.length) items.push("-");
  items.push({ html: "添加目录", run: () => pickCodingCwd() });
  if (termLive(codingView)) items.push({ html: "结束这块终端", run: () => stopLookingTerm() });
  popMenu(anchor, items);
}

function codingTermToggle() {
  if (codingTermOpen && termLive(codingView)) {
    hideCodingTerm();
    return;
  }
  if (termLive(codingView)) {
    focusCodingTerm();
    return;
  }
  const dock = $("#ct-dock");
  setTermDockHidden(!!dock && !dock.classList.contains("hidden"));
}

function codingTermPrimary() {
  if (codingTermOpen && termLive(codingView)) {
    hideCodingTerm();
    return;
  }
  if (termLive(codingView)) {
    focusCodingTerm();
    return;
  }
  if (lookingCwd()) openCodingHere();
  else pickCodingCwd();
}

async function stopLookingTerm() {
  if (!currentBot || !codingView?.cwd) return;
  await api.coding.stop(currentBot.id, codingView.cwd);
  syncCodingTerm();
}

async function attachCodingScreen(view) {
  const term = ensureXterm();
  if (!term || !currentBot) return;
  const started = Number(view.startedAt || 0);
  // 同目录重新打开（startedAt 变了）必须重放，不能沿用旧缓冲
  if (attachedCwd === view.cwd && attachedStartedAt === started && !pendingCwd) {
    fitCodingTerm();
    return;
  }
  const token = ++attachToken;
  pendingCwd = view.cwd;
  replayQueue = [];
  const snap = await api.coding.replay(currentBot.id, view.cwd).catch(() => ({ data: "", seq: 0 }));
  if (token !== attachToken) return;
  const extra = replayQueue.filter((x) => x.seq > (snap?.seq || 0)).map((x) => x.data).join("");
  replayQueue = [];
  pendingCwd = "";
  attachedCwd = view.cwd;
  attachedStartedAt = started;
  term.reset();
  term.write((snap?.data || "") + extra, () => fitCodingTerm());
}

async function syncCodingTerm() {
  if (!currentBot || !api.coding?.presence) {
    codingDirs = [];
    showCodingTerm(null);
    return;
  }
  const [view, all] = await Promise.all([
    api.coding.presence(currentBot.id).catch(() => null),
    api.coding.list ? api.coding.list(currentBot.id).catch(() => []) : Promise.resolve([]),
  ]);
  codingDirs = Array.isArray(all) ? all : [];
  // 同步状态可以，但不因「还有活终端」就强行弹开（用户收起后保持收起；抢焦点只在 starting / 用户打开）
  showCodingTerm(view);
}

async function focusCodingDir(cwd) {
  if (!currentBot || !cwd) return;
  codingTermCollapsed = false;
  setPin(cwd);
  const saved = await api.bots.update(currentBot.id, { agentCwd: cwd }).catch(() => null);
  if (saved?.agentCwd) setPin(saved.agentCwd);
  if (saved) currentBot = { ...currentBot, agentCwd: saved.agentCwd, agentDirs: saved.agentDirs };
  try { await api.env.set({ key: "PROJECT_ROOT", value: saved?.agentCwd || cwd, label: "工程目录", note: "正在看的工程", botId: currentBot.id }); } catch { /* 路径本身不是密钥 */ }
  const view = await api.coding.focus(currentBot.id, saved?.agentCwd || cwd).catch(() => null);
  codingTermOpen = !!(view && termLive(view));
  showCodingTerm(view);
  if (typeof renderDetails === "function" && document.querySelector("#details") && !document.querySelector("#details").classList.contains("hidden")) {
    renderDetails(currentBot);
  }
}

function focusCodingTerm() {
  codingTermCollapsed = false;
  codingTermOpen = true;
  showCodingTerm(codingView);
  if (xterm) xterm.focus();
  else codingTermEls().screen?.focus();
}

async function openCodingHere(cwd) {
  if (!currentBot) return null;
  alignPin();
  const dir = cwd || pinCwd || currentBot.agentCwd;
  const dirs = botDirs();
  if (!dir || (dirs.length && !dirs.includes(dir))) return null;
  codingTermCollapsed = false;
  codingTermOpen = true;
  setPin(dir);
  const btn = $("#ct-open");
  if (btn) btn.disabled = true;
  // 用户点「打开」只起 shell；进 Cursor/Claude 必须 Bot 调 cli.agent（会弹授权）
  const result = await api.coding.open(currentBot.id, dir).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
  if (btn) btn.disabled = false;
  const fail = result?.error || (!result?.cwd && result?.phase === undefined ? "打开失败：没有返回终端状态" : "");
  if (fail && !result?.cwd) {
    const msg = String(result?.error || fail);
    codingTermOpen = false;
    showCodingTerm(null);
    codingToast(msg);
    return null;
  }
  // 撞上活着的 Coding CLI：展示现有屏 + notice，不当失败空屏
  setPin(dir);
  const shown = result?.cwd && result.cwd !== dir ? { ...result, cwd: dir } : result;
  showCodingTerm(shown);
  if (result?.notice) {
    const { status } = codingTermEls();
    if (status) {
      status.textContent = result.program?.kind === "agent" ? (result.cli || "agent") : "说明";
      status.className = "ct-status on";
      status.title = result.notice;
    }
  }
  if (typeof renderDetails === "function" && document.querySelector("#details") && !document.querySelector("#details")?.classList.contains("hidden")) {
    renderDetails(currentBot);
  }
  return result;
}

async function pickCodingCwd() {
  if (!currentBot) return;
  const dir = await api.coding.pickDir();
  if (!dir) return;
  await focusCodingDir(dir);
  if (typeof refreshBots === "function") await refreshBots();
  const fresh = typeof botById === "function" ? botById(currentBot.id) : null;
  if (fresh) currentBot = fresh;
  await syncCodingTerm();
  if (typeof renderDetails === "function" && document.querySelector("#details") && !document.querySelector("#details").classList.contains("hidden")) {
    renderDetails(currentBot);
  }
}

function writeCodingTerm(data) {
  if (!currentBot || !codingView || codingView.phase === "exited" || !data) return;
  api.coding.write(currentBot.id, data, codingView.cwd);
}

function applyCodingBytes(e) {
  if (!currentBot || e.botId !== currentBot.id || !xterm) return;
  if (e.cwd && e.cwd === pendingCwd) {
    replayQueue.push(e);
    return;
  }
  if (e.cwd === attachedCwd) xterm.write(e.data);
}

function applyCodingScreen(view) {
  if (!currentBot || view.botId !== currentBot.id) return;
  // 活着的 starting，或 cli.agent 复用进入 busy 且面板已收起：抢焦点（僵尸 starting 不抢）
  const live = termLive(view);
  const reopenBusy = view.phase === "busy" && live && (codingTermCollapsed || !codingTermOpen);
  if (((view.phase === "starting" && live) || reopenBusy)) {
    codingTermCollapsed = false;
    codingTermOpen = true;
    setPin(view.cwd);
    showCodingTerm(view);
    return;
  }
  if (view.phase === "exited" && (lookingCwd() === view.cwd || codingView?.cwd === view.cwd)) {
    codingDirs = codingDirs.filter((d) => d.cwd !== view.cwd);
    showCodingTerm(view);
    return;
  }
  const looking = lookingCwd() || codingView?.cwd;
  if (!looking || view.cwd === looking) {
    showCodingTerm(view);
    return;
  }
  noticeTermTransition(view);
  codingDirs = codingDirs.filter((d) => d.cwd !== view.cwd);
  if (view.phase !== "exited") codingDirs.push(view);
  renderCodingDirs(codingView);
}

function bindCodingTerm() {
  const { screen, stop } = codingTermEls();
  const toggle = $("#ct-toggle");
  if (toggle) toggle.onclick = () => codingTermToggle();
  const dockMain = $("#ct-dock-main");
  if (dockMain) dockMain.onclick = () => codingTermPrimary();
  const dockMore = $("#ct-dock-more");
  if (dockMore) dockMore.onclick = (e) => { e.stopPropagation(); codingDirMenu(dockMore); };
  const dockHide = $("#ct-dock-hide");
  if (dockHide) dockHide.onclick = (e) => { e.stopPropagation(); setTermDockHidden(true); };
  const switcher = $("#ct-switch");
  if (switcher) switcher.onclick = () => codingDirMenu(switcher);
  const pick = $("#ct-pick");
  if (pick) pick.onclick = () => codingDirMenu(pick);
  const open = $("#ct-open");
  if (open) open.onclick = () => openCodingHere();
  const send = $("#ct-send");
  if (send) send.onclick = () => writeCodingTerm("\r");
  const brk = $("#ct-break");
  if (brk) brk.onclick = () => writeCodingTerm("\u0003");
  const hide = $("#ct-hide");
  if (hide) hide.onclick = () => hideCodingTerm();
  const emptyAct = $("#ct-empty-act");
  if (emptyAct) emptyAct.onclick = () => {
    if (emptyAct.dataset.act === "open") openCodingHere();
    else pickCodingCwd();
  };
  const grip = $("#ct-resize");
  const box = $("#coding-term");
  const finishResize = (handle, ev) => {
    termResizing = false;
    handle.classList.remove("is-drag");
    try { handle.releasePointerCapture(ev.pointerId); } catch { /* 已经松开 */ }
    try { localStorage.setItem("harness.termHeight", String(Math.round(box.getBoundingClientRect().height))); } catch { /* 记不住就用这次的高度 */ }
    rememberTermWidth(box);
    fitCodingTerm();
  };
  const track = (handle, onMove) => {
    handle.addEventListener("pointerdown", (e) => {
      if (!box || box.classList.contains("hidden") || box.classList.contains("is-idle")) return;
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add("is-drag");
      termResizing = true;
      const move = (ev) => onMove(ev);
      const up = (ev) => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        finishResize(handle, ev);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  };
  if (grip && box) {
    track(grip, (ev) => {
      const start = grip._drag;
      if (!start) return;
      const next = Math.min(Math.max(start.h + (start.y - ev.clientY), 180), Math.round(window.innerHeight * 0.78));
      box.style.height = next + "px";
      fitCodingTerm();
    });
    grip.addEventListener("pointerdown", (e) => {
      grip._drag = { y: e.clientY, h: box.getBoundingClientRect().height };
    });
  }
  for (const corner of [document.querySelector("#ct-corner-l"), document.querySelector("#ct-corner-r")]) {
    if (!corner || !box) continue;
    const edge = corner.dataset.corner === "left" ? "left" : "right";
    track(corner, (ev) => {
      const start = corner._drag;
      if (!start) return;
      const growX = edge === "right" ? ev.clientX - start.x : start.x - ev.clientX;
      const width = Math.min(Math.max(start.w + growX, 320), termMaxWidth(box));
      const height = Math.min(Math.max(start.h + (start.y - ev.clientY), 180), Math.round(window.innerHeight * 0.78));
      box.style.height = height + "px";
      if (width >= termMaxWidth(box) - 12) {
        clearTermWidth(box);
      } else if (edge === "right") {
        box.style.alignSelf = "flex-start";
        box.style.marginLeft = Math.max(8, start.left) + "px";
        box.style.marginRight = "auto";
        box.style.width = width + "px";
      } else {
        box.style.alignSelf = "flex-end";
        box.style.marginRight = Math.max(8, start.right) + "px";
        box.style.marginLeft = "auto";
        box.style.width = width + "px";
      }
      fitCodingTerm();
    });
    corner.addEventListener("pointerdown", (e) => {
      const parent = box.parentElement?.getBoundingClientRect();
      const rect = box.getBoundingClientRect();
      corner._drag = {
        x: e.clientX,
        y: e.clientY,
        w: rect.width,
        h: rect.height,
        left: parent ? rect.left - parent.left : 24,
        right: parent ? parent.right - rect.right : 24,
      };
    });
  }
  if (stop) stop.onclick = async () => {
    if (!currentBot || !codingView) return;
    await api.coding.stop(currentBot.id, codingView.cwd);
    syncCodingTerm();
  };
  if (screen) {
    screen.addEventListener("keydown", (e) => {
      if (xtermReady()) return;
      if (!codingView || codingView.phase === "exited") return;
      if (e.metaKey || e.altKey) return;
      if (e.ctrlKey && e.key === "c") {
        if (window.getSelection?.()?.toString()) return;
        writeCodingTerm("\u0003");
        e.preventDefault();
        return;
      }
      if (e.ctrlKey) return;
      const mapped = CT_KEYS[e.key];
      if (mapped) {
        writeCodingTerm(mapped);
        e.preventDefault();
        return;
      }
      if (e.key.length === 1) {
        writeCodingTerm(e.key);
        e.preventDefault();
      }
    });
    screen.addEventListener("paste", (e) => {
      if (xtermReady()) return;
      const text = e.clipboardData?.getData("text");
      if (!text) return;
      writeCodingTerm(text);
      e.preventDefault();
    });
  }
  api.onCodingScreen?.((view) => applyCodingScreen(view));
  api.onCodingBytes?.((e) => applyCodingBytes(e));
}

bindCodingTerm();
