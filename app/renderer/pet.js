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
let action = "idle";       // 动作：idle/walk/jump/sleep/celebrate/work/think
let actionTimer = null;
let frameIndex = 0;
let lastReplySession = null;
let renderMode = "emoji";  // live2d | sprite | emoji
let animTimer = null;

const DEFAULT_SKIN_ID = "live2d-hiyori";
// 动作 → 主情绪映射（驱动 data-mood，不再在宠物旁挂 emoji 徽章）
const ACTION_MOOD = { idle: "idle", walk: "idle", jump: "excited", sleep: "sleepy", celebrate: "happy", work: "working", think: "working" };

function currentSkin() {
  return SKINS.find((x) => x.id === (bot?.skinId || DEFAULT_SKIN_ID));
}

const fxEl = document.getElementById("pet-fx");
let fxTimer = null;

/** 叠加特效：只动 #pet-fx，绝不改皮肤资源 */
function playFx(spec = {}) {
  if (!fxEl) return;
  const overlay = spec.overlay || "burst";
  const color = spec.color || "#60a5fa";
  const ms = Math.min(6000, Math.max(400, Number(spec.durationMs) || 1800));
  const dir = spec.dir === "left" ? "left" : "right";
  fxEl.style.setProperty("--fx-color", color);
  fxEl.dataset.dir = dir;
  fxEl.innerHTML = "";
  if (spec.label) {
    const lab = document.createElement("div");
    lab.className = "fx-label";
    lab.textContent = spec.label;
    fxEl.appendChild(lab);
  }
  if (overlay === "beam") {
    const b = document.createElement("div");
    b.className = "fx-beam";
    fxEl.appendChild(b);
  } else if (overlay === "aura") {
    const a = document.createElement("div");
    a.className = "fx-aura";
    fxEl.appendChild(a);
  } else if (overlay === "rings") {
    const wrap = document.createElement("div");
    wrap.className = "fx-rings fx-layer";
    for (let i = 0; i < 3; i++) {
      const ring = document.createElement("i");
      ring.style.animationDelay = `${i * 0.18}s`;
      wrap.appendChild(ring);
    }
    fxEl.appendChild(wrap);
  } else if (overlay === "zzz") {
    const wrap = document.createElement("div");
    wrap.className = "fx-zzz fx-layer";
    ["z", "Z", "zz"].forEach((t, i) => {
      const s = document.createElement("span");
      s.textContent = t;
      s.style.left = `${58 + i * 8}%`;
      s.style.animationDelay = `${i * 0.25}s`;
      wrap.appendChild(s);
    });
    fxEl.appendChild(wrap);
  } else if (overlay === "shake") {
    petEl.classList.add("fx-shake");
    setTimeout(() => petEl.classList.remove("fx-shake"), ms);
  } else {
    const wrap = document.createElement("div");
    wrap.className = `fx-${overlay} fx-layer`;
    const glyph = overlay === "hearts" ? "♥" : overlay === "sweat" ? "💧" : overlay === "spark" ? "✦" : "✦";
    const n = overlay === "burst" ? 8 : 6;
    for (let i = 0; i < n; i++) {
      const s = document.createElement("span");
      s.textContent = glyph;
      const ang = (Math.PI * 2 * i) / n;
      s.style.setProperty("--dx", `${Math.cos(ang) * 54}px`);
      s.style.setProperty("--dy", `${Math.sin(ang) * 54 - 10}px`);
      s.style.color = color;
      s.style.animationDelay = `${i * 0.04}s`;
      wrap.appendChild(s);
    }
    fxEl.appendChild(wrap);
  }
  if (fxTimer) clearTimeout(fxTimer);
  fxTimer = setTimeout(() => { fxEl.innerHTML = ""; delete fxEl.dataset.dir; }, ms + 80);
}

function setAction(a, { hold } = {}) {
  if (action === a && !hold) return;
  action = a;
  const moodOf = ACTION_MOOD[a] || "idle";
  setMood(moodOf, { seconds: hold });
  if (actionTimer) { clearTimeout(actionTimer); actionTimer = null; }
  if (hold) actionTimer = setTimeout(() => setAction("idle"), hold * 1000);
  frameIndex = 0;
  if (renderMode === "live2d") live2dOnAction(a);
  else if (renderMode === "sprite") spriteSetRow(SPRITE_ACTION_ROW[a] ?? 0);
  refreshFrame();
  scheduleNext();
}

// ---- 精灵图引擎：Codex/petdex atlas（8 列 × 9 行，每行帧数与逐帧时长不同，行尾空格透明） ----
const ATLAS_ROWS = [
  { state: "idle", durations: [280, 110, 110, 140, 140, 320] },
  { state: "running-right", durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  { state: "running-left", durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  { state: "waving", durations: [140, 140, 140, 280] },
  { state: "jumping", durations: [140, 140, 140, 140, 280] },
  { state: "failed", durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  { state: "waiting", durations: [150, 150, 150, 150, 150, 260] },
  { state: "running", durations: [120, 120, 120, 120, 120, 220] },
  { state: "review", durations: [150, 150, 150, 150, 150, 280] },
];
const SPRITE_ACTION_ROW = { idle: 0, walk: 1, jump: 4, sleep: 6, celebrate: 3, work: 7, think: 8 };
const IDLE_VARIANT_ROW = 6;
let spriteRow = 0;
let spriteFrame = 0;
let spriteBgSet = false; // 已设置过 background-image/size（避免每帧重设 url 引起重解码闪烁）

function spriteMeta() {
  const sk = currentSkin();
  return sk?.sprite?.path ? window.__spriteSkin?.[sk.id] : null;
}
/** 某行实际可播帧数：优先用探测到的非空帧数，否则用规格帧数 */
function spriteFrameCount(row) {
  const meta = spriteMeta();
  const probed = meta?.rowFrames?.[row];
  if (probed) return probed;
  return ATLAS_ROWS[row]?.durations.length ?? 1;
}
function spriteFrameDuration() {
  const d = ATLAS_ROWS[spriteRow]?.durations;
  if (!d) return 140;
  const last = spriteFrame >= spriteFrameCount(spriteRow) - 1;
  return last ? d[d.length - 1] : (d[spriteFrame] ?? d[0]);
}
function spriteSetRow(row) {
  spriteRow = row;
  spriteFrame = 0;
}
function spriteAdvance() {
  spriteFrame++;
  if (spriteFrame < spriteFrameCount(spriteRow)) return;
  spriteFrame = 0;
  if (action !== "idle") return;
  // 待机一轮结束后偶尔插播一次「等待」变体，避免机械重复
  if (spriteRow === 0 && Math.random() < 0.2) spriteRow = IDLE_VARIANT_ROW;
  else spriteRow = 0;
}

function scheduleNext() {
  clearTimeout(animTimer);
  animTimer = null;
  if (document.hidden || renderMode === "live2d") return;
  const delay = renderMode === "sprite" ? spriteFrameDuration() : 1000 / (currentSkin()?.fps || 2);
  animTimer = setTimeout(() => {
    if (renderMode === "sprite") spriteAdvance(); else frameIndex++;
    refreshFrame();
    scheduleNext();
  }, delay);
}

function refreshFrame() {
  if (document.hidden || renderMode === "live2d") return;
  const sk = currentSkin();
  if (renderMode === "sprite") {
    const meta = spriteMeta();
    const spr = sk.sprite;
    if (!spriteBgSet) {
      spriteEl.innerHTML = "";
      delete spriteEl.dataset.blob;
      spriteEl.className = "sprite-playing";
      // 等比缩放显示完整帧：容器内 max 200px，宽高比保持
      const scale = Math.min(200 / meta.cellW, 200 / meta.cellH, 1);
      const w = Math.round(meta.cellW * scale), h = Math.round(meta.cellH * scale);
      spriteEl.style.backgroundImage = `url("${fileUrl(spr.path)}")`;
      spriteEl.style.backgroundSize = `${w * spr.cols}px ${h * spr.rows}px`;
      spriteEl.style.width = w + "px";
      spriteEl.style.height = h + "px";
      spriteBgSet = true;
    }
    const sw = parseFloat(spriteEl.style.width), sh = parseFloat(spriteEl.style.height);
    spriteEl.style.backgroundPosition = `-${Math.round(spriteFrame * sw)}px -${Math.round(spriteRow * sh)}px`;
    return;
  }
  const frames = skinFramesFor(sk?.id, action);
  const frame = frames[frameIndex % frames.length] || "🙂";
  if (bot?.avatarPath) {
    // 有形象时：头像图常驻（只建一次，避免每帧重建 <img> 闪烁）
    let img = spriteEl.querySelector("img");
    if (!img) {
      spriteEl.innerHTML = "";
      img = document.createElement("img");
      img.alt = bot.name || "";
      spriteEl.appendChild(img);
    }
    const src = fileUrl(bot.avatarPath);
    if (img.getAttribute("src") !== src) img.src = src;
  } else if (validAvatar(bot?.avatar)) {
    const key = `${bot.avatar.shape}|${bot.avatar.color}`;
    if (spriteEl.dataset.blob !== key) {
      spriteEl.innerHTML = blobAvatarSvg(bot.avatar, bot.id);
      spriteEl.dataset.blob = key;
    }
    spriteEl.classList.toggle("busy", action === "work" || action === "think");
  } else {
    delete spriteEl.dataset.blob;
    spriteEl.classList.remove("busy");
    spriteEl.textContent = frame;
  }
}

// ---- Live2D 引擎：pixi-live2d-display（Cubism 4/5）——待机动作随机、眨眼呼吸物理、视线跟随、触摸反应、说话口型 ----
const L2D_W = 260, L2D_H = 340;
const l2d = { app: null, model: null, skinId: null, talkUntil: 0, sleeping: false, offCursor: null };

async function loadLive2D(sk) {
  const canvas = document.getElementById("pet-live2d");
  const { Live2DModel, MotionPriority } = PIXI.live2d;
  if (!l2d.app) {
    Live2DModel.registerTicker(PIXI.Ticker);
    l2d.app = new PIXI.Application({ view: canvas, width: L2D_W, height: L2D_H, backgroundAlpha: 0, antialias: true, resolution: window.devicePixelRatio || 1, autoDensity: true });
    l2d.priority = MotionPriority;
  }
  if (l2d.skinId === sk.id && l2d.model) return;
  if (l2d.model) { l2d.app.stage.removeChild(l2d.model); l2d.model.destroy(); l2d.model = null; }
  const model = await Live2DModel.from(sk.live2d.model, { autoInteract: false });
  const s = Math.min(L2D_W / model.width, L2D_H / model.height) * (sk.live2d.scale || 1);
  model.scale.set(s);
  model.anchor.set(0.5, 1);
  model.position.set(L2D_W / 2, L2D_H);
  l2d.app.stage.addChild(model);
  l2d.model = model;
  l2d.skinId = sk.id;
  model.internalModel.on("beforeModelUpdate", () => {
    const core = model.internalModel.coreModel;
    if (Date.now() < l2d.talkUntil) {
      core.setParameterValueById("ParamMouthOpenY", 0.25 + 0.75 * Math.abs(Math.sin(Date.now() / 90)));
    }
    if (l2d.sleeping) {
      core.setParameterValueById("ParamEyeLOpen", 0);
      core.setParameterValueById("ParamEyeROpen", 0);
    }
  });
  if (!l2d.offCursor) {
    l2d.offCursor = api.onPetCursor((p) => {
      if (!l2d.model) return;
      const r = canvas.getBoundingClientRect();
      l2d.model.focus(p.x - r.left, p.y - r.top);
    });
  }
}

function live2dMotion(group) {
  const m = l2d.model;
  if (!m) return;
  const defs = m.internalModel.motionManager.definitions?.[group];
  if (!defs?.length) return;
  m.motion(group, Math.floor(Math.random() * defs.length), l2d.priority.FORCE);
}
function live2dExpression() {
  const m = l2d.model;
  const exprs = m?.internalModel.motionManager.expressionManager?.definitions;
  if (exprs?.length) m.expression(Math.floor(Math.random() * exprs.length));
}
function live2dOnAction(a) {
  l2d.sleeping = a === "sleep";
  if (a === "celebrate" || a === "jump") live2dMotion("TapBody");
  else if (a === "walk") live2dMotion("Idle") || live2dMotion("TapBody");
  else if (a === "work") { live2dMotion("TapBody"); live2dExpression(); }
  else if (a === "think" || a === "sleep") live2dExpression();
  else if (a === "idle") live2dMotion("Idle");
}
function live2dTalk(ms) {
  l2d.talkUntil = Math.max(l2d.talkUntil, Date.now() + ms);
}
/** 点击命中区域：头 → 换表情，身体 → 触摸动作 */
function live2dTap(clientX, clientY) {
  const m = l2d.model;
  if (!m) return false;
  const r = document.getElementById("pet-live2d").getBoundingClientRect();
  const hits = m.hitTest(clientX - r.left, clientY - r.top);
  if (hits.includes("Head")) { live2dExpression(); return true; }
  if (hits.includes("Body")) { live2dMotion("TapBody"); return true; }
  return false;
}

let applyToken = 0;
async function applyRenderMode() {
  const token = ++applyToken;
  const sk = currentSkin();
  const canvas = document.getElementById("pet-live2d");
  let mode = "emoji";
  if (sk?.live2d?.model && window.PIXI?.live2d) mode = "live2d";
  else if (sk?.sprite?.path && window.__spriteSkin?.[sk.id]) mode = "sprite";
  if (mode === "live2d") {
    try {
      await loadLive2D(sk);
    } catch (e) {
      console.error("[pet] Live2D 加载失败，降级 emoji", e);
      mode = "emoji";
    }
  }
  if (token !== applyToken) return;
  renderMode = mode;
  spriteBgSet = false;
  petEl.classList.toggle("live2d", mode === "live2d");
  canvas.classList.toggle("hidden", mode !== "live2d");
  spriteEl.classList.toggle("hidden", mode === "live2d");
  if (l2d.app) mode === "live2d" ? l2d.app.start() : l2d.app.stop();
  if (mode !== "sprite") {
    spriteEl.className = mode === "live2d" ? "hidden" : "";
    spriteEl.style.backgroundImage = "";
    spriteEl.style.width = "";
    spriteEl.style.height = "";
    spriteBgSet = false;
  } else {
    spriteSetRow(SPRITE_ACTION_ROW[action] ?? 0);
  }
  // 清空内容时必须清掉 blob 缓存键，否则二次 apply 会跳过重绘 → 透明空壳
  spriteEl.innerHTML = "";
  delete spriteEl.dataset.blob;
  frameIndex = 0;
  refreshFrame();
  scheduleNext();
}

function setMood(m, { seconds } = {}) {
  if (mood === m && !seconds) return;
  mood = m;
  petEl.dataset.mood = m;
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
  // 一句话改宠物：命中意图则本地执行，不走整轮闲聊
  try {
    const directed = await api.pet.direct(bot.id, text);
    if (directed?.handled) {
      bubbleText.innerHTML = renderBlocks([{ type: "text", text: directed.message || "好的。" }]);
      bubbleActions.classList.add("hidden");
      setStatus("idle");
      setMood("happy", { seconds: 4 });
      setAction("celebrate", { hold: 2 });
      pop();
      const intents = String(directed.intent || "");
      if (/setSkin|installPetdex|generatePersona|revertSkin/.test(intents)) {
        bot = (await api.bots.list()).find((b) => b.id === bot.id) || bot;
        SKINS = await api.skins.list();
        await updateSkin();
      }
      saying = false;
      return;
    }
  } catch (e) {
    /* 解析失败则走普通对话 */
  }
  let acc = "";
  const off = api.onChatStream((chunk) => {
    if (chunk.type === "text" && chunk.text) {
      acc += chunk.text;
      live2dTalk(Math.min(4000, 400 + chunk.text.length * 60));
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
    bubbleOpen.style.display = "none";
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
  } else if (ev.type === "proactive" || ev.type === "companion" || ev.type === "companion-work" || ev.type === "companion-appear" || ev.type === "say") {
    showBubble(ev.text || "", { title: ev.title || bot?.name || "宠物", sessionId: ev.sessionId });
    setAction(ev.action || (ev.type === "companion-work" ? "work" : "celebrate"), { hold: ev.hold ?? 3 });
    bounce();
  } else if (ev.type === "action") {
    if (ev.action) setAction(ev.action, { hold: ev.hold ?? 3 });
    if (ev.action === "jump" || ev.action === "celebrate") { bounce(); pop(); }
  } else if (ev.type === "fx") {
    if (ev.fx) playFx(ev.fx);
    if (ev.action) setAction(ev.action, { hold: ev.hold ?? 2 });
    if (ev.text) showBubble(ev.text, { title: ev.title || "特效" });
    bounce();
    pop();
    setTimeout(hideBubble, Math.min(3500, (ev.fx?.durationMs || 1800) + 800));
  } else if (ev.type === "visit") {
    showBubble(ev.text || "", { title: ev.title || "串门" });
    setAction(ev.action || "celebrate", { hold: ev.hold ?? 4 });
    setMood(ev.role === "guest" ? "excited" : "happy", { seconds: 5 });
    bounce();
    pop();
  } else if (ev.type === "skin-updated") {
    SKINS = await api.skins.list();
    bot = (await api.bots.list()).find((b) => b.id === botId) || bot;
    await updateSkin();
    showBubble(ev.text || "形象已更新");
    setTimeout(hideBubble, 2500);
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
  return updateSkin();
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
async function updateSkin() {
  // 主题色：品牌皮肤给头像描边/徽章上色
  const sk = currentSkin();
  petEl.style.setProperty("--pet-color", sk?.color || "#4F46E5");
  if (sk?.sprite?.path && !window.__spriteSkin?.[sk.id]) await probeSpriteSkin(sk.id, sk.sprite);
  await applyRenderMode();
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
  const live2dSkins = SKINS.filter((s) => s.live2d);
  const spriteSkins = SKINS.filter((s) => s.sprite);
  const shapeSkins = SKINS.filter((s) => s.shape);
  const activeId = activeSkinId();
  const skinGroup = (list) => list.map((s) => `<div class="menu-item" data-act="skin" data-skin="${s.id}"><span class="skin-dot" style="background:${s.color || "#888"}"></span> ${s.name}${activeId === s.id ? " ✓" : ""}</div>`).join("");
  // 异步 prefs 稍后再填勾选；先占位
  menu.innerHTML = `
    <div class="menu-item" data-act="design">✨ 一句话设计…</div>
    <div class="menu-item" data-act="chat">💬 对话</div>
    <div class="menu-item" data-act="gallery">🌟 形象库</div>
    <div class="menu-item" data-act="open">📂 打开会话</div>
    <div class="menu-sep">🎀 Live2D</div>
    ${skinGroup(live2dSkins)}
    ${shapeSkins.length ? `<div class="menu-sep">🎨 代码形状</div>${skinGroup(shapeSkins)}` : ""}
    ${spriteSkins.length ? `<div class="menu-sep">🌟 已下载</div>${skinGroup(spriteSkins)}` : ""}
    <div class="menu-item" data-act="visit">🏠 去拜访伙伴…</div>
    <div class="menu-item" data-act="visit-log">📒 拜访记录</div>
    <div class="menu-item" data-act="evolve-log">🌱 进化历史</div>
    <div class="menu-item" data-act="stats">📊 状态</div>
    <div class="menu-item" data-act="hide">🙈 暂时藏起来</div>`;
  document.body.appendChild(menu);
  menu.querySelectorAll(".menu-item").forEach((item) => {
    item.onclick = async () => {
      const act = item.dataset.act;
      menu.remove();
      if (act === "design") {
        const line = await askInput(
          "一句话设计我",
          "换成咕嘎 / 安静一点 / 生成戴耳机的橘猫 / 半小时后提醒我喝水",
          "换成咕嘎，话少一点",
        );
        if (!line?.trim()) return;
        bubble.classList.remove("hidden");
        bubbleInput.value = "";
        await send(line.trim());
      } else if (act === "chat") {
        bubble.classList.remove("hidden");
        bubbleText.innerHTML = "直接说你想要的就行<br/><span style=\"opacity:.7;font-size:12px\">换成咕嘎 · 安静一点 · 提醒我…</span>";
        setMood("excited", { seconds: 3 });
        setTimeout(() => bubbleInput.focus(), 50);
      } else if (act === "open") {
        await openMainSession();
      } else if (act === "visit") {
        const prefs = await api.pet.prefs().catch(() => null);
        if (!prefs?.petVisit) {
          showBubble("多宠互访已关闭。到设置 → 桌面宠物智能里打开后再来。");
          setTimeout(hideBubble, 3500);
          return;
        }
        await openVisitPicker();
      } else if (act === "visit-log") {
        await openVisitHistory();
      } else if (act === "evolve-log") {
        await openEvolveHistory();
      } else if (act === "stats") {
        await showStatsHud();
      } else if (act === "gallery") {
        await openGallery();
      } else if (act === "skin") {
        await applySkin(item.dataset.skin);
        showBubble(`已换上「${SKINS.find((s) => s.id === item.dataset.skin)?.name || ""}」`);
        setTimeout(hideBubble, 2000);
      } else if (act === "hide") {
        // 只藏窗口，不关 petEnabled——托盘「全部显示」即可回来
        await api.pets.hide(bot.id);
      }
    };
  });
  menu.addEventListener("mouseleave", () => menu.remove());
  return menu;
}

async function openVisitPicker() {
  document.getElementById("pet-panel")?.remove();
  const peers = await api.pets.peers(bot.id).catch(() => []);
  const box = document.createElement("div");
  box.id = "pet-panel";
  box.innerHTML = `
    <div class="g-head"><span>🏠 去拜访</span><span class="g-close">✕</span></div>
    <div class="g-list">${peers.length
      ? peers.map((p) => `<div class="g-item" data-id="${esc(p.id)}"><span>${esc(p.name)}</span><span class="g-tag">拜访</span></div>`).join("")
      : '<div class="g-hint">还没有其他上台的桌宠。先给另一个 bot 打开桌面宠物，或让我「再做一个伙伴」。</div>'}</div>
    <div class="g-hint">点名字就会跑过去串门一会儿</div>`;
  document.body.appendChild(box);
  box.querySelector(".g-close").onclick = () => box.remove();
  box.querySelectorAll(".g-item").forEach((el) => {
    el.onclick = async () => {
      box.remove();
      try {
        await api.pets.visit(bot.id, el.dataset.id);
      } catch (e) {
        showBubble("拜访失败：" + (e.message || e));
      }
    };
  });
}

async function openVisitHistory() {
  document.getElementById("pet-panel")?.remove();
  const rows = await api.pets.visitHistory(bot.id).catch(() => []);
  const box = document.createElement("div");
  box.id = "pet-panel";
  box.innerHTML = `
    <div class="g-head"><span>📒 拜访记录</span><span class="g-close">✕</span></div>
    <div class="g-list">${rows.length
      ? rows.map((r) => {
          const mine = r.fromId === bot.id;
          const peer = mine ? r.toName : r.fromName;
          const line = mine ? r.lineFrom : r.lineTo;
          const when = new Date(r.at).toLocaleString();
          return `<div class="g-item g-hist">
            <span class="g-left"><span>${mine ? "去找" : "来访"} ${esc(peer)}</span>
            <span class="g-sub">${esc(line)} · ${esc(when)}</span></span>
            <span class="g-tag">${mine ? "出门" : "接待"}</span>
          </div>`;
        }).join("")
      : '<div class="g-hint">还没有拜访。右键「去拜访伙伴」，或等空闲时自动串门。</div>'}</div>`;
  document.body.appendChild(box);
  box.querySelector(".g-close").onclick = () => box.remove();
}

async function openEvolveHistory() {
  document.getElementById("pet-panel")?.remove();
  const rows = await api.pet.evolveHistory(bot.id).catch(() => []);
  const statusLabel = { pending: "待确认", accepted: "已接受", rejected: "已拒绝" };
  const box = document.createElement("div");
  box.id = "pet-panel";
  box.innerHTML = `
    <div class="g-head"><span>🌱 进化历史</span><span class="g-close">✕</span></div>
    <div class="g-list">${rows.length
      ? rows.map((r) => `<div class="g-item g-hist" data-id="${esc(r.id)}" data-st="${esc(r.status)}">
          <span class="g-left"><span>${esc(r.title)}</span>
          <span class="g-sub">${esc(r.detail || "").slice(0, 72)}${(r.detail || "").length > 72 ? "…" : ""}</span></span>
          <span class="g-tag ${r.status === "accepted" ? "ok" : ""}">${statusLabel[r.status] || r.status}</span>
        </div>`).join("")
      : '<div class="g-hint">还没有进化记录。多聊、纠正我、或升级后，我会来问你要不要变一点。</div>'}</div>
    <div class="g-hint">待确认的回「好」接受、「不要」算了</div>`;
  document.body.appendChild(box);
  box.querySelector(".g-close").onclick = () => box.remove();
  box.querySelectorAll(".g-hist[data-st=pending]").forEach((el) => {
    el.onclick = async () => {
      const ok = confirm("接受这条进化提议？");
      box.remove();
      await send(ok ? "好" : "不要");
    };
  });
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
      <button class="hud-btn hud-evolve">🌱 进化</button>
      <button class="hud-btn hud-open">📂 会话</button>
      <button class="hud-btn hud-close">关闭</button>
    </div>
    <div class="hud-foot">右键：拜访伙伴 · 进化历史 · 形象库</div>`;
  document.body.appendChild(card);
  const close = () => card.remove();
  card.querySelector(".hud-evolve").onclick = () => { close(); openEvolveHistory(); };
  card.querySelector(".hud-open").onclick = () => { close(); openMainSession(); };
  card.querySelector(".hud-close").onclick = close;
  card.addEventListener("mouseleave", close);
  setTimeout(() => { if (document.getElementById("pet-hud")) card.remove(); }, 20000);
  return card;
}


/** 每行从第 0 列起连续的非空帧数（行尾透明格不播放，否则会闪空帧） */
function countRowFrames(img, rows, cols, cellW, cellH) {
  const c = document.createElement("canvas");
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const out = [];
  for (let r = 0; r < rows; r++) {
    let n = 0;
    for (; n < cols; n++) {
      const data = ctx.getImageData(n * cellW, r * cellH, cellW, cellH).data;
      let opaque = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 8 && ++opaque > 40) break;
      if (opaque <= 40) break;
    }
    out.push(n);
  }
  return out;
}

// 探测 spritesheet 每格尺寸 + 每行真实帧数；尺寸回写持久化
function probeSpriteSkin(id, spr) {
  return new Promise((resolve) => {
    if (!spr?.path) return resolve(false);
    const img = new Image();
    img.onload = () => {
      const cols = spr.cols || 8;
      const cellW = spr.cellW || Math.floor(img.width / cols);
      // 行数按 192×208 格子比例从图片推算（V1 9 行 / V2 带注视方向 11 行），不信任导入时写死的 9
      const rows = spr.cellH ? (spr.rows || 9) : Math.max(1, Math.round(img.height / (cellW * 208 / 192)));
      const cellH = spr.cellH || Math.floor(img.height / rows);
      if (cellW <= 0 || cellH <= 0) return resolve(false);
      spr.rows = rows;
      let rowFrames = null;
      try { rowFrames = countRowFrames(img, rows, cols, cellW, cellH); } catch (e) { console.warn("[pet] 帧探测失败，按规格帧数播放", e); }
      window.__spriteSkin = window.__spriteSkin || {};
      window.__spriteSkin[id] = { cellW, cellH, rowFrames };
      if (!spr.cellH) api.skins.setMeta(id, { cellW, cellH, rows }).catch(() => {});
      resolve(true);
    };
    img.onerror = () => resolve(false);
    img.src = fileUrl(spr.path);
  });
}

async function applySkin(id) {
  await api.bots.setSkin(bot.id, id);
  bot = { ...bot, skinId: id };
  await updateSkin();
}

/** 形象库：推荐（Doro/咕嘎/短视频/AI 娘化）+ 搜索 petdex 全库，点击下载并换上 */
async function openGallery() {
  document.getElementById("pet-gallery")?.remove();
  const box = document.createElement("div");
  box.id = "pet-gallery";
  box.innerHTML = `
    <div class="g-head"><span>🌟 形象库</span><span class="g-close">✕</span></div>
    <input placeholder="搜索 petdex 社区 5000+ 形象，如 doro / 咕嘎 / 初音" />
    <div class="g-list"><div class="g-hint">加载中…</div></div>
    <div class="g-hint">来自 petdex.dev 社区作品，点选即下载并换上 · 输入关键词搜全库</div>`;
  document.body.appendChild(box);
  const list = box.querySelector(".g-list");
  const thumbStyle = (url) => url
    ? `style="background-image:url('${String(url).replace(/'/g, "%27")}')"`
    : "";
  const item = (slug, id, name, installed, thumb) =>
    `<div class="g-item" data-slug="${esc(slug)}" data-id="${esc(id)}" data-name="${esc(name)}">
      <span class="g-left"><i class="g-thumb" ${thumbStyle(thumb)}></i><span>${esc(name)}</span></span>
      <span class="g-tag ${installed ? "ok" : ""}">${installed ? (activeSkinId() === id ? "使用中" : "已安装") : "下载"}</span>
    </div>`;
  const renderRecommended = async () => {
    const rec = await api.skins.recommended();
    if (!rec.length) {
      list.innerHTML = '<div class="g-hint">推荐列表为空，试试搜索 doro / 咕嘎</div>';
      return;
    }
    const groups = {};
    for (const r of rec) (groups[r.group] ||= []).push(r);
    list.innerHTML = Object.entries(groups)
      .map(([g, rs]) => `<div class="g-group">${esc(g)}</div>` + rs.map((r) => item(r.slug, r.id, r.name, r.installed, r.thumb)).join(""))
      .join("");
  };
  let searchTimer = null;
  const input = box.querySelector("input");
  input.addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    searchTimer = setTimeout(async () => {
      if (!q) return renderRecommended();
      list.innerHTML = '<div class="g-hint">正在搜 petdex 全库…</div>';
      try {
        const rs = await api.skins.catalog(q);
        const ids = new Set(SKINS.map((s) => s.id));
        list.innerHTML = rs.length
          ? rs.map((r) => item(r.slug, r.id, r.displayName, ids.has(r.id), r.thumb)).join("")
          : `<div class="g-hint">没找到「${esc(q)}」，换 doro / miku / clawd 试试</div>`;
      } catch (err) {
        list.innerHTML = `<div class="g-hint">搜索失败：${esc(err.message || err)}（需能访问 petdex.dev）</div>`;
      }
    }, 300);
  });
  // Enter 立即搜，不等 debounce
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      clearTimeout(searchTimer);
      input.dispatchEvent(new Event("input"));
    }
  });
  list.addEventListener("click", async (e) => {
    const it = e.target.closest(".g-item");
    if (!it) return;
    const tag = it.querySelector(".g-tag");
    try {
      if (!SKINS.some((s) => s.id === it.dataset.id)) {
        tag.textContent = "下载中…";
        await api.skins.installPetdex(it.dataset.slug, it.dataset.name);
        SKINS = await api.skins.list();
      }
      await applySkin(it.dataset.id);
      list.querySelectorAll(".g-tag").forEach((t) => { if (t.textContent === "使用中") t.textContent = "已安装"; });
      tag.textContent = "使用中";
      tag.classList.add("ok");
    } catch (err) {
      tag.textContent = "失败";
      showBubble("下载失败：" + (err.message || err));
    }
  });
  box.querySelector(".g-close").onclick = () => box.remove();
  renderRecommended().catch((err) => (list.innerHTML = `<div class="g-hint">加载失败：${esc(err.message || err)}</div>`));
  setTimeout(() => input.focus(), 50);
}
function activeSkinId() { return bot?.skinId || DEFAULT_SKIN_ID; }

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
    await updateSkin();
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
  setupLayout();
  await refreshAppearance();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { refreshFrame(); scheduleNext(); }
  });

  petEl.onclick = (e) => {
    if (saying) return;
    if (renderMode === "live2d" && live2dTap(e.clientX, e.clientY) && !bubble.classList.contains("hidden")) return;
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
    if (renderMode !== "live2d" && Math.random() < 0.3) {
      if (Math.random() < 0.5) bounce(); else pop();
    }
    const r = Math.random();
    if (r < 0.12) setMood("happy", { seconds: 5 });
    else if (r < 0.2) setMood("tired", { seconds: 6 });
    else if (r < 0.25) { setMood("sleepy", { seconds: 8 }); setAction("sleep", { hold: 8 }); }
    else if (mood !== "working") setMood("idle");
  }, 12000);
}

/**
 * 布局：宠物钉在窗口底部，气泡/HUD 放在宠物上方（--pet-h 跟随宠物实际高度）；
 * 窗口其余透明区域鼠标穿透，不挡桌面。
 */
function setupLayout() {
  const syncPetH = () => document.documentElement.style.setProperty("--pet-h", petEl.offsetHeight + "px");
  new ResizeObserver(syncPetH).observe(petEl);
  syncPetH();
  let ignoring = null;
  const setIgnore = (v) => {
    if (v === ignoring) return;
    ignoring = v;
    api.pets.setIgnoreMouse(v);
  };
  setIgnore(true);
  window.addEventListener("mousemove", (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const solid = el && el !== document.body && el !== document.documentElement;
    setIgnore(!solid);
  });
  window.addEventListener("mouseleave", () => setIgnore(true));
  setupDrag();
}

/** 拖动：按下宠物移动超过阈值即进入拖动（窗口由主进程跟随鼠标），松手落地；拖动后的 click 不触发气泡 */
function setupDrag() {
  let down = null;
  let dragging = false;
  let suppressClick = false;
  petEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    down = { x: e.screenX, y: e.screenY };
    dragging = false;
    petEl.setPointerCapture(e.pointerId);
  });
  petEl.addEventListener("pointermove", (e) => {
    if (!down || dragging) return;
    if (Math.hypot(e.screenX - down.x, e.screenY - down.y) < 4) return;
    dragging = true;
    api.pets.drag("start");
    petEl.classList.add("dragging");
    setAction("walk");
  });
  const end = () => {
    if (!down) return;
    down = null;
    if (!dragging) return;
    dragging = false;
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 0);
    api.pets.drag("end");
    petEl.classList.remove("dragging");
    setAction("jump", { hold: 1 });
  };
  petEl.addEventListener("pointerup", end);
  petEl.addEventListener("pointercancel", end);
  window.addEventListener("blur", end);
  window.addEventListener("click", (e) => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);
}

init();
