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
let spriteBgSet = false; // 已设置过 background-image/size（避免每帧重设 url 引起重解码闪烁）
function refreshFrame() {
  if (document.hidden) return; // 后台窗口暂停轮播（性能）
  const sk = SKINS.find((x) => x.id === bot?.skinId);
  // 优先：spritesheet 皮肤（openpets 生态）—— background-position 播放
  if (sk?.sprite?.path && window.__spriteSkin?.[sk.id]) {
    const meta = window.__spriteSkin[sk.id];
    const spr = sk.sprite;
    const stateRow = SKIN_ACTION_ROW[action] ?? 0;
    const idx = frameIndex % spr.cols;
    const cellW = meta.cellW, cellH = meta.cellH;
    if (!spriteBgSet) {
      spriteEl.innerHTML = "";
      spriteEl.className = "sprite-playing";
      // 等比缩放显示完整帧：容器内 max 160px，宽高比保持
      const scale = Math.min(160 / cellW, 160 / cellH, 1);
      const w = Math.round(cellW * scale), h = Math.round(cellH * scale);
      spriteEl.style.backgroundImage = `url(file://${spr.path})`;
      spriteEl.style.backgroundSize = `${w * spr.cols}px ${h * spr.rows}px`;
      spriteEl.style.width = w + "px";
      spriteEl.style.height = h + "px";
      spriteBgSet = true;
    }
    // 按缩放后的帧尺寸移动背景
    const sw = parseFloat(spriteEl.style.width), sh = parseFloat(spriteEl.style.height);
    spriteEl.style.backgroundPosition = `-${Math.round(idx * sw)}px -${Math.round(stateRow * sh)}px`;
    return;
  }
  spriteEl.className = "";
  spriteEl.style.backgroundImage = "";
  spriteEl.style.width = "";
  spriteEl.style.height = "";
  spriteBgSet = false;
  const frames = skinFramesFor(bot?.skinId, action);
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
// spritesheet 状态行映射（openpets 9 行协议：idle=0 walk=1 jump=2 sleep=3 celebrate=4 work=5 think=6）
const SKIN_ACTION_ROW = { idle: 0, walk: 1, jump: 2, sleep: 3, celebrate: 4, work: 5, think: 6 };

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
function showBubble(text, { title, rich, sessionId, actions, model, xp } = {}) {
  const parts = [];
  const badge = [];
  if (title) badge.push(`<div class="bubble-title">${esc("【" + title + "】")}</div>`);
  if (model) badge.push(`<span class="model-badge">${esc(model)}</span>`);
  if (xp) badge.push(`<span class="xp-badge">+${xp} XP</span>`);
  if (badge.length) parts.push(`<div class="bubble-head">${badge.join("")}</div>`);
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
      const badge = [];
      if (ev.model) badge.push(`<span class="model-badge">${esc(ev.model)}</span>`);
      if (ev.xp) badge.push(`<span class="xp-badge">+${ev.xp} XP</span>`);
      bubbleText.innerHTML = (badge.length ? `<div class="bubble-head">${badge.join("")}</div>` : "") + renderBlocks(blocks);
      setStatus("idle");
      saying = false;
      maybeEvolve(ev.xp);
    } else {
      eventQueue.push(ev);
      poke();
    }
  } else if (ev.type === "task-done" || ev.type === "task-error") {
    eventQueue.push({ ...ev, rich: ev.rich, sessionId: ev.sessionId, model: ev.model, xp: ev.xp });
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
      showBubble(ev.text || "", { title: ev.title || (ev.type === "task-error" ? "任务失败 ❌" : "任务完成 ✅"), rich: ev.rich, sessionId: ev.sessionId, model: ev.model, xp: ev.xp });
      setStatus(ev.type === "task-error" ? "error" : "idle");
      setAction(ev.type === "task-error" ? "think" : "celebrate", { hold: 3 });
      bounce();
      maybeEvolve(ev.xp);
    }
  }, 4000);
}

// 检查 XP 是否跨级 → 播进化特效（只在等级提升时）
let lastKnownLevel = null;
function maybeEvolve(xp) {
  if (xp == null) return;
  const lv = levelFromXp(xp);
  if (lastKnownLevel != null && lv > lastKnownLevel) {
    const stage = evoStage(lv);
    celebrateEvo(lv, stage.name);
  }
  lastKnownLevel = lv;
}

// ---- 外观：头像/皮肤联动（T3.6） ----
function refreshAppearance() {
  if (!bot) return;
  nameEl.textContent = bot.name;
  updateSkin();
}

let SKINS = [];
// 品牌/主题皮肤帧表（与 core/pet-skin.ts 单一数据源一致；core 是权威，这里保留帧兜底）
const SKINS_FRAMES = {
  idle: ["🙂", "😊", "🙂"],
  walk: ["🚶", "🏃"],
  jump: ["🤸", "🦘"],
  sleep: ["😴", "💤"],
  celebrate: ["🎉", "🥳", "🎉"],
  work: ["🤔", "🧠", "📝"],
  think: ["💭", "🤔", "💭"],
};
const BRAND_FRAMES = {
  deepseek: { idle: ["🐳", "🐋", "🐳"], walk: ["🐳", "🐋"], jump: ["🐳", "💦", "🐳"], sleep: ["😴", "💤"], celebrate: ["🎉", "🐳", "🎉"], work: ["🧠", "📊", "🧠"], think: ["💭", "🐳", "💭"] },
  claude: { idle: ["🟧", "🙂", "🟧"], walk: ["🟧", "🟨"], jump: ["🟧", "⭐"], sleep: ["😴", "🟧"], celebrate: ["🟧", "🎉", "🟧"], work: ["🟧", "🤖", "🟧"], think: ["💭", "🟧", "💭"] },
  doro: { idle: ["🍡", "🌸", "🍡"], walk: ["🍡", "🍡"], jump: ["🍡", "🌸"], sleep: ["😴", "💤"], celebrate: ["🎀", "🍡", "🎀"], work: ["💻", "🍡", "💻"], think: ["💭", "🍡", "💭"] },
  guga: { idle: ["👾", "🐸", "👾"], walk: ["👾", "👾"], jump: ["👾", "💚"], sleep: ["😴", "💤"], celebrate: ["🎉", "👾", "🎉"], work: ["🛠", "👾", "🛠"], think: ["💭", "👾", "💭"] },
  grok: { idle: ["🌌", "🤖", "🌌"], walk: ["🌌", "⭐"], jump: ["🤖", "✨"], sleep: ["😴", "💤"], celebrate: ["🎉", "✨", "🎉"], work: ["🧠", "🔮", "🧠"], think: ["💭", "🤖", "💭"] },
};
function skinFramesFor(id, action) {
  const brand = BRAND_FRAMES[id];
  if (brand && brand[action]) return brand[action];
  return SKINS_FRAMES[action] || SKINS_FRAMES.idle;
}
function updateSkin() {
  frameIndex = 0;
  refreshFrame();
  // 主题色：品牌皮肤给头像描边/徽章上色
  const sk = SKINS.find((x) => x.id === bot?.skinId);
  petEl.style.setProperty("--pet-color", sk?.color || "#4F46E5");
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
  const brandSkins = SKINS.filter((s) => ["deepseek", "claude", "doro", "guga", "grok"].includes(s.id));
  const otherSkins = SKINS.filter((s) => !["deepseek", "claude", "doro", "guga", "grok"].includes(s.id));
  const skinGroup = (list) => list.map((s) => `<div class="menu-item" data-act="skin" data-skin="${s.id}"><span class="skin-dot" style="background:${s.color || "#888"}"></span> ${s.name}${bot?.skinId === s.id ? " ✓" : ""}</div>`).join("");
  menu.innerHTML = `
    <div class="menu-item" data-act="chat">💬 对话</div>
    <div class="menu-item" data-act="open">📂 打开最近会话</div>
    <div class="menu-item" data-act="avatar">✨ 换形象</div>
    <div class="menu-item" data-act="stats">📊 状态</div>
    <div class="menu-sep">🎨 品牌形象</div>
    ${skinGroup(brandSkins)}
    <div class="menu-sep">其他</div>
    ${skinGroup(otherSkins)}
    <div class="menu-item" data-act="import">🌐 从社区导入形象</div>
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
        const desc = await askInput("一句话描述新形象", "如：一只戴围巾的橘猫，可爱", "一只蓝色狐狸，可爱");
        if (desc) await api.persona.generate(bot.id, desc);
      } else if (act === "stats") {
        await showStatsHud();
      } else if (act === "import") {
        const url = await askInput("输入 openpets/petdex spritesheet URL（可到 agentpet 社区形象库找）", "https://pets.thenightwatcher.online/pets/claude-f187e74a/spritesheet.webp");
        if (url) await importCommunitySkin(url);
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
// 状态 HUD 卡（借鉴 AgentPet 右键 stats card）：bot 数据 + 记忆 + 任务 + 成长
async function showStatsHud() {
  const [mem, tasks, statuses] = await Promise.all([
    api.memory.list(bot.id).catch(() => []),
    api.tasks.list(bot.id).catch(() => []),
    api.status.list().catch(() => []),
  ]);
  const st = statuses.find((x) => x.botId === bot.id);
  const card = document.createElement("div");
  card.id = "pet-hud";
  const petState = (await api.pets.list().catch(() => [])).find((x) => x.botId === bot.id);
  const xp = (petState?.xp || 0);
  const level = levelFromXp(xp);
  const stage = evoStage(level);
  const next = evoStageNext(level);
  const nextAt = next ? next.min : level * level * 100;
  const barPct = next ? Math.min(100, ((xp - stage.min) / (next.min - stage.min)) * 100) : 100;
  card.innerHTML = `
    <div class="hud-head">
      <span class="hud-name">${esc(bot.name)}</span>
      <span class="hud-stage">${stage.name}</span>
    </div>
    <div class="hud-row"><span>等级</span><b>Lv.${level}</b></div>
    <div class="hud-bar"><div class="hud-bar-fill" style="width:${barPct}%"></div></div>
    <div class="hud-row"><span>经验</span><b>${xp}${next ? " / " + next.min : "（满级）"}</b></div>
    <div class="hud-row"><span>皮肤</span><b>${esc(SKINS.find((s) => s.id === bot.skinId)?.name || "默认")}</b></div>
    <div class="hud-row"><span>状态</span><b>${st ? esc(st.state) : "idle"}</b></div>
    <div class="hud-row"><span>记忆</span><b>${mem.length} 条</b></div>
    <div class="hud-row"><span>定时任务</span><b>${tasks.filter((t) => t.enabled).length} 个</b></div>
    <div class="hud-actions">
      <button class="hud-btn hud-open">📂 打开会话</button>
      <button class="hud-btn hud-close">关闭</button>
    </div>
    <div class="hud-foot">右键可切形象/皮肤 · 双击互动 · 对话/任务增长经验</div>`;
  document.body.appendChild(card);
  const close = () => card.remove();
  card.querySelector(".hud-open").onclick = () => { close(); openMainSession(); };
  card.querySelector(".hud-close").onclick = close;
  card.addEventListener("mouseleave", close);
  setTimeout(() => { if (document.getElementById("pet-hud")) card.remove(); }, 20000);
  return card;
}


// 探测 spritesheet 每格尺寸：优先用已持久化的 cellW/cellH，否则加载本地图片探测并回写
function probeSpriteSkin(id, spr) {
  return new Promise((resolve) => {
    if (!spr?.path) return resolve(false);
    if (spr.cellW && spr.cellH) {
      window.__spriteSkin = window.__spriteSkin || {};
      window.__spriteSkin[id] = { cellW: spr.cellW, cellH: spr.cellH };
      return resolve(true);
    }
    const img = new Image();
    img.onload = () => {
      const cellW = Math.floor(img.width / (spr.cols || 8));
      const cellH = Math.floor(img.height / (spr.rows || 9));
      if (cellW > 0 && cellH > 0) {
        window.__spriteSkin = window.__spriteSkin || {};
        window.__spriteSkin[id] = { cellW, cellH };
        api.skins.setMeta(id, { cellW, cellH }).catch(() => {});
      }
      resolve(true);
    };
    img.onerror = () => resolve(false);
    img.src = `file://${spr.path}`;
  });
}

// 导入社区 spritesheet 皮肤（openpets/petdex 生态）
async function importCommunitySkin(url) {
  const id = "c-" + Date.now().toString(36);
  const name = await askInput("给这个形象起个名字", "如：Claude 橙块", "社区宠物");
  try {
    showBubble(`正在下载社区形象…${name ? "「" + name + "」" : ""}`, {});
    const r = await api.skins.download({ id, name: name || "社区宠物", url, rows: 9, cols: 8 });
    // 下载本地路径已注册，刷新皮肤列表并应用
    SKINS = await api.skins.list();
    await api.bots.setSkin(bot.id, id);
    bot = { ...bot, skinId: id };
    // 探测 sprite 尺寸（本地文件 → 回写持久化，重启直接播放）
    const spr = SKINS.find((x) => x.id === id)?.sprite;
    await probeSpriteSkin(id, spr);
    updateSkin();
    showBubble(`已导入社区形象「${name || "社区宠物"}」！右键可继续切换 🎨`);
    pop();
  } catch (e) {
    showBubble("导入失败：" + (e.message || e), {});
  }
}


// G5.5：宠物成长等级与进化阶段（5 阶段，对齐 AgentPet 进化）
const EVO_STAGES = [
  { level: 1, name: "🥚 蛋生", min: 0 },
  { level: 2, name: "🌱 幼年", min: 200 },
  { level: 3, name: "✨ 成长", min: 500 },
  { level: 4, name: "🔥 成熟", min: 1000 },
  { level: 5, name: "👑 传说", min: 2000 },
];
function levelFromXp(xp) { return Math.floor(Math.sqrt((xp || 0) / 100)) + 1; }
function evoStage(level) {
  let stage = EVO_STAGES[0];
  for (const st of EVO_STAGES) if (level >= st.level) stage = st;
  return stage;
}
function evoStageNext(level) {
  return EVO_STAGES.find((st) => st.level > level) || null;
}

// 升级/进化特效：光环 + 弹跳 + 气泡提示
function celebrateEvo(level, stageName) {
  petEl.classList.remove("evo-ring");
  void petEl.offsetWidth;
  petEl.classList.add("evo-ring");
  setAction("celebrate", { hold: 4 });
  bounce();
  pop();
  showBubble(`✨ 进化！Lv.${level} ${stageName}`, {});
  setTimeout(hideBubble, 4000);
  // 洒落粒子
  for (let i = 0; i < 8; i++) {
    const p = document.createElement("span");
    p.className = "evo-particle";
    p.textContent = ["⭐", "✨", "🌟", "💫"][i % 4];
    p.style.left = (30 + Math.random() * 140) + "px";
    p.style.animationDuration = (0.8 + Math.random() * 0.6) + "s";
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 1600);
  }
}

async function openMainSession() {
  const sid = lastReplySession || (await api.pets.getLastSession?.(bot.id)) || null;
  await api.window.openSession(sid);
  if (!sid) {
    showBubble("还没有可打开的会话，先聊一句吧～", {});
    setTimeout(hideBubble, 2500);
  }
}

async function init() {
  const [bots, pets, skins] = await Promise.all([api.bots.list(), api.pets.list(), api.skins.list()]);
  bot = bots.find((b) => b.id === botId);
  SKINS = skins;
  if (!bot) return;
  // 初始化当前等级（避免重启后首次回复误触发进化特效）
  const petInit = pets.find((x) => x.botId === botId);
  if (petInit?.xp) lastKnownLevel = levelFromXp(petInit.xp);
  refreshAppearance();
  // 社区 sprite 皮肤：重启后自动探测/恢复每格尺寸（保证 sprite 播放而非 emoji 兜底）
  const sprSk = SKINS.find((x) => x.id === bot.skinId);
  if (sprSk?.sprite?.path) {
    // 先以 emoji 帧稳定显示，探测完成后再切 sprite（避免加载瞬间闪切）
    probeSpriteSkin(bot.skinId, sprSk.sprite).then(() => {
      spriteBgSet = false;
      refreshFrame();
    });
  }
  // 帧动画主循环：fps 由皮肤决定，document.hidden 暂停
  const tick = () => {
    if (document.hidden) return;
    frameIndex++;
    refreshFrame();
  };
  const sk = SKINS.find((x) => x.id === bot.skinId);
  const fps = sk?.fps || 2;
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
    menu.style.top = Math.min(e.clientY, window.innerHeight - 40) + "px";
    // 菜单比窗口高时上移，保证顶部可见（内容由 CSS max-height 滚动）
    const mh = menu.offsetHeight;
    if (mh > 0) menu.style.top = Math.max(0, Math.min(parseFloat(menu.style.top), window.innerHeight - mh)) + "px";
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
