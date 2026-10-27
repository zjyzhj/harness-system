// 主控面板逻辑 — 通过 preload 暴露的 window.harness 调用 core
const api = window.harness;
const $ = (s) => document.querySelector(s);

let bots = [];
let currentBot = null;
let currentSession = null;

async function refreshBots() {
  bots = await api.bots.list();
  renderBotList();
}

function renderBotList() {
  const list = $("#bot-list");
  list.innerHTML = "";
  if (bots.length === 0) {
    list.innerHTML = `<div class="hint" style="color:var(--dim);padding:8px;">还没有 bot，点上面创建第一个 👆</div>`;
    return;
  }
  for (const b of bots) {
    const el = document.createElement("div");
    el.className = "bot-item" + (currentBot?.id === b.id ? " active" : "");
    el.innerHTML = `
      <div class="bot-avatar">${b.avatarPath ? `<img src="file://${b.avatarPath}" />` : "🤖"}</div>
      <div class="bot-meta">
        <div class="bot-name">${esc(b.name)} ${b.petEnabled ? '<span class="bot-pet-badge">🐾</span>' : ""}</div>
        <div class="bot-role">${esc(b.role || "通用助手")}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:2px">
        <button class="ghost-btn pet-toggle" title="桌面宠物" style="padding:2px 6px;font-size:11px">${b.petEnabled ? "🐾开" : "🐾关"}</button>
        <button class="ghost-btn detail-btn" title="详情" style="padding:2px 6px;font-size:11px">⋯</button>
      </div>`;
    el.querySelector(".pet-toggle").onclick = async (e) => {
      e.stopPropagation();
      await api.bots.setPet(b.id, !b.petEnabled);
      await refreshBots();

// G3：宠物「打开完整会话」→ 主面板聚焦并跳转
api.onOpenSession(async (sid) => {
  if (!sid) { alert("没有可打开的会话，先和宠物聊一句吧"); return; }
  await openSessionById(sid);
});
    };
    el.querySelector(".detail-btn").onclick = (e) => {
      e.stopPropagation();
      botDetailFlow(b);
    };
    el.onclick = () => selectBot(b);
    list.appendChild(el);
  }
}

async function selectBot(b) {
  currentBot = b;
  currentSession = null;
  document.querySelectorAll(".bot-item").forEach((el) => el.classList.remove("active"));
  const item = [...document.querySelectorAll(".bot-item")].find((el) => el.textContent.includes(b.name));
  if (item) item.classList.add("active");
  $("#empty-state").style.display = "none";
  $("#messages").innerHTML = "";
  $("#input").placeholder = `给 ${b.name} 发消息，@bot名 可让 bot 互相通信…`;
  // G1：会话分页（每 bot 最新 30 个）
  const { sessions } = await api.sessions.page({ botId: b.id, limit: 30 });
  if (sessions.length) {
    currentSession = sessions[0].id;
    await loadSessionMessages(sessions[0].id, true);
  }
}

/** G1：加载会话消息（分页窗口，tail=最新 N 条；加载更早时 prepend） */
async function loadSessionMessages(sid, initial = false) {
  const r = await api.messages.page(sid, { limit: initial ? 40 : 40 });
  const box = $("#messages");
  if (initial) box.innerHTML = "";
  // 若还有更早消息，顶部插「加载更早」
  const exists = box.querySelector(`[data-loadmore="${sid}"]`);
  if (exists) exists.remove();
  if (r.hasMore) {
    const btn = document.createElement("button");
    btn.className = "load-more-btn";
    btn.dataset.loadmore = sid;
    btn.textContent = "↑ 加载更早消息";
    btn.onclick = async () => {
      const older = await api.messages.page(sid, { limit: 40, beforeId: r.msgs[0]?.id });
      btn.remove();
      const frag = document.createDocumentFragment();
      older.msgs.forEach((m) => frag.appendChild(makeMsgEl(m)));
      box.prepend(frag);
      if (older.hasMore) {
        const btn2 = document.createElement("button");
        btn2.className = "load-more-btn";
        btn2.dataset.loadmore = sid;
        btn2.textContent = "↑ 加载更早消息";
        btn2.onclick = btn.onclick;
        btn2.dataset.before = older.msgs[0]?.id;
        box.prepend(btn2);
        btn2.onclick = (ev) => loadOlder(ev, sid);
      }
    };
    btn.onclick = btn.onclick;
    box.prepend(btn);
  }
  r.msgs.forEach((m) => appendMsg(m));
  if (initial) box.scrollTop = box.scrollHeight;
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

function makeMsgEl(m) {
  const wrapper = document.createElement("div");
  wrapper.dataset.id = m.id ?? "";
  const fromName = m.from === "user" ? "我" : (bots.find((b) => b.id === m.from)?.name || m.from);
  if (m.kind === "event") {
    wrapper.className = "msg sys";
    wrapper.innerHTML = `<div class="bubble">${esc(m.content)}</div>`;
    return wrapper;
  }
  wrapper.className = "msg " + (m.from === "user" ? "user" : "bot");
  const av = m.from === "user" ? `<div class="avatar">🧑</div>` : (() => { const b = bots.find((x) => x.id === m.from); return `<div class="avatar">${b?.avatarPath ? `<img src="file://${b.avatarPath}"/>` : "🤖"}</div>`; })();
  const inner = typeof m.content === "string" ? renderMarkdown(esc(m.content)) : renderBlocks(m.content);
  wrapper.innerHTML = `${m.from !== "user" ? `<div class="who">${esc(fromName)}</div>` : ""}${av}<div class="bubble">${inner}</div>${m.meta ? `<div class="msg-meta">${esc([m.meta.model, m.meta.latencyMs ? m.meta.latencyMs + "ms" : "", m.meta.tokensUsed ? m.meta.tokensUsed + " tok" : ""].filter(Boolean).join(" · "))}</div>` : ""}`;
  return wrapper;
}

function appendMsg(m) {
  const box = $("#messages");
  const el = makeMsgEl(m);
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

async function send() {
  const text = $("#input").value.trim();
  if (!text || !currentBot) return;
  $("#input").value = "";
  // @bot名 → bot 间通信（保持非流式，走 bus）
  const atMatch = text.match(/^@(\S+)\s+([\s\S]+)/);
  if (atMatch) {
    const target = bots.find((b) => b.name === atMatch[1] || b.name.includes(atMatch[1]));
    if (target) {
      const msgs = await api.bus.send(currentBot.id, target.id, atMatch[2]);
      msgs.forEach((m) => appendMsg(m));
      return;
    }
  }
  // 用户消息立即上屏（含当前会话 id 记录；有图片时以富块显示）
  const rich = pendingImages.length ? [{ type: "text", text }, ...pendingImages] : text;
  const userMsg = { sessionId: currentSession || null, from: "user", to: currentBot.id, role: "user", content: rich, kind: "chat", createdAt: Date.now() };
  appendMsg(userMsg);
  clearImgHint();
  if (currentSession === null) currentSession = userMsg.sessionId = `s-${Date.now()}`;

  // 流式回复：监听增量块 → 打字机
  let streamBubble = null;
  const off = api.onChatStream((chunk) => {
    const box = $("#messages");
    if (!streamBubble || streamBubble.classList.contains("user") || !streamBubble.dataset.streaming) {
      // 开新助手气泡
      const el = document.createElement("div");
      el.className = "msg bot";
      el.dataset.streaming = "1";
      const bot = bots.find((b) => b.id === currentBot.id);
      el.innerHTML = `${bot?.avatarPath ? `<div class="avatar"><img src="file://${bot.avatarPath}"/></div>` : `<div class="avatar">🤖</div>`}<div class="bubble"></div>`;
      box.appendChild(el);
      streamBubble = el;
      box.scrollTop = box.scrollHeight;
    }
    const bubble = streamBubble.querySelector(".bubble");
    if (chunk.type === "text" && chunk.text) {
      bubble.innerHTML = renderMarkdown(esc((bubble.dataset.text || "") + chunk.text));
      bubble.dataset.text = (bubble.dataset.text || "") + chunk.text;
    } else if (chunk.type === "tool_call") {
      bubble.insertAdjacentHTML("beforeend", renderBlock(chunk));
    }
    box.scrollTop = box.scrollHeight;
  });
  try {
    const r = await api.chat.sendStream(currentBot.id, Array.isArray(rich) ? rich : text, currentSession);
    off();
    // 结束后刷新会话：最终落盘内容（含工具块 + meta）
    const msgs = await api.messages.list(currentSession);
    const lastBot = [...document.querySelectorAll("#messages .msg.bot")].pop();
    const final = msgs.find((m) => m.from === currentBot.id && m.role === "assistant");
    if (final) {
      if (lastBot) lastBot.remove();
      appendMsg(final);
    }
    if (r.result?.text && !final) {
      if (lastBot) lastBot.remove();
      appendMsg({ sessionId: currentSession, from: currentBot.id, to: "user", role: "assistant", content: [{ type: "text", text: r.result.text }], kind: "chat", createdAt: Date.now() });
    }
  } catch (e) {
    off();
    if (streamBubble) streamBubble.remove();
    appendMsg({ sessionId: currentSession, from: currentBot.id, to: "user", role: "assistant", content: `❌ 回复失败：${e.message || e}`, kind: "chat", createdAt: Date.now() });
  }
  // 调用方无需 await 刷新列表（消息已落盘）
}

function openModal(html) {
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-mask"><div class="modal">${html}</div></div>`;
  root.querySelector(".modal-mask").onclick = (e) => { if (e.target === e.currentTarget) root.innerHTML = ""; };
  return root.querySelector(".modal");
}

function closeModal() { $("#modal-root").innerHTML = ""; }

async function createBotFlow() {
  const modal = openModal(`
    <h2>一句话创建 bot</h2>
    <textarea id="mb-input" placeholder="例如：创建 bot：翻译助手，用 claude 模型，风格活泼">创建 bot：灵感助手，用 deepseek-chat 模型，风格活泼</textarea>
    <div class="hint">也可以说「创建 bot：一只负责提醒我的小狐狸」——名字、角色、模型会自动解析。</div>
    <div class="actions">
      <button class="ghost-btn" id="mb-cancel">取消</button>
      <button class="primary-btn" id="mb-ok">创建</button>
    </div>`);
  modal.querySelector("#mb-ok").onclick = async () => {
    const text = modal.querySelector("#mb-input").value.trim();
    if (!text) return;
    const bot = await api.bots.create(text);
    closeModal();
    await refreshBots();

// G3：宠物「打开完整会话」→ 主面板聚焦并跳转
api.onOpenSession(async (sid) => {
  if (!sid) { alert("没有可打开的会话，先和宠物聊一句吧"); return; }
  await openSessionById(sid);
});
    selectBot(bot);
  };
  modal.querySelector("#mb-cancel").onclick = closeModal;
}

async function personaFlow() {
  if (!currentBot) return;
  const modal = openModal(`
    <h2>一句话生成形象 — ${esc(currentBot.name)}</h2>
    <input id="mp-input" placeholder="例如：一只蓝色狐狸，可爱，戴眼镜" value="一只蓝色狐狸，可爱" />
    <div class="hint">会生成头像（本地文件）与角色卡；无图像 API 时自动用程序化头像，不阻塞。</div>
    <div class="actions">
      <button class="ghost-btn" id="mp-cancel">取消</button>
      <button class="primary-btn" id="mp-ok">生成</button>
    </div>`);
  modal.querySelector("#mp-ok").onclick = async () => {
    const desc = modal.querySelector("#mp-input").value.trim();
    await api.persona.generate(currentBot.id, desc || "一只蓝色狐狸，可爱");
    closeModal();
    await refreshBots();

// G3：宠物「打开完整会话」→ 主面板聚焦并跳转
api.onOpenSession(async (sid) => {
  if (!sid) { alert("没有可打开的会话，先和宠物聊一句吧"); return; }
  await openSessionById(sid);
});
    selectBot(currentBot);
  };
  modal.querySelector("#mp-cancel").onclick = closeModal;
}

async function settingsFlow() {
  const providers = await api.providers.list();
  const caps = await api.providers.capabilities();
  const modal = openModal(`
    <h2>模型配置中心</h2>
    <div class="kv">
      <label>CLI 检测</label><div>${["codex","cursor","claude"].map((c) => `${c}: ${caps[c]?.installed ? "✅" + (caps[c]?.version ? " " + esc(caps[c].version.split(" ")[0]) : "") : "❌"}`).join("　")}</div>
    </div>
    <h2 style="margin-top:6px">添加 Provider</h2>
    <div class="kv">
      <label>类型</label>
      <select id="mp-kind">
        <option value="openai-compat">OpenAI 兼容 API</option>
        <option value="cli">CLI（codex/cursor/claude）</option>
      </select>
      <label>名称</label><input id="mp-name" placeholder="例如 我的中转" value="我的中转" />
      <label>Base URL</label><input id="mp-url" placeholder="https://api.example.com/v1" value="" />
      <label>API Key</label><input id="mp-key" type="password" placeholder="sk-..." value="" />
      <label>模型</label><input id="mp-model" placeholder="gpt-4o-mini / deepseek-chat" value="gpt-4o-mini" />
      <label>CLI 名</label><select id="mp-cli"><option value="claude">claude</option><option value="codex">codex</option><option value="cursor">cursor</option></select>
    </div>
    <div class="actions">
      <button class="ghost-btn" id="mp-test">测试连接</button>
      <button class="primary-btn" id="mp-add">添加</button>
    </div>
    <div id="mp-test-result"></div>
    <h2 style="margin-top:8px">已有 Provider</h2>
    <div id="mp-providers"></div>
    <div class="actions"><button class="ghost-btn" id="mp-close">关闭</button></div>`);
  const listP = () => {
    const box = modal.querySelector("#mp-providers");
    box.innerHTML = providers.length ? providers.map((p) => `
      <div class="row" style="margin-bottom:6px">
        <span style="flex:1">${esc(p.name)} <span class="hint">${p.kind === "cli" ? "CLI" : "API"}${p.isDefault ? " ★默认" : ""}</span></span>
        <button class="ghost-btn" data-del="${p.id}">删除</button>
      </div>`).join("") : `<span class="hint">还没有 provider</span>`;
    box.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
      await api.providers.remove(b.dataset.del);
      await settingsFlow();
    }));
  };
  listP();
  modal.querySelector("#mp-add").onclick = async () => {
    const kind = modal.querySelector("#mp-kind").value;
    const cliName = modal.querySelector("#mp-cli").value;
    await api.providers.add({
      kind,
      name: modal.querySelector("#mp-name").value.trim() || "未命名",
      baseUrl: modal.querySelector("#mp-url").value.trim() || undefined,
      apiKey: modal.querySelector("#mp-key").value.trim() || undefined,
      model: modal.querySelector("#mp-model").value.trim() || undefined,
      cliName: kind === "cli" ? cliName : undefined,
      isDefault: providers.length === 0,
    });
    await settingsFlow();
  };
  modal.querySelector("#mp-test").onclick = async () => {
    const p = await api.providers.add({
      kind: modal.querySelector("#mp-kind").value,
      name: "__test__",
      baseUrl: modal.querySelector("#mp-url").value.trim() || undefined,
      apiKey: modal.querySelector("#mp-key").value.trim() || undefined,
      model: modal.querySelector("#mp-model").value.trim() || undefined,
      cliName: modal.querySelector("#mp-kind").value === "cli" ? modal.querySelector("#mp-cli").value : undefined,
    });
    const r = await api.providers.test(p.id);
    await api.providers.remove(p.id);
    const el = modal.querySelector("#mp-test-result");
    el.className = "test-result " + (r.ok ? "ok" : "bad");
    el.textContent = r.ok ? "✅ 连接成功：" + (r.detail || "") : "❌ " + (r.detail || "");
  };
  modal.querySelector("#mp-close").onclick = closeModal;
}

async function migrateFlow() {
  const modal = openModal(`
    <h2>迁移</h2>
    <div class="hint">导出会生成一个 JSON（含 bots、provider、形象引用；可脱敏 key）。导入会还原并复制形象文件。</div>
    <div class="row">
      <input id="mm-path" placeholder="文件路径，如 /tmp/harness-export.json" value="/tmp/harness-export.json" />
    </div>
    <div class="actions">
      <button class="ghost-btn" id="mm-export">导出（脱敏 key）</button>
      <button class="ghost-btn" id="mm-export-raw">导出（含 key）</button>
      <button class="primary-btn" id="mm-import">导入</button>
    </div>
    <div id="mm-result" class="hint"></div>
    <div class="actions"><button class="ghost-btn" id="mm-close">关闭</button></div>`);
  const result = modal.querySelector("#mm-result");
  modal.querySelector("#mm-export").onclick = async () => {
    await api.migration.export(modal.querySelector("#mm-path").value.trim(), true);
    result.textContent = "✅ 已导出（key 脱敏）";
  };
  modal.querySelector("#mm-export-raw").onclick = async () => {
    await api.migration.export(modal.querySelector("#mm-path").value.trim(), false);
    result.textContent = "✅ 已导出（含 key）";
  };
  modal.querySelector("#mm-import").onclick = async () => {
    const r = await api.migration.import(modal.querySelector("#mm-path").value.trim());
    result.textContent = `✅ 导入完成：providers ${r.importedProviders} / bots ${r.importedBots} / pets ${r.importedPets}`;
    closeModal();
    await refreshBots();

// G3：宠物「打开完整会话」→ 主面板聚焦并跳转
api.onOpenSession(async (sid) => {
  if (!sid) { alert("没有可打开的会话，先和宠物聊一句吧"); return; }
  await openSessionById(sid);
});
  };
  modal.querySelector("#mm-close").onclick = closeModal;
}

async function botDetailFlow(b) {
  const mem = await api.memory.list(b.id);
  const stats = await api.memory.stats(b.id);
  const skills = await api.skills.list();
  const tasks = await api.tasks.list(b.id);
  const st = statuses[b.id] || { state: "idle" };
  const card = b.personaCard;
  const modal = openModal(`
    <h2>${esc(b.name)} ${b.petEnabled ? "🐾" : ""}
      <span class="status-dot st-${st.state}" title="${esc(st.state)}"></span>
    </h2>
    <div class="kv">
      <label>角色</label><span>${esc(b.role || "通用助手")}</span>
      <label>人设</label><span>${esc(b.persona || "—")}</span>
      ${card ? `<label>性格</label><span>${esc(card.traits?.join("、") || "—")}</span>
      ${card.catchphrase ? `<label>口头禅</label><span>${esc(card.catchphrase)}</span>` : ""}
      ${card.background ? `<label>背景</label><span>${esc(card.background)}</span>` : ""}` : ""}
      <label>状态</label><span>${esc(st.state)}${st.currentTask ? " · " + esc(st.currentTask) : ""}</span>
      <label>记忆</label><span>${Object.entries(stats || {}).map(([k, v]) => `${k}:${v}`).join("、") || "无"}</span>
      <label>技能</label><span>${skills.filter((x) => x.enabled).map((x) => esc(x.name)).join("、") || "无"}</span>
      <label>定时</label><span>${tasks.length ? tasks.map((t) => esc(t.name) + "(" + esc(t.cron) + ")").join("、") : "无"}</span>
    </div>
    <div class="actions">
      <button class="ghost-btn" id="bd-persona">✨ 生成形象</button>
      <button class="primary-btn" id="bd-chat">去对话</button>
      <button class="ghost-btn" id="bd-close">关闭</button>
    </div>
    <div class="hint" id="bd-tip"></div>`);
  modal.querySelector("#bd-persona").onclick = async () => {
    const desc = prompt("一句话描述形象（如：一只蓝色狐狸，可爱）", "一只蓝色狐狸，可爱");
    if (desc) {
      closeModal();
      await api.persona.generate(b.id, desc);
      await refreshBots();

// G3：宠物「打开完整会话」→ 主面板聚焦并跳转
api.onOpenSession(async (sid) => {
  if (!sid) { alert("没有可打开的会话，先和宠物聊一句吧"); return; }
  await openSessionById(sid);
});
    }
  };
  modal.querySelector("#bd-chat").onclick = () => { closeModal(); selectBot(b); };
  modal.querySelector("#bd-close").onclick = closeModal;
}

async function memoryFlow() {
  if (!currentBot) return;
  const ns = await currentMemoryNs();
  const entries = await api.memory.list(ns === "global" ? "global" : currentBot.id);
  const namespaces = await api.memory.namespaces();
  const memo = await api.memory.memo(ns);
  const modal = openModal(`
    <h2>🧠 ${esc(currentBot.name)} 的持久记忆 <span class="hint">(${esc(ns)})</span></h2>
    <div class="row" style="gap:4px;flex-wrap:wrap">
      ${["bot:" + currentBot.id, ...namespaces.filter((n) => n !== "bot:" + currentBot.id && n !== "global"), "global"].filter((n, i, a) => a.indexOf(n) === i).map((n) => `
        <button class="ghost-btn memo-ns${n === ns ? " active" : ""}" data-ns="${esc(n)}">${esc(n)}</button>`).join("")}
    </div>
    <div class="row"><input id="mm-add" placeholder="记一条事实/笔记（写入当前 namespace）" /></div>
    <div class="actions"><button class="primary-btn" id="mm-add-btn">记住</button></div>
    <div id="mm-entries">
      ${entries.length ? entries.map((e) => `
        <div class="row" style="margin:4px 0">
          <span class="hint" style="flex:none">${esc(e.kind)}${e.source ? ` · ${esc(e.source)}` : ""}</span>
          <span style="flex:1">${esc(e.content)}</span>
          <button class="ghost-btn" data-del="${esc(e.id)}">✕</button>
        </div>`).join("") : `<span class="hint">${ns.includes("group:") || ns === "global" ? "该共享空间暂无记忆" : "还没有记忆。可以让 bot 记住偏好，或说「记住：…」"}</span>`}
    </div>
    <div class="row" style="gap:6px;margin-top:6px;align-items:center">
      <b style="font-size:12.5px">MEMORY.md 权威总结</b>
      <button class="ghost-btn" id="mm-rewrite" style="font-size:11px">✨ 用 LLM 重写</button>
      <button class="ghost-btn" id="mm-merge" style="font-size:11px">🧹 合并重复</button>
    </div>
    <textarea id="mm-memo" rows="5" style="width:100%;background:#1a1a1a;color:#eaeaea;border:1px solid #333;border-radius:8px;padding:8px;font-size:12.5px;margin-top:4px">${esc(memo)}</textarea>
    <div class="actions"><button class="ghost-btn" id="mm-save-memo">保存总结</button><button class="ghost-btn" id="mm-close">关闭</button></div>`);

  const currentNs = () => modal.querySelector(".memo-ns.active")?.dataset.ns || ns;
  modal.querySelectorAll(".memo-ns").forEach((b) => (b.onclick = () => {
    blockSwitchNs = b.dataset.ns;
    memoryFlow();
  }));
  modal.querySelector("#mm-add-btn").onclick = async () => {
    const v = modal.querySelector("#mm-add").value.trim();
    if (!v) return;
    const targetNs = currentNs();
    const entry = { kind: "fact", content: v, tags: ["手动"], source: "user" };
    if (targetNs !== "bot:" + currentBot.id) entry.namespace = targetNs;
    await api.memory.add(currentBot.id, entry);
    memoryFlow();
  };
  modal.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
    await api.memory.remove(currentBot.id, b.dataset.del);
    memoryFlow();
  }));
  modal.querySelector("#mm-rewrite").onclick = async () => {
    modal.querySelector("#mm-rewrite").textContent = "生成中…";
    try { await api.memory.rewriteMemo(currentNs()); } catch (e) { alert(e.message || e); }
    memoryFlow();
  };
  modal.querySelector("#mm-merge").onclick = async () => {
    await api.memory.merge(currentNs());
    memoryFlow();
  };
  modal.querySelector("#mm-save-memo").onclick = async () => {
    await api.memory.setMemo(currentNs(), modal.querySelector("#mm-memo").value);
    closeModal();
  };
  modal.querySelector("#mm-close").onclick = closeModal;
}

// 记录正在浏览的 namespace（切换标签用）
let blockSwitchNs = null;
async function currentMemoryNs() {
  if (blockSwitchNs) return blockSwitchNs;
  return "bot:" + (currentBot?.id || "");
}

async function skillsFlow() {
  const all = await api.skills.list();
  const modal = openModal(`
    <h2>🛠 技能（SKILL.md）</h2>
    <div class="hint">技能 = 目录/SKILL.md + frontmatter(name/description)。回复需要时模型会调用。</div>
    <div class="row"><input id="ms-create" placeholder="一句话创建：创建技能：自动周报，每周五总结本周工作" /></div>
    <div class="actions"><button class="primary-btn" id="ms-create-btn">创建技能</button></div>
    <div id="ms-list">
      ${all.length ? all.map((sk) => `
        <div class="row" style="margin:4px 0">
          <button class="ghost-btn" style="flex:none" data-toggle="${sk.key}">${sk.enabled ? "✅" : "⬜"}</button>
          <span style="flex:1"><b>${esc(sk.name)}</b> <span class="hint">${esc(sk.description)}</span></span>
          <button class="ghost-btn" data-del="${sk.key}">✕</button>
        </div>`).join("") : `<span class="hint">还没有技能</span>`}
    </div>
    <div class="actions"><button class="ghost-btn" id="ms-close">关闭</button></div>`);
  modal.querySelector("#ms-create-btn").onclick = async () => {
    const v = modal.querySelector("#ms-create").value.trim();
    if (!v) return;
    try {
      await api.skills.create(v);
      await skillsFlow();
    } catch (e) {
      const el = modal.querySelector("#ms-create");
      el.placeholder = "创建失败：" + (e?.message || "未知错误");
    }
  };
  modal.querySelectorAll("[data-toggle]").forEach((b) => (b.onclick = async () => {
    await api.skills.setEnabled(b.dataset.toggle, !b.textContent.trim().startsWith("✅"));
    await skillsFlow();
  }));
  modal.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
    await api.skills.remove(b.dataset.del);
    await skillsFlow();
  }));
  modal.querySelector("#ms-close").onclick = closeModal;
}

async function tasksFlow() {
  const modal = openModal(`
    <h2>⏰ 定时任务</h2>
    <div class="hint">cron 5 段：分 时 日 月 周。到期会唤醒对应 bot 执行。</div>
    ${currentBot ? `
    <div class="kv">
      <label>任务名</label><input id="mt-name" placeholder="每日早报" value="每日早报" />
      <label>cron</label><input id="mt-cron" placeholder="0 9 * * *" value="0 9 * * *" />
      <label>执行指令</label><input id="mt-prompt" placeholder="给 bot 的指令" value="生成今日早报，用中文总结" />
    </div>
    <div class="actions"><button class="primary-btn" id="mt-add">为 ${esc(currentBot.name)} 添加</button></div>
    <div class="kv" style="border-top:1px solid #222; padding-top:10px; margin-top:6px">
      <label>⏰ 一次性提醒</label><input id="mt-alarm-min" type="number" min="1" value="15" style="width:70px" />
      <label>提醒我</label><input id="mt-alarm-text" placeholder="喝水、站起来活动…" value="喝水时间到！" />
      <label class="chk"><input id="mt-alarm-pet" type="checkbox" checked /> 宠物弹气泡提醒</label>
    </div>
    <div class="actions"><button class="ghost-btn" id="mt-alarm-add">添加提醒</button></div>` : `<span class="hint">先选一个 bot 再添加定时任务</span>`}
    <div id="mt-list"></div>
    <div class="actions"><button class="ghost-btn" id="mt-close">关闭</button></div>`);
  const render = async () => {
    const tasks = await api.tasks.list(currentBot?.id);
    const box = modal.querySelector("#mt-list");
    box.innerHTML = tasks.length ? tasks.map((t) => `
      <div class="row" style="margin:4px 0">
        <button class="ghost-btn" style="flex:none" data-toggle="${t.id}">${t.enabled ? "▶️" : "⏸"}</button>
        <span style="flex:1"><b>${esc(t.name)}</b>
          <span class="hint">${t.kind === "once" ? "🔔 一次性" : "⏱ " + esc(t.cron)}${t.notifyPet ? " 🐾" : ""} · 已跑${t.runCount}次${t.nextRunAt ? " · " + (t.kind === "once" ? "触发时间 " : "下次 ") + new Date(t.nextRunAt).toLocaleString("zh-CN", { hour12: false }) : ""}</span>
          ${t.lastResult ? `<div class="hint">${t.lastResult === "ok" ? "✅" : "❌"} ${esc(t.lastRunLog || "")}</div>` : ""}
        </span>
        <button class="ghost-btn" data-run="${t.id}">⚡</button>
        <button class="ghost-btn" data-del="${t.id}">✕</button>
      </div>`).join("") : `<span class="hint">还没有定时任务</span>`;
    box.querySelectorAll("[data-toggle]").forEach((b) => (b.onclick = async () => {
      const t = tasks.find((x) => x.id === b.dataset.toggle);
      await api.tasks.setEnabled(b.dataset.toggle, !t.enabled);
      render();
    }));
    box.querySelectorAll("[data-run]").forEach((b) => (b.onclick = async () => { await api.tasks.runNow(b.dataset.run); render(); }));
    box.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => { await api.tasks.remove(b.dataset.del); render(); }));
  };
  render();
  modal.querySelector("#mt-add").onclick = async () => {
    await api.tasks.create({
      botId: currentBot.id,
      name: modal.querySelector("#mt-name").value.trim() || "任务",
      cron: modal.querySelector("#mt-cron").value.trim(),
      prompt: modal.querySelector("#mt-prompt").value.trim(),
    });
    render();
  };
  const alarmBtn = modal.querySelector("#mt-alarm-add");
  if (alarmBtn) alarmBtn.onclick = async () => {
    const mins = parseInt(modal.querySelector("#mt-alarm-min")?.value || "15", 10);
    await api.tasks.create({
      botId: currentBot.id,
      name: "🔔 " + (modal.querySelector("#mt-alarm-text")?.value.trim() || "提醒"),
      cron: "* * * * *",
      prompt: modal.querySelector("#mt-alarm-text")?.value.trim() || "时间到了",
      kind: "once",
      alarmAt: Date.now() + Math.max(1, mins) * 60_000,
      notifyPet: modal.querySelector("#mt-alarm-pet")?.checked ?? true,
    });
    render();
  };
  modal.querySelector("#mt-close").onclick = closeModal;
}



async function mcpFlow() {
  const tools = await api.mcp.list();
  const modal = openModal(`
    <h2>🔌 MCP 工具</h2>
    <div class="hint">已连接的 MCP server 暴露的工具（来自 config 的 mcpServers 配置）。模型可在需要时调用。</div>
    <div id="mcp-tools">
      ${tools.length ? tools.map((t) => `
        <div class="row" style="margin:4px 0">
          <span class="hint" style="flex:none">${esc(t.serverId)}</span>
          <span style="flex:1"><b>${esc(t.name)}</b> <span class="hint">${esc(t.description || "")}</span></span>
        </div>`).join("") : `<span class="hint">未配置 MCP server。可在 ~/.harness-bot/config.json 加 mcpServers 数组。</span>`}
    </div>
    <div class="actions"><button class="ghost-btn" id="mcp-close">关闭</button></div>`);
  modal.querySelector("#mcp-close").onclick = closeModal;
}

// ---- bind ----
$("#new-bot-btn").onclick = createBotFlow;
$("#settings-btn").onclick = settingsFlow;
$("#migrate-btn").onclick = migrateFlow;
$("#memory-btn").onclick = memoryFlow;
$("#skills-btn").onclick = skillsFlow;
$("#tasks-btn").onclick = tasksFlow;
$("#mcp-btn").onclick = mcpFlow;
$("#send-btn").onclick = send;
// V3：图片粘贴/拖入 → 消息以富块发送
let pendingImages = [];

function addPendingImage(dataUrl, name) {
  const shown = dataUrl.length;
  pendingImages.push({ type: "image", dataUrl, alt: name || "粘贴图片" });
  const hint = $("#img-hint");
  if (!hint) {
    const el = document.createElement("div");
    el.id = "img-hint";
    el.style.cssText = "font-size:12px;color:var(--dim);padding:4px 8px;border:1px dashed #444;border-radius:8px;margin-bottom:4px;";
    $("#composer").insertBefore(el, $("#input"));
    el.textContent = `${pendingImages.length} 张图片待发送（可继续粘贴/输入文字）`;
  } else {
    hint.textContent = `${pendingImages.length} 张图片待发送`;
  }
}

function clearImgHint() {
  const hint = $("#img-hint");
  if (hint) hint.remove();
  pendingImages = [];
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const rd = new FileReader();
    rd.onload = () => resolve(rd.result);
    rd.onerror = () => reject(rd.error);
    rd.readAsDataURL(file);
  });
}

document.addEventListener("paste", async (e) => {
  const items = [...(e.clipboardData?.items ?? [])];
  const imgs = items.filter((i) => i.type.startsWith("image/"));
  if (!imgs.length) return;
  e.preventDefault();
  for (const item of imgs) {
    const file = item.getAsFile();
    if (!file) continue;
    try { addPendingImage(await fileToDataUrl(file), file.name); } catch { /* ignore */ }
  }
});

$("#composer").addEventListener("dragover", (e) => { e.preventDefault(); });
$("#composer").addEventListener("drop", async (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
  for (const f of files) {
    try { addPendingImage(await fileToDataUrl(f), f.name); } catch { /* ignore */ }
  }
});

// G1 搜索（防抖，输入即查，空词隐藏）
let searchTimer = null;
$("#search-input").addEventListener("input", async (e) => {
  clearTimeout(searchTimer);
  const v = e.target.value.trim();
  const box = $("#search-results");
  if (!v) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  searchTimer = setTimeout(async () => {
    const hits = await api.messages.search({ q: v, limit: 20 });
    box.innerHTML = "";
    if (!hits.length) { box.innerHTML = `<div class="sr"><span class="sr-bot">无结果</span></div>`; box.classList.remove("hidden"); return; }
    for (const h of hits) {
      const el = document.createElement("div");
      el.className = "sr";
      const bot = bots.find((b) => b.id === h.botId);
      el.innerHTML = `<div class="sr-bot">${esc(bot?.name || h.botId)} · ${esc(new Date(h.createdAt).toLocaleString())}</div><div class="sr-snippet">${esc(h.snippet)}</div>`;
      el.onclick = () => openSessionById(h.sessionId);
      box.appendChild(el);
    }
    box.classList.remove("hidden");
  }, 250);
});
document.addEventListener("click", (e) => { if (!e.target.closest("#search-box")) $("#search-results")?.classList.add("hidden"); });

/** G1：按 session 打开（搜索跳转 / 宠物跳转共用） */
async function openSessionById(sid) {
  const sessions = await api.sessions.page({ limit: 100 });
  const s = sessions.sessions.find((x) => x.id === sid);
  if (!s) return;
  const bot = bots.find((b) => b.id === s.botId);
  if (!bot) return;
  currentBot = bot;
  currentSession = sid;
  document.querySelectorAll(".bot-item").forEach((el) => el.classList.remove("active"));
  const item = [...document.querySelectorAll(".bot-item")].find((el) => el.textContent.includes(bot.name));
  if (item) item.classList.add("active");
  $("#empty-state").style.display = "none";
  $("#messages").innerHTML = "";
  await loadSessionMessages(sid, true);
}

// G1：会话右键（归档/取消归档/删除）
$("#messages").addEventListener("contextmenu", async (e) => {
  if (!currentSession) return;
  e.preventDefault();
  const sid = currentSession;
  const sessions = await api.sessions.page({ limit: 100 });
  const s = sessions.sessions.find((x) => x.id === sid);
  if (!s) { // 可能已归档
    const all = await api.sessions.page({ limit: 100, archived: true });
    if (!all.sessions.some((x) => x.id === sid)) return;
  }
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.cssText = "position:fixed;z-index:99;background:#17171c;border:1px solid #333;border-radius:8px;padding:4px;min-width:140px;font-size:12.5px;box-shadow:0 8px 30px rgba(0,0,0,.5)";
  menu.style.left = Math.min(e.clientX, window.innerWidth - 160) + "px";
  menu.style.top = Math.min(e.clientY, window.innerHeight - 120) + "px";
  const archived = s?.archived;
  menu.innerHTML = `
    <div class="ctx-item" data-act="${archived ? "unarchive" : "archive"}">${archived ? "↩ 取消归档" : "🗂 归档会话"}</div>
    <div class="ctx-item danger" data-act="delete">🗑 删除会话</div>`;
  Object.assign(menu.style, {});
  document.body.appendChild(menu);
  menu.querySelectorAll(".ctx-item").forEach((it) => {
    it.style.cssText = "padding:7px 12px;border-radius:6px;cursor:pointer";
    it.onmouseenter = () => it.style.background = "#23232a";
    it.onmouseleave = () => it.style.background = "transparent";
    it.onclick = async () => {
      menu.remove();
      const act = it.dataset.act;
      if (act === "archive" || act === "unarchive") {
        await api.sessions.archive(sid, act === "archive");
      } else if (act === "delete") {
        if (!confirm("确定删除该会话及全部消息？")) return;
        await api.sessions.remove(sid);
        currentSession = null;
        $("#messages").innerHTML = "";
      }
      // 刷新会话（无 UI 会话列表，仅清空/保留）
      if (act === "delete" && currentBot) { /* 重新选 bot 刷新 */ }
    };
  });
  const off = (e) => { if (!e.target.closest(".ctx-menu")) { menu.remove(); document.removeEventListener("click", off); } };
  setTimeout(() => document.addEventListener("click", off), 0);
});

$("#input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});
document.querySelectorAll(".chip").forEach((c) => (c.onclick = async () => {
  const bot = await api.bots.create(c.dataset.tpl);
  await refreshBots();

// G3：宠物「打开完整会话」→ 主面板聚焦并跳转
api.onOpenSession(async (sid) => {
  if (!sid) { alert("没有可打开的会话，先和宠物聊一句吧"); return; }
  await openSessionById(sid);
});
  selectBot(bot);
}));
// 双击 bot 头像 → 生成形象
$("#bot-list").addEventListener("dblclick", (e) => {
  const item = e.target.closest(".bot-item");
  if (item && currentBot) personaFlow();
});

refreshBots();

// G3：宠物「打开完整会话」→ 主面板聚焦并跳转
api.onOpenSession(async (sid) => {
  if (!sid) { alert("没有可打开的会话，先和宠物聊一句吧"); return; }
  await openSessionById(sid);
});
