const api = window.harness;
const botId = new URLSearchParams(location.search).get("botId");
const petEl = document.getElementById("pet");
const avatarEl = document.getElementById("pet-avatar");
const emojiEl = document.getElementById("pet-emoji");
const nameEl = document.getElementById("pet-name");
const statusEl = document.getElementById("pet-status");
const bubble = document.getElementById("bubble");
const bubbleText = document.getElementById("bubble-text");
const bubbleInput = document.getElementById("bubble-input");
const bubbleSend = document.getElementById("bubble-send");

let bot = null;
let saying = false;       // 正在发消息
let eventQueue = [];      // 未读事件队列（如回复推送到未打开的气泡）
let queueTimer = null;

function setStatus(state) {
  statusEl.className = "";
  void statusEl.offsetWidth;
  statusEl.classList.add(`status-${state}`);
}

function showBubble(text, { title } = {}) {
  bubbleText.textContent = (title ? `【${title}】\n` : "") + text;
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
  bubbleText.textContent = "…思考中";
  bubble.classList.remove("hidden");
  const msgs = await api.chat.send(bot.id, text);
  const reply = msgs.filter((m) => m.from === bot.id).pop();
  const content = reply?.content || "（无回复）";
  bubbleText.textContent = content;
  setStatus("idle");
  saying = false;
  petEl.classList.add("pop");
  setTimeout(() => petEl.classList.remove("pop"), 350);
}

// 处理宠物事件（来自 main：任务完成/失败/回复）
api.onPetEvent((ev) => {
  if (ev.type === "reply") {
    // 正在等回复时替换气泡；否则排队提醒
    if (saying) {
      bubbleText.textContent = ev.text;
      setStatus("idle");
      saying = false;
    } else {
      eventQueue.push(ev);
      poke();
    }
  } else if (ev.type === "task-done" || ev.type === "task-error") {
    eventQueue.push(ev);
    poke();
  } else if (ev.type === "avatar-updated") {
    // 形象已更新：重新拉取 bot 并刷新外观 + 弹「变身」气泡
    const list = await api.bots.list();
    const fresh = list.find((b) => b.id === botId);
    if (fresh) { bot = fresh; refreshAppearance(); }
    showBubble(`形象已更新：${ev.text || ""}`, { title: ev.title || "新形象 ✨" });
    pop();
  } else if (ev.type === "proactive") {
    // 主动搭话：立即弹气泡并弹跳
    showBubble(ev.text || "", { title: ev.title || bot?.name || "宠物" });
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
      showBubble(ev.text || "", { title: ev.title || (ev.type === "task-done" ? "任务完成 ✅" : "任务失败 ❌") });
      setStatus(ev.type === "task-error" ? "error" : "idle");
      bounce();
    }
  }, 4000);
}

function refreshAppearance() {
  if (!bot) return;
  nameEl.textContent = bot.name;
  if (bot.avatarPath) {
    avatarEl.innerHTML = `<img src="file://${bot.avatarPath}" />`;
  } else {
    avatarEl.innerHTML = `<span id="pet-emoji">${bot.name?.slice(0, 1) || "🤖"}</span>`;
  }
}

async function init() {
  const [bots, pets] = await Promise.all([api.bots.list(), api.pets.list()]);
  bot = bots.find((b) => b.id === botId);
  if (!bot) return;
  refreshAppearance();
  petEl.onclick = () => {
    if (saying) return;
    bubble.classList.toggle("hidden");
    if (!bubble.classList.contains("hidden")) bubbleText.textContent = "你好，我在 👋";
  };
  bubbleSend.onclick = async () => {
    const text = bubbleInput.value.trim();
    if (!text) return;
    bubbleInput.value = "";
    await send(text);
  };
  bubbleInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); bubbleSend.click(); } });
  // 空闲时随机小动作
  setInterval(() => {
    if (!saying && Math.random() < 0.3) {
      if (Math.random() < 0.5) bounce(); else pop();
    }
  }, 12000);
}
init();
