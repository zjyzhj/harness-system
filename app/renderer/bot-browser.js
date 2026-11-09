// Bot 内部浏览器面板：chrome 在 renderer；页面由主进程 WebContentsView 盖在 #bb-stage 上。
let botBrowserOpen = false;
let botBrowserState = null;
let bbHeight = 360;

function bbEls() {
  return {
    box: $("#bot-browser"),
    stage: $("#bb-stage"),
    url: $("#bb-url"),
    status: $("#bb-status"),
    toggle: $("#bb-toggle"),
  };
}

function showBotBrowser(on) {
  const { box, toggle } = bbEls();
  if (!box) return;
  botBrowserOpen = !!on;
  box.classList.toggle("hidden", !on);
  toggle?.classList.toggle("on", !!on);
  if (on) {
    // 与终端互斥：开浏览器时收起终端，避免两块抢下半屏
    if (typeof showCodingTerm === "function" && typeof codingTermOpen !== "undefined" && codingTermOpen) {
      try { showCodingTerm(false); } catch { /* */ }
    }
    box.style.height = `${bbHeight}px`;
    if (currentBot) {
      api.browser.show(currentBot.id, true);
      api.browser.focus(currentBot.id);
      syncBrowserBounds();
      void refreshBrowserState();
    }
  } else if (currentBot) {
    api.browser.show(currentBot.id, false);
    api.browser.bounds(currentBot.id, { x: 0, y: 0, width: 0, height: 0 });
  }
}

function syncBrowserBounds() {
  if (!botBrowserOpen || !currentBot) return;
  const { stage } = bbEls();
  if (!stage) return;
  const r = stage.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  // Electron setBounds 用 DIP；getBoundingClientRect 已是 CSS 像素
  api.browser.bounds(currentBot.id, {
    x: Math.round(r.left),
    y: Math.round(r.top),
    width: Math.round(r.width),
    height: Math.round(r.height),
  });
  void dpr;
}

async function refreshBrowserState() {
  if (!currentBot) return;
  botBrowserState = await api.browser.state(currentBot.id).catch(() => null);
  applyBrowserState(botBrowserState);
}

function applyBrowserState(st) {
  botBrowserState = st;
  const { url, status } = bbEls();
  if (!url) return;
  if (st?.url && document.activeElement !== url) url.value = st.url === "about:blank" ? "" : st.url;
  if (status) {
    status.textContent = !st || st.phase === "closed"
      ? "未打开"
      : st.loading || st.phase === "loading"
        ? "加载中…"
        : st.phase === "error"
          ? (st.error || "出错")
          : (st.title || "就绪");
  }
  if (st && st.phase !== "closed" && !botBrowserOpen) showBotBrowser(true);
}

async function openBotBrowser(url) {
  if (!currentBot) return;
  showBotBrowser(true);
  const r = await api.browser.open(currentBot.id, url || undefined);
  if (r?.ok === false) alert(r.error || "打开失败");
  await refreshBrowserState();
  syncBrowserBounds();
}

async function gotoBotBrowser() {
  if (!currentBot) return;
  const { url } = bbEls();
  const raw = (url?.value || "").trim();
  if (!raw) return;
  showBotBrowser(true);
  const r = await api.browser.goto(currentBot.id, raw);
  if (r?.ok === false) alert(r.error || "前往失败");
  await refreshBrowserState();
}

function bindBotBrowser() {
  const { box, url } = bbEls();
  if (!box) return;
  $("#bb-toggle")?.addEventListener("click", () => {
    if (botBrowserOpen) showBotBrowser(false);
    else void openBotBrowser();
  });
  $("#bb-hide")?.addEventListener("click", () => showBotBrowser(false));
  $("#bb-go")?.addEventListener("click", () => void gotoBotBrowser());
  $("#bb-back")?.addEventListener("click", async () => {
    if (!currentBot) return;
    await api.browser.back(currentBot.id);
    await refreshBrowserState();
  });
  $("#bb-reload")?.addEventListener("click", async () => {
    if (!currentBot) return;
    await api.browser.reload(currentBot.id);
    await refreshBrowserState();
  });
  $("#bb-stop")?.addEventListener("click", async () => {
    if (!currentBot) return;
    await api.browser.stop(currentBot.id);
    showBotBrowser(false);
    applyBrowserState(null);
  });
  url?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void gotoBotBrowser();
    }
  });
  const resize = $("#bb-resize");
  if (resize) {
    let startY = 0;
    let startH = 0;
    const onMove = (e) => {
      const dy = startY - e.clientY;
      bbHeight = Math.min(Math.max(startH + dy, 200), Math.floor(window.innerHeight * 0.7));
      box.style.height = `${bbHeight}px`;
      syncBrowserBounds();
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    resize.addEventListener("pointerdown", (e) => {
      startY = e.clientY;
      startH = box.getBoundingClientRect().height;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }
  window.addEventListener("resize", () => { if (botBrowserOpen) syncBrowserBounds(); });
  api.onBrowserState?.((st) => {
    if (!currentBot || st?.botId !== currentBot.id) return;
    applyBrowserState(st);
  });
}

/** 切换 bot 时同步面板与宿主视图 */
function syncBotBrowser() {
  if (!currentBot) {
    showBotBrowser(false);
    return;
  }
  void refreshBrowserState().then(() => {
    if (botBrowserOpen) {
      api.browser.show(currentBot.id, true);
      syncBrowserBounds();
    }
  });
}

bindBotBrowser();
