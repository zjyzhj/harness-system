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
let mood = "idle";        // 情绪状态机: idle/happy/excited/tired/working
let moodTimer = null;
const MOOD_EMOJI = { idle: "🙂", happy: "😊", excited: "🤩", tired: "😪", working: "🤔", sleepy: "😴" };

function setMood(m, { seconds } = {}) {
  if (mood === m && !seconds) return;
  mood = m;
  petEl.dataset.mood = m;
  const badge = document.getElementById("pet-mood-badge");
  const e = MOOD_EMOJI[m] || "🙂";
  if (badge) badge.textContent = e;
  if (!bot?.avatarPath) emojiEl.textContent = e; // 无形象时主表情同步
  if (moodTimer) { clearTimeout(moodTimer); moodTimer = null; }
  if (seconds) moodTimer = setTimeout(() => setMood("idle"), seconds * 1000);
}

function setStatus(state) {
  statusEl.className = "";
  void statusEl.offsetWidth;
  statusEl.classList.add(`status-${state}`);
  if (state === "running") setMood("working");
  else if (state === "error") setMood("tired", { seconds: 6 });
  else setMood("idle");
}

function showBubble(text, { title } = {}) {
  const full = (title ? `【${title}】\n` : "") + text;
  bubbleText.innerHTML = tinyMarkdown(esc(full));
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
      bubbleText.innerHTML = tinyMarkdown(esc(acc));
      bubble.classList.add("arrive");
    }
  });
  try {
    const r = await api.chat.sendStream(bot.id, text);
    off();
    const content = r.result?.text || acc || "（无回复）";
    bubbleText.innerHTML = tinyMarkdown(esc(content));
    setStatus("idle");
    setMood("happy", { seconds: 4 });
    petEl.classList.add("pop");
    setTimeout(() => petEl.classList.remove("pop"), 350);
  } catch (e) {
    off();
    bubbleText.textContent = "❌ " + (e.message || e);
    setStatus("error");
  }
  saying = false;
}

// 处理宠物事件（来自 main：任务完成/失败/回复）
api.onPetEvent(async (ev) => {
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

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** 宠物气泡用的轻量 markdown：行内 code/粗体/斜体/链接 + 换行 */
function tinyMarkdown(src) {
  if (!src) return "";
  return String(src)
    .split(/\n{2,}/)
    .map((para) => {
      const t = para
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      return `<p>${t.replace(/\n/g, "<br/>")}</p>`;
    })
    .join("");
}

/** 右键快捷菜单：对话/隐藏/换形象/关闭 */
function buildContextMenu() {
  const menu = document.createElement("div");
  menu.id = "pet-menu";
  menu.innerHTML = `
    <div class="menu-item" data-act="chat">💬 对话</div>
    <div class="menu-item" data-act="avatar">🎨 换形象</div>
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
      } else if (act === "avatar") {
        const desc = prompt("一句话描述新形象（如：一只戴围巾的橘猫，可爱）", "一只蓝色狐狸，可爱");
        if (desc) await api.persona.generate(bot.id, desc);
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
  // 右键快捷菜单
  petEl.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const old = document.getElementById("pet-menu");
    if (old) old.remove();
    const menu = buildContextMenu();
    menu.style.left = Math.min(e.clientX, window.innerWidth - 130) + "px";
    menu.style.top = Math.min(e.clientY, window.innerHeight - 130) + "px";
  });
  // 空闲时随机小动作 + 情绪
  setInterval(() => {
    if (saying) return;
    if (Math.random() < 0.3) {
      if (Math.random() < 0.5) bounce(); else pop();
    }
    const r = Math.random();
    if (r < 0.12) setMood("happy", { seconds: 5 });
    else if (r < 0.2) setMood("tired", { seconds: 6 });
    else if (r < 0.25) setMood("sleepy", { seconds: 8 });
    else if (mood !== "working") setMood("idle");
  }, 12000);
}
init();
