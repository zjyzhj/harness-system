// 输入框：@ 提及、实时消息、语音输入、输入工具条、朗读、连续语音对话
// ---- 输入框：自适应高度、添加图片、回到底部 ----
const inputEl = $("#input");
inputEl.addEventListener("input", () => {
  if (currentGroup) setSending();
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
});
$("#attach-btn").onclick = async () => {
  const blocks = await api.files.pick().catch((e) => { alert(errText(e)); return []; });
  blocks.forEach((b) => pendingAtt.push(b));
  renderPending();
};
const msgBox = $("#messages");
msgBox.addEventListener("scroll", () => {
  const away = msgBox.scrollHeight - msgBox.scrollTop - msgBox.clientHeight > 200;
  $("#scroll-down").classList.toggle("hidden", !away);
});
$("#scroll-down").onclick = () => msgBox.scrollTo({ top: msgBox.scrollHeight, behavior: "smooth" });

// ---- 左栏：搜索开关、工具与设置菜单 ----
$("#search-toggle").onclick = () => {
  const box = $("#search-box");
  box.classList.toggle("hidden");
  if (!box.classList.contains("hidden")) $("#search-input").focus();
};
$("#more-btn").onclick = (e) => { e.stopPropagation(); $("#more-menu").classList.toggle("hidden"); };
$("#more-menu").addEventListener("click", () => $("#more-menu").classList.add("hidden"));
document.addEventListener("click", (e) => { if (!e.target.closest(".side-foot")) $("#more-menu").classList.add("hidden"); });
setInterval(() => { if (!document.hidden && !pending.size) refreshBots(); }, 15_000);

// ---- @ 提及：输入 @ 弹出 bot 列表，↑↓ 选择，Enter/Tab 插入 ----
const mentionPop = document.createElement("div");
mentionPop.id = "mention-pop";
mentionPop.className = "hidden";
$("#composer").appendChild(mentionPop);
let mentionItems = [], mentionIdx = 0;

function mentionQuery() {
  const upto = inputEl.value.slice(0, inputEl.selectionStart);
  const m = upto.match(/(?:^|\s)@([^\s@]*)$/);
  return m ? m[1] : null;
}

function updateMention() {
  const q = mentionQuery();
  if (q === null) return mentionPop.classList.add("hidden");
  mentionItems = bots.filter((b) => b.id !== currentBot?.id && b.name.toLowerCase().includes(q.toLowerCase())).slice(0, 8);
  if (!mentionItems.length) return mentionPop.classList.add("hidden");
  mentionIdx = Math.min(mentionIdx, mentionItems.length - 1);
  mentionPop.innerHTML = `<div class="mp-head">让它去找这个 bot 沟通</div>` + mentionItems.map((b, i) => `
    <div class="mp-item ${i === mentionIdx ? "on" : ""}" data-i="${i}">
      <span class="bot-avatar" style="width:24px;height:24px;font-size:13px">${avatarHtml(b)}</span>
      <span class="mp-name">${esc(b.name)}</span><span class="mp-role">${esc(b.role || "")}</span>
    </div>`).join("");
  mentionPop.querySelectorAll(".mp-item").forEach((el) => {
    el.onmousedown = (e) => { e.preventDefault(); pickMention(Number(el.dataset.i)); };
  });
  mentionPop.classList.remove("hidden");
}

function pickMention(i) {
  const b = mentionItems[i];
  if (!b) return;
  const pos = inputEl.selectionStart;
  const upto = inputEl.value.slice(0, pos).replace(/@([^\s@]*)$/, `@${b.name} `);
  inputEl.value = upto + inputEl.value.slice(pos);
  inputEl.selectionStart = inputEl.selectionEnd = upto.length;
  mentionPop.classList.add("hidden");
  inputEl.focus();
}

inputEl.addEventListener("input", () => { mentionIdx = 0; updateMention(); });
inputEl.addEventListener("click", updateMention);
inputEl.addEventListener("blur", () => setTimeout(() => mentionPop.classList.add("hidden"), 120));
inputEl.addEventListener("keydown", (e) => {
  if (mentionPop.classList.contains("hidden")) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    mentionIdx = (mentionIdx + (e.key === "ArrowDown" ? 1 : -1) + mentionItems.length) % mentionItems.length;
    updateMention();
  } else if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault();
    e.stopImmediatePropagation();
    pickMention(mentionIdx);
  } else if (e.key === "Escape") {
    mentionPop.classList.add("hidden");
  }
}, true);

// ---- 后台消息实时上屏（定时任务、bot 间问答、被 @ 回复）；进行中的轮次由 send() 结束时整体刷新 ----
let previewTimer = null;
api.onNewMessage((m) => {
  if (!currentSession && !currentGroup && currentBot && b2bAsker(m.sessionId, currentBot.id)) {
    currentSession = m.sessionId;
    void loadSessionMessages(m.sessionId, true);
    return;
  }
  if (m.sessionId === currentSession && !pending.has(m.sessionId)) {
    const box = $("#messages");
    if (m.id === undefined || !box.querySelector(`[data-id="${m.id}"]`)) appendMsg(m);
  }
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshBots, 400);
});

// ---- 成员状态实时更新（主控分派时能看到谁在忙） ----
api.onStatus((st) => {
  liveStatus[st.botId] = st;
  renderBotList();
  syncBusyAvatars();
});

// ---- 语音输入：录音 → OpenAI 兼容的 /audio/transcriptions → 填进输入框 ----
let recorder = null;
async function voiceConfigFlow() {
  const cur = await api.voice.config();
  const voices = speechSynthesis.getVoices()
    .filter((v) => /^(zh|en)/i.test(v.lang) && !NOVELTY_VOICES.test(v.name))
    .sort((a, b) => Number(/^zh/i.test(b.lang)) - Number(/^zh/i.test(a.lang)));
  const savedVoice = localStorage.getItem("harness.ttsVoice") || "";
  const rate = Number(localStorage.getItem("harness.ttsRate") || 1.05);
  const modal = openModal(`
    <h2>🎙 语音</h2>
    <div class="hint">语音输入要把录音发给任意 OpenAI 兼容的 <code>/audio/transcriptions</code>（Whisper、SenseVoice、各家中转均可）。不想配的话，在输入框按两下 Fn 可用 macOS 听写。</div>
    <div class="kv">
      <label>识别接口</label><input id="v-url" value="${esc(cur?.baseUrl || "")}" placeholder="https://你的中转或官方/v1" />
      <label>识别模型</label><input id="v-model" value="${esc(cur?.model || "")}" placeholder="如 whisper-1 / SenseVoiceSmall" />
      <label>API Key</label><input id="v-key" type="password" placeholder="${cur?.apiKey ? "已保存，留空不修改" : "sk-..."}" />
      <label>朗读声音</label><select id="v-voice"><option value="">自动（按内容选中文 / 英文）</option>${voices.map((v) => `<option value="${esc(v.name)}" ${v.name === savedVoice ? "selected" : ""}>${esc(v.name)} · ${esc(v.lang)}</option>`).join("")}</select>
      <label>朗读语速</label><span class="v-rate"><input id="v-rate" type="range" min="0.7" max="1.8" step="0.05" value="${rate}" /><em>${rate.toFixed(2)}×</em><button class="ghost-btn" id="v-try">试听</button></span>
    </div>
    <div class="actions"><button class="ghost-btn" id="v-cancel">取消</button><button class="primary-btn" id="v-save">保存</button></div>`);
  const $m = (s) => modal.querySelector(s);
  $m("#v-rate").oninput = () => ($m(".v-rate em").textContent = `${Number($m("#v-rate").value).toFixed(2)}×`);
  $m("#v-try").onclick = () => {
    localStorage.setItem("harness.ttsVoice", $m("#v-voice").value);
    localStorage.setItem("harness.ttsRate", $m("#v-rate").value);
    speak("你好，我是你的助手。这是朗读效果试听。");
  };
  return new Promise((resolve) => {
    $m("#v-cancel").onclick = () => { closeModal(); resolve(false); };
    $m("#v-save").onclick = async () => {
      localStorage.setItem("harness.ttsVoice", $m("#v-voice").value);
      localStorage.setItem("harness.ttsRate", $m("#v-rate").value);
      const key = $m("#v-key").value.trim();
      if (key || cur?.apiKey) await api.voice.config({ baseUrl: $m("#v-url").value.trim(), model: $m("#v-model").value.trim(), apiKey: key || "__keep__" });
      closeModal();
      resolve(!!(key || cur?.apiKey));
    };
  });
}
/** 环境配置：bot 记得的普通配置（明文）和加密密钥（只显示名称） */
async function envFlow() {
  const [entries, secretList] = await Promise.all([api.env.list(), api.secrets.list()]);
  const scopeOf = (e) => (e.botId ? `仅 ${e.botName || "已删除的 bot"}` : "所有 bot 共用");
  const modal = openModal(`
    <h2>🧩 环境配置</h2>
    <div class="hint">bot 帮你配置过的东西都存在这里，重启后还在，每次对话 bot 都会看到这份清单，不会重复问你要。普通配置会在 bot 执行命令时作为环境变量注入；密钥加密保存在本机钥匙串，bot 看不到真值。</div>
    <div class="d-sec"><h4>环境变量</h4>
      ${entries.length ? entries.map((e) => `<div class="d-card"><div class="c-main"><div class="c-title">${esc(e.label || e.key)}</div><div class="c-sub">${esc(e.key)}=${esc(e.value)} · ${esc(scopeOf(e))}${e.note ? ` · ${esc(e.note)}` : ""}</div></div><button class="ghost-btn" data-env-del="${esc(e.key)}" data-env-bot="${esc(e.botId || "")}">删除</button></div>`).join("") : `<div class="hint">还没有</div>`}
      <div class="kv">
        <label>变量名</label><input id="env-key" placeholder="如 FEISHU_APP_ID" />
        <label>值</label><input id="env-value" />
        <label>名称</label><input id="env-label" placeholder="可选，如 飞书应用 ID" />
      </div>
      <div class="actions"><button class="primary-btn" id="env-add">添加 / 更新（所有 bot 共用）</button></div>
    </div>
    <div class="d-sec"><h4>密钥</h4>
      ${secretList.length ? secretList.map((x) => {
        const saver = bots.find((b) => b.id === x.savedBy);
        const toggle = x.botId ? `<button class="ghost-btn" data-secret-scope="${esc(x.name)}" data-scope-to="">设为共用</button>`
          : saver ? `<button class="ghost-btn" data-secret-scope="${esc(x.name)}" data-scope-to="${esc(saver.id)}">仅 ${esc(saver.name)} 用</button>` : "";
        return `<div class="d-card"><div class="c-main"><div class="c-title">🔑 ${esc(x.label || x.name)}</div><div class="c-sub">${esc(x.name)} · ${esc(x.botId ? `仅 ${x.botName || "已删除的 bot"}` : "所有 bot 共用")} · ${esc(fmtTime(x.savedAt))}${x.note ? ` · ${esc(x.note)}` : ""}</div></div>${toggle}<button class="ghost-btn" data-secret-del="${esc(x.name)}">删除</button></div>`;
      }).join("") : `<div class="hint">还没有。bot 需要密码 / Token 时会弹出加密输入框让你填写。</div>`}
    </div>
    <div class="actions"><button class="ghost-btn" id="env-close">关闭</button></div>`);
  const $m = (s) => modal.querySelector(s);
  $m("#env-close").onclick = closeModal;
  $m("#env-add").onclick = async () => {
    const key = $m("#env-key").value.trim(), value = $m("#env-value").value.trim();
    if (!key || !value) return;
    try { await api.env.set({ key, value, label: $m("#env-label").value.trim() || undefined }); envFlow(); }
    catch (e) { alert(String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")); }
  };
  modal.querySelectorAll("[data-env-del]").forEach((b) => (b.onclick = async () => { await api.env.remove(b.dataset.envDel, b.dataset.envBot || undefined); envFlow(); }));
  modal.querySelectorAll("[data-secret-del]").forEach((b) => (b.onclick = async () => {
    if (!confirm(`删除密钥 ${b.dataset.secretDel}？用到它的 bot 将无法再使用。`)) return;
    await api.secrets.remove(b.dataset.secretDel); envFlow();
  }));
  modal.querySelectorAll("[data-secret-scope]").forEach((b) => (b.onclick = async () => { await api.secrets.scope(b.dataset.secretScope, b.dataset.scopeTo || null); envFlow(); }));
}
async function toggleVoice() {
  const btn = $("#mic-btn");
  if (recorder) { recorder.stop(); return; }
  if (!(await api.voice.config())) { if (!(await voiceConfigFlow())) return; }
  if (!(await api.voice.micAccess())) return alert("没有麦克风权限：系统设置 → 隐私与安全性 → 麦克风，允许 Electron");
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { return alert(`打不开麦克风：${e.message}`); }
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/mp4";
  const chunks = [];
  recorder = new MediaRecorder(stream, { mimeType: mime });
  const t0 = Date.now();
  const tick = setInterval(() => (btn.dataset.secs = `${Math.floor((Date.now() - t0) / 1000)}s`), 300);
  btn.classList.add("rec");
  btn.title = "点击结束录音";
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = async () => {
    clearInterval(tick);
    stream.getTracks().forEach((t) => t.stop());
    recorder = null;
    btn.classList.remove("rec");
    btn.classList.add("busy");
    btn.title = "识别中…";
    try {
      const buf = await new Blob(chunks, { type: mime }).arrayBuffer();
      const text = (await api.voice.transcribe(buf, mime.split(";")[0])).trim();
      if (text && typeof realmPresence !== "undefined" && realmPresence && typeof realmSend === "function" && !voiceMode) {
        await realmSend(text);
      } else if (text) {
        const el = $("#input");
        const at = el.selectionStart ?? el.value.length;
        el.value = el.value.slice(0, at) + text + el.value.slice(at);
        el.focus();
        el.dispatchEvent(new Event("input"));
      }
    } catch (e) {
      alert(String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    } finally {
      btn.classList.remove("busy");
      btn.title = "语音输入（右键设置）";
      delete btn.dataset.secs;
    }
  };
  recorder.start();
}
$("#mic-btn").onclick = toggleVoice;
$("#mic-btn").oncontextmenu = (e) => { e.preventDefault(); voiceConfigFlow(); };

// bot 用 app.* / skill.* 改了软件数据：刷新侧栏和详情
api.onAppChanged(async () => {
  await refreshBots();
  if (!$("#details").classList.contains("hidden")) {
    if (currentGroup) renderGroupDetails(currentGroup);
    else if (currentBot) { currentBot = botById(currentBot.id) ?? currentBot; renderDetails(currentBot); }
  }
});

/* ======== 输入框工具条：深度思考 / 项目 / 自动朗读 / 语音对话 ======== */
function chatOpts() {
  return { think: thinkMode, projectId: sessionProject };
}

function renderComposerTools() {
  const box = $("#composer-tools");
  if (!box) return;
  const inRealm = typeof realmPresence !== "undefined" && !!realmPresence;
  const single = !!currentBot && !currentGroup && !inRealm;
  if (!single && !currentGroup && !inRealm) { box.innerHTML = ""; return; }
  const proj = projectList.find((p) => p.id === sessionProject);
  box.innerHTML = `
    ${single ? `<button class="ct ${thinkMode ? "on" : ""}" data-ct="think" title="先推理再回答：DeepSeek 等会换用推理模型，思考过程可以展开看">💭 深度思考</button>` : ""}
    ${single ? `<button class="ct ${proj ? "on" : ""}" data-ct="project" title="项目：一组对话共用的指令和资料">📁 ${proj ? esc(proj.name) : "项目"}<span class="ct-caret">▾</span></button>` : ""}
    ${inRealm ? "" : `<button class="ct ${autoSpeak ? "on" : ""}" data-ct="speak" title="回复完自动朗读">🔊 自动朗读</button>`}
    ${single || inRealm ? `<button class="ct ${voiceMode ? "on" : ""}" data-ct="voice" title="${inRealm ? "灵境语音：说完自动发送，用 TA 的音色回复，说完再听" : "连续语音对话：说完自动发送，回复读出来，读完接着听"}">🎧 ${inRealm ? "灵境语音" : "语音对话"}</button>` : ""}`;
  box.querySelectorAll("[data-ct]").forEach((btn) => (btn.onclick = (e) => {
    const k = btn.dataset.ct;
    if (k === "think") { thinkMode = !thinkMode; localStorage.setItem("harness.think", thinkMode ? "1" : "0"); renderComposerTools(); }
    if (k === "speak") { autoSpeak = !autoSpeak; localStorage.setItem("harness.autoSpeak", autoSpeak ? "1" : "0"); if (!autoSpeak) stopSpeak(); renderComposerTools(); }
    if (k === "voice") voiceMode ? stopVoiceMode() : startVoiceMode();
    if (k === "project") projectMenu(btn, e);
  }));
}

/** 浮在按钮上方的小菜单 */
function popMenu(anchor, items) {
  document.querySelector(".pop-float")?.remove();
  const menu = document.createElement("div");
  menu.className = "pop-float";
  menu.innerHTML = items.map((it, i) => it === "-" ? `<div class="pf-sep"></div>` : `<button data-i="${i}" class="${it.on ? "on" : ""}">${it.html}</button>`).join("");
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)}px`;
  const above = r.top - menu.offsetHeight - 6;
  menu.style.top = `${above >= 8 ? above : Math.min(r.bottom + 6, window.innerHeight - menu.offsetHeight - 8)}px`;
  menu.querySelectorAll("button").forEach((b) => (b.onclick = () => { menu.remove(); items[Number(b.dataset.i)].run(); }));
  setTimeout(() => document.addEventListener("click", function off(ev) {
    if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener("click", off); }
  }), 0);
}

async function projectMenu(btn) {
  projectList = await api.projects.list().catch(() => []);
  const pick = async (id) => {
    sessionProject = id;
    if (currentSession && (await api.sessions.get(currentSession).catch(() => null))) await api.projects.setForSession(currentSession, id);
    renderComposerTools();
  };
  popMenu(btn, [
    { html: "不使用项目", on: !sessionProject, run: () => pick(null) },
    ...projectList.map((p) => ({ html: `📁 ${esc(p.name)}<span class="pf-sub">${p.files.length ? `${p.files.length} 份资料` : ""}</span>`, on: p.id === sessionProject, run: () => pick(p.id) })),
    "-",
    { html: "＋ 新建项目…", run: () => projectsFlow({ create: true }) },
    { html: "管理项目与自定义指令…", run: () => projectsFlow() },
  ]);
}
api.projects.list().then((l) => { projectList = l; renderComposerTools(); }).catch(() => {});

/* ======== 朗读：系统语音（不需要任何 Key） ======== */
let speakToken = 0;
let speakingBtn = null;
function speakableText(text) {
  return String(text ?? "")
    .replace(/```[\s\S]*?(```|$)/g, "（代码略）")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\[\d{1,2}\]/g, "")
    .replace(/^[#>\-*\s|]+/gm, "")
    .replace(/[*_~|]+/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
/** macOS 自带的音效类声音，不适合朗读 */
const NOVELTY_VOICES = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox)\b/;

function pickVoice(text) {
  const voices = speechSynthesis.getVoices();
  const saved = localStorage.getItem("harness.ttsVoice");
  const zh = /[\u4e00-\u9fa5]/.test(text);
  const fit = (v) => (zh ? /^zh/i.test(v.lang) : /^en/i.test(v.lang));
  const preferred = ["Tingting", "婷婷", "Samantha", "Meijia", "美佳"];
  return voices.find((v) => v.name === saved && fit(v))
    ?? preferred.map((n) => voices.find((v) => fit(v) && v.name.includes(n))).find(Boolean)
    ?? voices.find((v) => fit(v) && /^zh-CN/i.test(v.lang)) ?? voices.find(fit) ?? null;
}
speechSynthesis.getVoices();
function stopSpeak() {
  speakToken++;
  speechSynthesis.cancel();
  speakingBtn?.classList.remove("on");
  speakingBtn = null;
}
/** 按句切开逐句读（长段落一次读容易被系统截断）；读完或被打断都会回调 onEnd */
function speak(text, { onEnd, btn } = {}) {
  stopSpeak();
  const clean = speakableText(text);
  if (!clean) { onEnd?.(); return; }
  const token = speakToken;
  const parts = clean.match(/[^。！？!?\n.]+[。！？!?\n.]*/g)?.map((x) => x.trim()).filter(Boolean) ?? [clean];
  const voice = pickVoice(clean);
  const rate = Number(localStorage.getItem("harness.ttsRate") || 1.05);
  speakingBtn = btn ?? null;
  btn?.classList.add("on");
  let i = 0;
  const next = () => {
    if (token !== speakToken) return;
    if (i >= parts.length) { btn?.classList.remove("on"); if (speakingBtn === btn) speakingBtn = null; onEnd?.(); return; }
    const u = new SpeechSynthesisUtterance(parts[i++]);
    if (voice) u.voice = voice;
    u.lang = voice?.lang ?? (/[\u4e00-\u9fa5]/.test(clean) ? "zh-CN" : "en-US");
    u.rate = rate;
    u.onend = next;
    u.onerror = next;
    speechSynthesis.speak(u);
  };
  next();
}
function toggleSpeak(text, btn) {
  if (speakingBtn === btn) return stopSpeak();
  speak(text, { btn });
}

/** 一轮回复结束：开了自动朗读或语音对话就读最后一条回复，语音对话读完接着听 */
async function onReplyDone(sid) {
  if (sid !== currentSession || currentGroup || (!autoSpeak && !voiceMode)) return;
  const { msgs } = await api.messages.page(sid, { limit: 6 }).catch(() => ({ msgs: [] }));
  const last = msgs.findLast((m) => m.role === "assistant" && m.kind !== "event");
  const text = last ? msgText(last).replace(/```tool[\s\S]*?```/g, "") : "";
  if (voiceMode) {
    setVoiceBar("speaking");
    speak(text, { onEnd: () => voiceMode && listenTurn() });
  } else speak(text);
}

/* ======== 连续语音对话：听 → 自动断句 → 识别 → 发送 → 朗读 → 再听 ======== */
const vc = { stream: null, rec: null, ctx: null, forceStop: false };
function setVoiceBar(state, extra = "") {
  const bar = $("#voice-bar");
  if (!voiceMode) { bar.classList.add("hidden"); bar.innerHTML = ""; return; }
  const inRealm = typeof realmPresence !== "undefined" && !!realmPresence;
  const label = {
    listening: inRealm ? `在听 ${realmPresence.name}… 说完停一下会发送` : "在听，说完停一下会自动发送",
    transcribing: "识别中…",
    thinking: inRealm ? `${realmPresence.name} 正在回应…` : "等待回复…",
    speaking: inRealm ? `正在用 ${realmPresence.name} 的声音说` : "正在朗读",
  }[state] ?? state;
  bar.className = `vb-${state}`;
  bar.innerHTML = `<span class="vb-orb"><i></i></span><span class="vb-label">${esc(label)}</span>${extra}<span class="vb-level"><i></i></span>
    ${state === "listening" ? `<button class="ghost-btn" data-vb="done">说完了</button>` : ""}
    ${state === "speaking" ? `<button class="ghost-btn" data-vb="interrupt">打断</button>` : ""}
    <button class="ghost-btn" data-vb="exit">退出语音</button>`;
  bar.querySelectorAll("[data-vb]").forEach((b) => (b.onclick = () => {
    if (b.dataset.vb === "exit") stopVoiceMode();
    if (b.dataset.vb === "done" && vc.rec?.state === "recording") { vc.forceStop = true; vc.rec.stop(); }
    if (b.dataset.vb === "interrupt") {
      stopSpeak();
      if (typeof stopRealmAudio === "function") stopRealmAudio();
      listenTurn();
    }
  }));
}

async function startVoiceMode() {
  const inRealm = typeof realmPresence !== "undefined" && !!realmPresence;
  if ((!currentBot || currentGroup) && !inRealm) return;
  if (inRealm && realmPresence.voice?.status !== "ready") {
    if (confirm("尚未绑定音色。确定：去绑定；取消：继续（回复只有文字）")) {
      return typeof realmVoiceBindFlow === "function" && realmVoiceBindFlow(realmPresence);
    }
  }
  if (!(await api.voice.config())) { if (!(await voiceConfigFlow())) return; }
  if (!(await api.voice.micAccess())) return alert("没有麦克风权限：系统设置 → 隐私与安全性 → 麦克风，允许 Electron");
  try { vc.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); } catch (e) { return alert(`打不开麦克风：${e.message}`); }
  voiceMode = true;
  renderComposerTools();
  if (typeof realmPresence !== "undefined" && realmPresence && typeof renderRealmHeader === "function") renderRealmHeader();
  listenTurn();
}

function stopVoiceMode() {
  voiceMode = false;
  stopSpeak();
  if (typeof stopRealmAudio === "function") stopRealmAudio();
  if (vc.rec?.state === "recording") vc.rec.stop();
  vc.ctx?.close().catch(() => {});
  vc.stream?.getTracks().forEach((t) => t.stop());
  Object.assign(vc, { stream: null, rec: null, ctx: null });
  setVoiceBar("");
  renderComposerTools();
  if (typeof realmPresence !== "undefined" && realmPresence && typeof renderRealmHeader === "function") renderRealmHeader();
}

function listenTurn() {
  if (!voiceMode || !vc.stream) return;
  if (vc.rec?.state === "recording") return;
  setVoiceBar("listening");
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/mp4";
  const chunks = [];
  const rec = new MediaRecorder(vc.stream, { mimeType: mime });
  vc.rec = rec;
  vc.forceStop = false;
  vc.ctx?.close().catch(() => {});
  vc.ctx = new AudioContext();
  const analyser = vc.ctx.createAnalyser();
  analyser.fftSize = 1024;
  vc.ctx.createMediaStreamSource(vc.stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const t0 = Date.now();
  let floor = 0, samples = 0, spoke = false, lastVoice = 0;
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const tick = () => {
    if (rec.state !== "recording") return;
    analyser.getFloatTimeDomainData(buf);
    const rms = Math.sqrt(buf.reduce((n, x) => n + x * x, 0) / buf.length);
    const now = Date.now();
    if (now - t0 < 400) { floor = (floor * samples + rms) / ++samples; return setTimeout(tick, 40); }
    const th = Math.max(0.012, floor * 3);
    if (rms > th) { spoke = true; lastVoice = now; }
    const lvl = $("#voice-bar .vb-level i");
    if (lvl) lvl.style.width = `${Math.min(100, (rms / (th * 3)) * 100)}%`;
    if ((spoke && now - lastVoice > 1300) || now - t0 > 60_000 || (!spoke && now - t0 > 15_000)) return rec.stop();
    setTimeout(tick, 40);
  };
  rec.onstop = async () => {
    if (!voiceMode) return;
    if (!spoke && !vc.forceStop) return listenTurn();
    setVoiceBar("transcribing");
    try {
      const audio = await new Blob(chunks, { type: mime }).arrayBuffer();
      const text = (await api.voice.transcribe(audio, mime.split(";")[0])).trim();
      if (!voiceMode) return;
      if (!text) return listenTurn();
      setVoiceBar("thinking", `<span class="vb-said">“${esc(text.slice(0, 40))}${text.length > 40 ? "…" : ""}”</span>`);
      if (typeof realmPresence !== "undefined" && realmPresence && typeof realmSend === "function") {
        const r = await realmSend(text, { autoPlay: false, quiet: true });
        if (!voiceMode) return;
        if (r?.audioPath && typeof playRealmAudio === "function") {
          setVoiceBar("speaking");
          await playRealmAudio(r.audioPath);
        } else if (r?.text) {
          setVoiceBar("speaking");
          await new Promise((res) => speak(r.text, { onEnd: res }));
        }
        if (voiceMode) listenTurn();
        return;
      }
      $("#input").value = text;
      send();
    } catch (e) {
      // 断线 / 转写失败：同一会话自动重连听一轮，而不是退出连续语音
      setVoiceBar("listening", `<span class="vb-said">转写失败，重连中… ${esc(String(errText(e)).slice(0, 40))}</span>`);
      if (!voiceMode) return;
      setTimeout(() => { if (voiceMode) listenTurn(); }, 800);
    }
  };
  rec.start(250);
  tick();
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && voiceMode && !document.querySelector(".modal, .lightbox")) stopVoiceMode(); });
