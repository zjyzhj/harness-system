// 宠物窗口逻辑 — 帧动画 / 情绪 / 富渲染气泡 / 彩蛋交互
const api = window.harness;
const botId = new URLSearchParams(location.search).get("botId");
const petEl = document.getElementById("pet");
const avatarEl = document.getElementById("pet-avatar");
const spriteEl = document.getElementById("pet-sprite");
const nameEl = document.getElementById("pet-name");
const statusEl = document.getElementById("pet-status");
const bubble = document.getElementById("bubble");
const bubbleText = document.getElementById("bubble-text");
const bubbleInput = document.getElementById("bubble-input");
const bubbleSend = document.getElementById("bubble-send");
const bubbleOpen = document.getElementById("bubble-open");
const bubbleClose = document.getElementById("bubble-close");
const bubbleActions = document.getElementById("bubble-actions");

let bot = null;
let saying = false;
let eventQueue = [];
let queueTimer = null;
let mood = "idle";
let moodTimer = null;
let action = "idle";       // 帧动画动作：idle/walk/jump/sleep/celebrate/work/think
let actionTimer = null;
let frameIndex = 0;
let frameTimer = null;
let lastReplySession = null;

const MOOD_EMOJI = { idle: "🙂", happy: "😊", excited: "🤩", tired: "😪", working: "🤔", sleepy: "😴" };
// 动作 → 主情绪映射（皮肤帧由动作决定）
const ACTION_MOOD = { idle: "idle", walk: "idle", jump: "excited", sleep: "sleepy", celebrate: "happy", work: "working", think: "working" };

// ---- 帧动画引擎（T3.1）：读 bot.skinId → 动作帧轮播 ----
function setAction(a, { hold } = {}) {
  if (action === a && !hold) return;
  action = a;
  const moodOf = ACTION_MOOD[a] || "idle";
  setMood(moodOf, { seconds: hold });
  if (actionTimer) { clearTimeout(actionTimer); actionTimer = null; }
  if (hold) actionTimer = setTimeout(() => setAction("idle"), hold * 1000);
}
function refreshFrame() {
  if (document.hidden) return; // 后台窗口暂停轮播（性能）
  const frames = SKINS_FRAMES[action] || SKINS_FRAMES.idle;
  const idx = frameIndex % frames.length;
  const frame = frames[idx] || "🙂";
  if (bot?.avatarPath && action === "idle") {
    // 有形象时：头像图 + 动作帧徽章（右上角表情气泡）
    spriteEl.innerHTML = "";
    const img = document.createElement("img");
    img.src = `file://${bot.avatarPath}`;
    img.alt = bot.name || "";
    spriteEl.appendChild(img);
    const actionBadge = document.createElement("span");
    actionBadge.className = "action-badge";
    actionBadge.textContent = frame;
    spriteEl.appendChild(actionBadge);
  } else {
    spriteEl.textContent = frame;
  }
}

function setMood(m, { seconds } = {}) {
  if (mood === m && !seconds) return;
  mood = m;
  petEl.dataset.mood = m;
  const badge = document.getElementById("pet-mood-badge");
  const e = MOOD_EMOJI[m] || "🙂";
  if (badge) badge.textContent = e;
  if (moodTimer) { clearTimeout(moodTimer); moodTimer = null; }
  if (seconds) moodTimer = setTimeout(() => setMood("idle"), seconds * 1000);
}

function setStatus(state) {
  statusEl.className = "";
  void statusEl.offsetWidth;
  statusEl.classList.add(`status-${state}`);
  if (state === "running") setAction("work", { hold: 0 });
  else if (state === "error") { setMood("tired", { seconds: 6 }); setAction("think", { hold: 6 }); }
  else setAction("idle");
}

// ---- 富渲染气泡（T3.2 共用渲染器 + T3.5 工具卡） ----
function showBubble(text, { title, rich, sessionId, actions } = {}) {
  const parts = [];
  if (title) parts.push(`<div class="bubble-title">${esc("【" + title + "】")}</div>`);
  if (rich) parts.push(renderBlocks(rich));
  else if (text) parts.push(renderBlocks([{ type: "text", text }]));
  bubbleText.innerHTML = parts.join("");
  bubbleActions.classList.toggle("hidden", !sessionId);
  bubbleOpen.style.display = sessionId ? "" : "none";
  bubbleClose.style.display = sessionId ? "" : "none";
  if (sessionId) lastReplySession = sessionId;
  bubble.classList.remove("hidden");
  bubble.classList.remove("arrive");
  void bubble.offsetWidth;
  bubble.classList.add("arrive");
}

function hideBubble() { bubble.classList.add("hidden"); }

function bounce() {
  petEl.classList.remove("bounce");
  void petEl.offsetWidth;
  petEl.classList.add("bounce");
}
function pop() {
  petEl.classList.remove("pop");
  void petEl.offsetWidth;
  petEl.classList.add("pop");
}

async function send(text) {
  if (saying) return;
  saying = true;
  setStatus("running");
  bubbleText.innerHTML = '<span class="typing-dots">…思考中</span>';
  bubble.classList.remove("hidden");
  let acc = "";
  const off = api.onChatStream((chunk) => {
    if (chunk.type === "text" && chunk.text) {
      acc += chunk.text;
      bubbleText.innerHTML = renderBlocks([{ type: "text", text: acc }]);
      bubble.classList.add("arrive");
    }
  });
  try {
    const r = await api.chat.sendStream(bot.id, text);
    off();
    const content = r.result?.text || acc || "（无回复）";
    const blocks = r.result?.content;
    if (blocks?.length) {
      bubbleText.innerHTML = renderBlocks(blocks);
    } else {
      bubbleText.innerHTML = renderBlocks([{ type: "text", text: content }]);
    }
    bubbleOpen.style.display = "none"; // 正在发消息时无会话跳转（sendStream 已建会话）
    lastReplySession = r.sessionId || null;
    if (lastReplySession) { bubbleActions.classList.remove("hidden"); bubbleOpen.style.display = ""; }
    setStatus("idle");
    setMood("happy", { seconds: 4 });
    setAction("celebrate", { hold: 3 });
    petEl.classList.add("pop");
    setTimeout(() => petEl.classList.remove("pop"), 350);
  } catch (e) {
    off();
    bubbleText.innerHTML = renderBlocks([{ type: "text", text: "❌ " + (e.message || e) }]);
    setStatus("error");
  }
  saying = false;
}

// 宠物事件（任务完成/失败/回复/形象更新/主动搭话）
api.onPetEvent(async (ev) => {
  if (ev.type === "reply") {
    if (saying) {
      const blocks = [{ type: "text", text: ev.text }];
      if (ev.rich) blocks.push(...ev.rich);
      bubbleText.innerHTML = renderBlocks(blocks);
      setStatus("idle");
      saying = false;
    } else {
      eventQueue.push(ev);
      poke();
    }
  } else if (ev.type === "task-done" || ev.type === "task-error") {
    eventQueue.push({ ...ev, rich: ev.rich, sessionId: ev.sessionId });
    poke();
  } else if (ev.type === "avatar-updated") {
    const list = await api.bots.list();
    const fresh = list.find((b) => b.id === botId);
    if (fresh) { bot = fresh; refreshAppearance(); }
    showBubble(`形象已更新：${ev.text || ""}`, { title: ev.title || "新形象 ✨" });
    pop();
  } else if (ev.type === "proactive") {
    showBubble(ev.text || "", { title: ev.title || bot?.name || "宠物" });
    setAction("celebrate", { hold: 3 });
    bounce();
  }
});

function poke() {
  if (queueTimer || saying) return;
  queueTimer = setInterval(() => {
    if (queueTimer && eventQueue.length === 0) {
      clearInterval(queueTimer);
      queueTimer = null;
      return;
    }
    const ev = eventQueue.shift();
    if (ev) {
      showBubble(ev.text || "", { title: ev.title || (ev.type === "task-error" ? "任务失败 ❌" : "任务完成 ✅"), rich: ev.rich, sessionId: ev.sessionId });
      setStatus(ev.type === "task-error" ? "error" : "idle");
      setAction(ev.type === "task-error" ? "think" : "celebrate", { hold: 3 });
      bounce();
    }
  }, 4000);
}

// ---- 外观：头像/皮肤联动（T3.6） ----
function refreshAppearance() {
  if (!bot) return;
  nameEl.textContent = bot.name;
  updateSkin();
}

const SKINS = [
  { id: "default", name: "默认" },
  { id: "pixel", name: "像素" },
  { id: "cute", name: "圆润" },
];
// 皮肤帧表（与前端的 core/pet-skin.ts 对齐）
const SKINS_FRAMES = {
  idle: ["🙂", "😊", "🙂"],
  walk: ["🚶", "🏃"],
  jump: ["🤸", "🦘"],
  sleep: ["😴", "💤"],
  celebrate: ["🎉", "🥳", "🎉"],
  work: ["🤔", "🧠", "📝"],
  think: ["💭", "🤔", "💭"],
};
function updateSkin() {
  frameIndex = 0;
  refreshFrame();
}

// ---- 彩蛋交互（T3.7）：摸摸/双击 ----
function pat() {
  setAction("celebrate", { hold: 2 });
  spriteEl.style.transform = "scale(1.25)";
  setTimeout(() => (spriteEl.style.transform = ""), 300);
  showBubble("呼噜呼噜～再摸摸我嘛 🐾", {});
  setTimeout(hideBubble, 2500);
}

async function doubleClickAction() {
  setAction("jump", { hold: 2 });
  pop();
  const mem = await api.memory.retrieve(bot.id, "今天有什么开心或要紧的事");
  if (mem?.length) {
    showBubble(`我记得呢：${mem[0].content.slice(0, 60)}…`, { title: "🧠 记忆" });
  } else {
    showBubble("你在叫我吗？双击我可以换个形象哦 🎨", {});
    setTimeout(hideBubble, 3000);
  }
}

// ---- 右键菜单：对话/换形象/换皮肤/打开会话/隐藏/关闭 ----
function buildContextMenu() {
  const menu = document.createElement("div");
  menu.id = "pet-menu";
  const skinBtns = SKINS.map((s) => `<div class="menu-item" data-act="skin" data-skin="${s.id}">🎨 皮肤：${s.name}${bot?.skinId === s.id ? " ✓" : ""}</div>`).join("");
  menu.innerHTML = `
    <div class="menu-item" data-act="chat">💬 对话</div>
    <div class="menu-item" data-act="open">📂 打开最近会话</div>
    <div class="menu-item" data-act="avatar">✨ 换形象</div>
    ${skinBtns}
    <div class="menu-item" data-act="hide">🙈 隐藏</div>
    <div class="menu-item danger" data-act="close">✕ 关闭宠物</div>`;
  document.body.appendChild(menu);
  menu.querySelectorAll(".menu-item").forEach((item) => {
    item.onclick = async () => {
      menu.remove();
      const act = item.dataset.act;
      if (act === "chat") {
        bubble.classList.remove("hidden");
        bubbleText.innerHTML = "你好，我在 👋";
        setMood("excited", { seconds: 3 });
      } else if (act === "open") {
        await openMainSession();
      } else if (act === "avatar") {
        const desc = prompt("一句话描述新形象（如：一只戴围巾的橘猫，可爱）", "一只蓝色狐狸，可爱");
        if (desc) await api.persona.generate(bot.id, desc);
      } else if (act === "skin") {
        await api.bots.setSkin(bot.id, item.dataset.skin);
        bot = { ...bot, skinId: item.dataset.skin };
        updateSkin();
        showBubble(`皮肤已切换为「${SKINS.find((s) => s.id === item.dataset.skin)?.name || ""}」`);
        setTimeout(hideBubble, 2000);
      } else if (act === "hide") {
        await api.bots.setPet(bot.id, false);
      } else if (act === "close") {
        await api.bots.setPet(bot.id, false);
      }
    };
  });
  menu.addEventListener("mouseleave", () => menu.remove());
  return menu;
}

// 打开主面板并选中会话
async function openMainSession() {
  const sid = lastReplySession || (await api.pets.getLastSession?.(bot.id)) || null;
  await api.window.openSession(sid);
  if (!sid) {
    showBubble("还没有可打开的会话，先聊一句吧～", {});
    setTimeout(hideBubble, 2500);
  }
}

async function init() {
  const [bots, pets] = await Promise.all([api.bots.list(), api.pets.list()]);
  bot = bots.find((b) => b.id === botId);
  if (!bot) return;
  refreshAppearance();
  // 帧动画主循环：fps 由皮肤决定，document.hidden 暂停
  const tick = () => {
    if (document.hidden) return;
    frameIndex++;
    refreshFrame();
  };
  const fps = bot.skinId === "pixel" ? 4 : 2;
  frameTimer = setInterval(tick, 1000 / fps);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshFrame();
  });

  petEl.onclick = () => {
    if (saying) return;
    bubble.classList.toggle("hidden");
    if (!bubble.classList.contains("hidden")) bubbleText.innerHTML = "你好，我在 👋";
  };
  bubbleSend.onclick = async () => {
    const text = bubbleInput.value.trim();
    if (!text) return;
    bubbleInput.value = "";
    await send(text);
  };
  bubbleInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); bubbleSend.click(); } });
  bubbleOpen.onclick = () => openMainSession();
  bubbleClose.onclick = () => hideBubble();

  // 右键快捷菜单
  petEl.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const old = document.getElementById("pet-menu");
    if (old) old.remove();
    const menu = buildContextMenu();
    menu.style.left = Math.min(e.clientX, window.innerWidth - 150) + "px";
    menu.style.top = Math.min(e.clientY, window.innerHeight - 210) + "px";
  });

  // 彩蛋：双击 = 摸头 / 弹跳
  let lastTap = 0;
  petEl.addEventListener("click", (e) => {
    if (saying) return;
    const now = Date.now();
    if (now - lastTap < 350) { // 双击
      e.stopPropagation();
      e.preventDefault();
      lastTap = 0;
      doubleClickAction();
    } else {
      lastTap = now;
      setTimeout(() => (lastTap = 0), 400);
    }
  });

  // 空闲时随机小动作 + 情绪
  setInterval(() => {
    if (saying || document.hidden) return;
    if (Math.random() < 0.3) {
      if (Math.random() < 0.5) bounce(); else pop();
    }
    const r = Math.random();
    if (r < 0.12) setMood("happy", { seconds: 5 });
    else if (r < 0.2) setMood("tired", { seconds: 6 });
    else if (r < 0.25) { setMood("sleepy", { seconds: 8 }); setAction("sleep", { hold: 8 }); }
    else if (mood !== "working") setMood("idle");
  }, 12000);
}
init();
