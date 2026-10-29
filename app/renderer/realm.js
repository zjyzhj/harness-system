/** 灵境：独立于 bot 的 Presence（文本 + 音色还原；视频延后） */
let realmPresence = null;
let realmSessionId = null;
let realmBusy = false;
/** 克隆音色播放器（语音对话可打断） */
let realmAudioEl = null;
let realmAudioToken = 0;

function stopRealmAudio() {
  realmAudioToken++;
  if (realmAudioEl) {
    try { realmAudioEl.pause(); realmAudioEl.src = ""; } catch { /* */ }
    realmAudioEl = null;
  }
}

/** 播放合成音；返回 Promise，播完或被打断都 resolve */
function playRealmAudio(path) {
  stopRealmAudio();
  const token = realmAudioToken;
  return new Promise((resolve) => {
    const a = new Audio(fileUrl(path));
    realmAudioEl = a;
    const done = () => {
      if (token !== realmAudioToken) return resolve();
      if (realmAudioEl === a) realmAudioEl = null;
      resolve();
    };
    a.onended = done;
    a.onerror = done;
    a.play().catch(done);
  });
}

const TTS_PRESETS = {
  custom: { name: "自定义", baseUrl: "", model: "", cloneMode: "inline", uploadPath: "", defaultVoice: "" },
  openai: { name: "OpenAI TTS", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-tts", cloneMode: "none", uploadPath: "", defaultVoice: "coral" },
  sf_cosy: { name: "SiliconFlow CosyVoice", baseUrl: "https://api.siliconflow.cn/v1", model: "FunAudioLLM/CosyVoice2-0.5B", cloneMode: "upload", uploadPath: "/uploads/audio/voice", defaultVoice: "" },
  sf_inline: { name: "CosyVoice 随请求克隆", baseUrl: "https://api.siliconflow.cn/v1", model: "FunAudioLLM/CosyVoice2-0.5B", cloneMode: "inline", uploadPath: "", defaultVoice: "" },
};

async function realmTtsFlow() {
  const cur = await api.realm.ttsConfig();
  const modal = openModal(`
    <h2>灵境 · 音色合成</h2>
    <div class="hint">不限供应商：任意兼容 OpenAI <code>/audio/speech</code> 的服务均可。克隆方式按供应商能力选择；预设只是快捷填表。</div>
    <div class="mx-seg" id="t-presets">${Object.entries(TTS_PRESETS).map(([k, v]) => `<button data-tp="${k}">${v.name}</button>`).join("")}</div>
    <div class="kv">
      <label>Base URL</label><input id="t-url" value="${esc(cur?.baseUrl || "")}" placeholder="https://你的中转或官方/v1" />
      <label>模型</label><input id="t-model" value="${esc(cur?.model || "")}" placeholder="供应商模型 id" />
      <label>API Key</label><input id="t-key" type="password" placeholder="${cur?.apiKey ? "已保存，留空不修改" : "sk-..."}" />
      <label>克隆方式</label><select id="t-mode">
        <option value="inline" ${(cur?.cloneMode || "inline") === "inline" ? "selected" : ""}>inline · 每次附带参考音</option>
        <option value="upload" ${cur?.cloneMode === "upload" ? "selected" : ""}>upload · 先上传注册音色</option>
        <option value="none" ${cur?.cloneMode === "none" ? "selected" : ""}>none · 只用预设 voice 名</option>
      </select>
      <label>上传路径</label><input id="t-up" value="${esc(cur?.uploadPath || "")}" placeholder="upload 模式用，如 /uploads/audio/voice" />
      <label>默认 voice</label><input id="t-dv" value="${esc(cur?.defaultVoice || "")}" placeholder="none 模式，如 alloy / coral" />
    </div>
    <div class="actions"><button class="ghost-btn" id="t-cancel">取消</button><button class="primary-btn" id="t-save">保存</button></div>`);
  modal.querySelectorAll("[data-tp]").forEach((btn) => (btn.onclick = () => {
    const p = TTS_PRESETS[btn.dataset.tp];
    if (p.baseUrl) modal.querySelector("#t-url").value = p.baseUrl;
    if (p.model) modal.querySelector("#t-model").value = p.model;
    modal.querySelector("#t-mode").value = p.cloneMode;
    modal.querySelector("#t-up").value = p.uploadPath || "";
    modal.querySelector("#t-dv").value = p.defaultVoice || "";
    modal.querySelectorAll("[data-tp]").forEach((x) => x.classList.toggle("on", x === btn));
  }));
  return new Promise((resolve) => {
    modal.querySelector("#t-cancel").onclick = () => { closeModal(); resolve(false); };
    modal.querySelector("#t-save").onclick = async () => {
      const key = modal.querySelector("#t-key").value.trim();
      const baseUrl = modal.querySelector("#t-url").value.trim();
      const model = modal.querySelector("#t-model").value.trim();
      if (!baseUrl || !model) return alert("请填写 Base URL 和模型");
      if (!key && !cur?.apiKey) return alert("请填写 API Key");
      try {
        await api.realm.ttsConfig({
          baseUrl,
          model,
          apiKey: key || "__keep__",
          cloneMode: modal.querySelector("#t-mode").value,
          uploadPath: modal.querySelector("#t-up").value.trim() || undefined,
          defaultVoice: modal.querySelector("#t-dv").value.trim() || undefined,
        });
        closeModal();
        resolve(true);
      } catch (e) { alert(errText(e)); }
    };
  });
}

async function realmCreateFlow() {
  const consent = await api.realm.consentText();
  const plist = await api.providers.list();
  const def = plist.find((p) => p.isDefault) || plist[0];
  if (!def) return alert("请先在设置里配置一个对话模型");
  const modal = openModal(`
    <h2>新建灵境 Presence</h2>
    <div class="hint">灵境用来留住想见的人——文本对话 + 真人音色。不是助手 bot，不会进 bot 列表。视频数字人以后再加。</div>
    <div class="kv">
      <label>称呼</label><input id="r-name" placeholder="怎么称呼 TA" />
      <label>关系</label><input id="r-rel" placeholder="如：外婆 / 挚友" />
      <label>模型</label><select id="r-prov">${plist.map((p) => `<option value="${esc(p.id)}" ${p.id === def.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
      <label>其人痕迹</label><textarea id="r-bio" rows="3" placeholder="性格、相处方式、你记得的事…"></textarea>
      <label>说话方式</label><textarea id="r-style" rows="2" placeholder="口头禅、语气、称呼你的方式…"></textarea>
      <label>语料摘录</label><textarea id="r-corpus" rows="4" placeholder="聊天记录、信件片段（可选，用来锚定口吻）"></textarea>
      <label>授权身份</label><select id="r-role">
        <option value="self">本人（为自己做）</option>
        <option value="with-consent">已获本人明确同意</option>
        <option value="kin">近亲属（逝者情形）</option>
      </select>
    </div>
    <label class="check"><input type="checkbox" id="r-ok" /><span>${esc(consent)}</span></label>
    <div class="actions"><button class="ghost-btn" id="r-cancel">取消</button><button class="primary-btn" id="r-go">创建</button></div>`);
  modal.querySelector("#r-cancel").onclick = () => closeModal();
  modal.querySelector("#r-go").onclick = async () => {
    if (!modal.querySelector("#r-ok").checked) return alert("须勾选授权声明");
    const name = modal.querySelector("#r-name").value.trim();
    if (!name) return alert("请填写称呼");
    try {
      const p = await api.realm.create({
        name,
        relation: modal.querySelector("#r-rel").value.trim() || undefined,
        bio: modal.querySelector("#r-bio").value.trim() || undefined,
        styleNotes: modal.querySelector("#r-style").value.trim() || undefined,
        corpus: modal.querySelector("#r-corpus").value.trim() || undefined,
        providerId: modal.querySelector("#r-prov").value,
        consentRole: modal.querySelector("#r-role").value,
        consentAffirmed: true,
      });
      closeModal();
      await openRealm(p.id);
    } catch (e) {
      alert(errText(e));
    }
  };
}

async function realmVoiceBindFlow(p) {
  let cfg = await api.realm.ttsConfig();
  if (!cfg) {
    if (!(await realmTtsFlow())) return;
    cfg = await api.realm.ttsConfig();
  }
  const mode = cfg?.cloneMode || (/cosyvoice|fish/i.test(cfg?.model || "") ? "inline" : "inline");
  if (mode === "none") {
    const modal = openModal(`
      <h2>绑定 ${esc(p.name)} 的预设音色</h2>
      <div class="hint">当前为 none 模式（无克隆）：填写供应商提供的 voice 名，如 OpenAI 的 coral / alloy。</div>
      <div class="kv"><label>voice 名</label><input id="rv-voice" value="${esc(cfg?.defaultVoice || "")}" placeholder="coral" /></div>
      <div class="actions"><button class="ghost-btn" id="rv-cancel">取消</button><button class="primary-btn" id="rv-go">保存</button></div>`);
    modal.querySelector("#rv-cancel").onclick = () => closeModal();
    modal.querySelector("#rv-go").onclick = async () => {
      const name = modal.querySelector("#rv-voice").value.trim();
      if (!name) return alert("请填写 voice 名");
      try {
        realmPresence = await api.realm.setPresetVoice(p.id, name);
        closeModal();
        renderRealmHeader();
        toast("音色已绑定");
      } catch (e) { alert(errText(e)); }
    };
    return;
  }
  const modal = openModal(`
    <h2>绑定 ${esc(p.name)} 的音色</h2>
    <div class="hint">上传一段 TA 的清晰人声（约 8–10 秒）。务必填写参考音里说的原话。当前克隆方式：<b>${esc(mode)}</b>（可在音色设置里改）。</div>
    <div class="kv">
      <label>参考原文</label><textarea id="rv-text" rows="3" placeholder="录音里说的话，逐字填写"></textarea>
    </div>
    <div class="actions">
      <button class="ghost-btn" id="rv-cancel">取消</button>
      <button class="ghost-btn" id="rv-rec">录一段</button>
      <button class="primary-btn" id="rv-file">选文件上传</button>
    </div>`);
  modal.querySelector("#rv-cancel").onclick = () => closeModal();
  modal.querySelector("#rv-file").onclick = async () => {
    const refText = modal.querySelector("#rv-text").value.trim();
    if (!refText) return alert("请先填写参考原文");
    try {
      const next = await api.realm.cloneVoice(p.id, refText);
      if (!next) return;
      closeModal();
      realmPresence = next;
      renderRealmHeader();
      toast("音色已绑定");
    } catch (e) { alert(errText(e)); }
  };
  modal.querySelector("#rv-rec").onclick = async () => {
    const refText = modal.querySelector("#rv-text").value.trim();
    if (!refText) return alert("请先填写参考原文（录音时说这几句）");
    if (!(await api.voice.micAccess())) return alert("没有麦克风权限");
    closeModal();
    await recordRealmRef(p.id, refText);
  };
}

async function recordRealmRef(presenceId, refText) {
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { return alert(`打不开麦克风：${e.message}`); }
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/mp4";
  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType: mime });
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const bar = $("#voice-bar");
  bar.classList.remove("hidden");
  bar.innerHTML = `<span>正在录制参考音… 说完参考原文后点停止</span><button class="primary-btn" id="rv-stop">停止并克隆</button><button class="ghost-btn" id="rv-abort">取消</button>`;
  rec.start();
  const stopTracks = () => stream.getTracks().forEach((t) => t.stop());
  $("#rv-abort").onclick = () => { rec.stop(); stopTracks(); bar.classList.add("hidden"); bar.innerHTML = ""; };
  $("#rv-stop").onclick = () => { rec.stop(); };
  rec.onstop = async () => {
    stopTracks();
    bar.innerHTML = `<span>正在上传并克隆音色…</span>`;
    try {
      const buf = await new Blob(chunks, { type: mime }).arrayBuffer();
      const next = await api.realm.cloneVoiceBuf(presenceId, buf, mime.split(";")[0], refText);
      realmPresence = next;
      renderRealmHeader();
      toast("音色已绑定");
    } catch (e) {
      alert(errText(e));
    } finally {
      bar.classList.add("hidden");
      bar.innerHTML = "";
    }
  };
}

function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

async function openRealm(id) {
  if (typeof voiceMode !== "undefined" && voiceMode && typeof stopVoiceMode === "function") stopVoiceMode();
  const p = await api.realm.get(id);
  if (!p) return alert("找不到该 Presence");
  realmPresence = p;
  currentBot = null;
  currentGroup = null;
  realmSessionId = (await api.realm.sessions(id))[0]?.id || null;
  $("#empty-state")?.classList.add("hidden");
  $("#chat-bar")?.classList.remove("hidden");
  renderRealmHeader();
  renderBotList();
  if (typeof renderComposerTools === "function") renderComposerTools();
  await loadRealmMessages();
  $("#input").placeholder = `对 ${p.name} 说…（灵境 · AI 再现）· 🎙 可语音`;
  $("#input").focus();
}

function renderRealmHeader() {
  const p = realmPresence;
  if (!p) return;
  const voice = p.voice?.status === "ready" ? "音色已就绪" : p.voice?.status === "error" ? `音色失败` : "尚未绑定音色";
  const title = $("#chat-title");
  title.classList.add("realm-mode");
  title.innerHTML = `
    <div class="realm-title"><span class="realm-badge">灵境</span><b>${esc(p.name)}</b><span class="hint">${esc(p.relation || "私密 Presence")} · ${esc(voice)}</span></div>
    <div class="realm-sub">AI 再现 · 非真人在场 · 仅供私密联结</div>`;
  const actions = $("#chat-actions");
  let ops = actions.querySelector(".realm-ops");
  if (!ops) {
    ops = document.createElement("div");
    ops.className = "realm-ops";
    actions.prepend(ops);
  }
  ops.innerHTML = `
    <button class="ghost-btn" id="realm-voice-btn" type="button" title="绑定音色">音色</button>
    <button class="ghost-btn" id="realm-preview-btn" type="button" title="试听" ${p.voice?.status === "ready" ? "" : "disabled"}>试听</button>
    <button class="ghost-btn ${typeof voiceMode !== "undefined" && voiceMode ? "on" : ""}" id="realm-talk-btn" type="button" title="连续语音对话">语音</button>
    <button class="ghost-btn" id="realm-edit-btn" type="button">痕迹</button>
    <button class="ghost-btn" id="realm-leave-btn" type="button">退出</button>`;
  $("#realm-voice-btn").onclick = () => realmVoiceBindFlow(p);
  $("#realm-preview-btn").onclick = async () => {
    try {
      const path = await api.realm.previewVoice(p.id);
      await playRealmAudio(path);
    } catch (e) { alert(errText(e)); }
  };
  $("#realm-talk-btn").onclick = () => {
    if (typeof voiceMode !== "undefined" && voiceMode) stopVoiceMode();
    else startVoiceMode();
    renderRealmHeader();
  };
  $("#realm-edit-btn").onclick = () => realmEditFlow(p);
  $("#realm-leave-btn").onclick = () => leaveRealm();
}

async function realmEditFlow(p) {
  const modal = openModal(`
    <h2>编辑痕迹 — ${esc(p.name)}</h2>
    <div class="kv">
      <label>称呼</label><input id="re-name" value="${esc(p.name)}" />
      <label>关系</label><input id="re-rel" value="${esc(p.relation || "")}" />
      <label>其人痕迹</label><textarea id="re-bio" rows="3">${esc(p.bio || "")}</textarea>
      <label>说话方式</label><textarea id="re-style" rows="2">${esc(p.styleNotes || "")}</textarea>
      <label>语料摘录</label><textarea id="re-corpus" rows="4">${esc(p.corpus || "")}</textarea>
    </div>
    <div class="actions">
      <button class="ghost-btn danger" id="re-del">删除</button>
      <button class="ghost-btn" id="re-arch">封存</button>
      <button class="ghost-btn" id="re-cancel">取消</button>
      <button class="primary-btn" id="re-save">保存</button>
    </div>`);
  modal.querySelector("#re-cancel").onclick = () => closeModal();
  modal.querySelector("#re-save").onclick = async () => {
    realmPresence = await api.realm.update(p.id, {
      name: modal.querySelector("#re-name").value.trim(),
      relation: modal.querySelector("#re-rel").value.trim() || undefined,
      bio: modal.querySelector("#re-bio").value.trim() || undefined,
      styleNotes: modal.querySelector("#re-style").value.trim() || undefined,
      corpus: modal.querySelector("#re-corpus").value.trim() || undefined,
    });
    closeModal();
    renderRealmHeader();
    renderBotList();
  };
  modal.querySelector("#re-arch").onclick = async () => {
    if (!confirm(`封存「${p.name}」？可之后在列表里不再显示。`)) return;
    await api.realm.archive(p.id);
    closeModal();
    leaveRealm();
  };
  modal.querySelector("#re-del").onclick = async () => {
    if (!confirm(`永久删除「${p.name}」及本地音色素材？不可恢复。`)) return;
    await api.realm.remove(p.id);
    closeModal();
    leaveRealm();
  };
}

function leaveRealm(opts) {
  const was = !!realmPresence;
  if (typeof voiceMode !== "undefined" && voiceMode && typeof stopVoiceMode === "function") stopVoiceMode();
  stopRealmAudio();
  realmPresence = null;
  realmSessionId = null;
  document.querySelector(".realm-ops")?.remove();
  $("#chat-title")?.classList.remove("realm-mode");
  if (!opts?.silent && was) {
    $("#chat-title").innerHTML = "";
    $("#chat-bar")?.classList.add("hidden");
    $("#messages").innerHTML = "";
    $("#empty-state")?.classList.remove("hidden");
    $("#input").placeholder = "给 bot 发消息，@bot名 可让 bot 互相通信…";
  } else {
    $("#input").placeholder = "给 bot 发消息，@bot名 可让 bot 互相通信…";
  }
  renderBotList();
  if (typeof renderComposerTools === "function") renderComposerTools();
}

async function loadRealmMessages() {
  const box = $("#messages");
  box.innerHTML = "";
  if (!realmSessionId) return;
  const msgs = await api.realm.messages(realmSessionId);
  for (const m of msgs) box.appendChild(renderMessage(m));
  box.scrollTop = box.scrollHeight;
}

/**
 * @param {string} text
 * @param {{ autoPlay?: boolean, quiet?: boolean }} [opts]
 *   autoPlay 默认 true（文字发送后播音色）；语音对话循环里传 false，由外层控播
 */
async function realmSend(text, opts = {}) {
  if (!realmPresence || realmBusy) return null;
  const t = text.trim();
  if (!t) return null;
  const autoPlay = opts.autoPlay !== false;
  const quiet = !!opts.quiet;
  realmBusy = true;
  $("#send-btn").disabled = true;
  try {
    const r = await api.realm.chat(realmPresence.id, t, realmSessionId || undefined);
    realmSessionId = r.sessionId;
    $("#messages").appendChild(renderMessage(r.userMsg));
    $("#messages").appendChild(renderMessage(r.replyMsg));
    $("#messages").scrollTop = $("#messages").scrollHeight;
    if (autoPlay && r.audioPath) {
      await playRealmAudio(r.audioPath);
    } else if (!quiet) {
      if (r.audioError) toast(`文字已回复，音色合成失败：${r.audioError}`);
      else if (realmPresence.voice?.status !== "ready") toast("已回复（尚未绑定音色，仅文字）");
    }
    return r;
  } catch (e) {
    if (!quiet) alert(errText(e));
    else throw e;
    return null;
  } finally {
    realmBusy = false;
    $("#send-btn").disabled = false;
  }
}

async function realmListFlow() {
  const list = await api.realm.list();
  const modal = openModal(`
    <h2>灵境</h2>
    <div class="hint">把想见的人留在私密空间：文本对话 + 真人音色还原。与助手 bot 完全独立。</div>
    <div class="actions" style="margin-bottom:12px">
      <button class="primary-btn" id="rl-new">＋ 新建 Presence</button>
      <button class="ghost-btn" id="rl-tts">音色接口</button>
    </div>
    <div class="realm-list">${list.length ? list.map((p) => `
      <button class="realm-item" data-id="${esc(p.id)}">
        <b>${esc(p.name)}</b>
        <span class="hint">${esc(p.relation || "")} · ${p.voice?.status === "ready" ? "音色就绪" : "未绑音色"}</span>
      </button>`).join("") : `<p class="hint">还没有 Presence。点上方新建。</p>`}</div>
    <div class="actions"><button class="ghost-btn" id="rl-close">关闭</button></div>`);
  modal.querySelector("#rl-close").onclick = () => closeModal();
  modal.querySelector("#rl-new").onclick = () => { closeModal(); realmCreateFlow(); };
  modal.querySelector("#rl-tts").onclick = () => { closeModal(); realmTtsFlow(); };
  modal.querySelectorAll(".realm-item").forEach((btn) => {
    btn.onclick = () => { closeModal(); openRealm(btn.dataset.id); };
  });
}

/** 侧栏追加灵境入口（与 bot 列表分隔） */
async function renderRealmSide() {
  let box = $("#realm-side");
  if (!box) {
    box = document.createElement("div");
    box.id = "realm-side";
    const list = $("#bot-list");
    list?.parentElement?.insertBefore(box, list.nextSibling);
  }
  const items = await api.realm.list().catch(() => []);
  box.innerHTML = `
    <div class="realm-side-h">
      <span>灵境</span>
      <button class="icon-btn" id="realm-side-add" title="新建">＋</button>
      <button class="icon-btn" id="realm-side-all" title="全部">···</button>
    </div>
    <div class="realm-side-list">${items.slice(0, 8).map((p) => `
      <button class="realm-side-item${realmPresence?.id === p.id ? " on" : ""}" data-id="${esc(p.id)}">
        <span class="realm-dot"></span>${esc(p.name)}
      </button>`).join("") || `<div class="hint pad">留住想见的人</div>`}</div>`;
  $("#realm-side-add").onclick = () => realmCreateFlow();
  $("#realm-side-all").onclick = () => realmListFlow();
  box.querySelectorAll(".realm-side-item").forEach((btn) => {
    btn.onclick = () => openRealm(btn.dataset.id);
  });
}

// 劫持发送：灵境模式下走 realmSend
const _realmOrigSelectBot = typeof selectBot === "function" ? selectBot : null;
document.addEventListener("DOMContentLoaded", () => {
  renderRealmSide();
  const sendBtn = $("#send-btn");
  const input = $("#input");
  if (sendBtn) {
    sendBtn.addEventListener("click", (e) => {
      if (!realmPresence) return;
      e.stopImmediatePropagation();
      const t = input.value;
      input.value = "";
      input.style.height = "";
      realmSend(t);
    }, true);
  }
  if (input) {
    input.addEventListener("keydown", (e) => {
      if (!realmPresence) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const t = input.value;
        input.value = "";
        input.style.height = "";
        realmSend(t);
      }
    }, true);
  }
});

api.onAppChanged?.((what) => {
  if (what === "realm") renderRealmSide();
});
