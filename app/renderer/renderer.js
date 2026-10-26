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
      <button class="ghost-btn pet-toggle" title="${b.petEnabled ? "隐藏宠物" : "变成桌面宠物"}">${b.petEnabled ? "✕" : "🐾"}</button>`;
    el.querySelector(".pet-toggle").onclick = async (e) => {
      e.stopPropagation();
      await api.bots.setPet(b.id, !b.petEnabled);
      await refreshBots();
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
  const sessions = await api.sessions.list(b.id);
  if (sessions.length) {
    currentSession = sessions[0].id;
    const msgs = await api.messages.list(sessions[0].id);
    msgs.forEach((m) => appendMsg(m));
  }
}

function appendMsg(m) {
  const box = $("#messages");
  const el = document.createElement("div");
  const fromName = m.from === "user" ? "我" : (bots.find((b) => b.id === m.from)?.name || m.from);
  if (m.kind === "event") {
    el.className = "msg sys";
    el.innerHTML = `<div class="bubble">${esc(m.content)}</div>`;
  } else {
    el.className = "msg " + (m.from === "user" ? "user" : "bot");
    const avatar = m.from === "user"
      ? `<div class="avatar">🧑</div>`
      : (() => { const b = bots.find((x) => x.id === m.from); return `<div class="avatar">${b?.avatarPath ? `<img src="file://${b.avatarPath}"/>` : "🤖"}</div>`; })();
    el.innerHTML = `${m.from !== "user" ? `<div class="who">${esc(fromName)}</div>` : ""}${avatar}<div class="bubble">${esc(m.content)}</div>`;
  }
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

async function send() {
  const text = $("#input").value.trim();
  if (!text || !currentBot) return;
  $("#input").value = "";
  // @bot名 → bot 间通信
  const atMatch = text.match(/^@(\S+)\s+([\s\S]+)/);
  if (atMatch) {
    const target = bots.find((b) => b.name === atMatch[1] || b.name.includes(atMatch[1]));
    if (target) {
      const msgs = await api.bus.send(currentBot.id, target.id, atMatch[2]);
      msgs.forEach((m) => appendMsg(m));
      return;
    }
  }
  const msgs = await api.chat.send(currentBot.id, text, currentSession);
  msgs.forEach((m) => appendMsg(m));
  if (msgs.length && currentSession === null) currentSession = msgs[0].sessionId;
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
  };
  modal.querySelector("#mm-close").onclick = closeModal;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- bind ----
$("#new-bot-btn").onclick = createBotFlow;
$("#settings-btn").onclick = settingsFlow;
$("#migrate-btn").onclick = migrateFlow;
$("#send-btn").onclick = send;
$("#input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});
document.querySelectorAll(".chip").forEach((c) => (c.onclick = async () => {
  const bot = await api.bots.create(c.dataset.tpl);
  await refreshBots();
  selectBot(bot);
}));
// 双击 bot 头像 → 生成形象
$("#bot-list").addEventListener("dblclick", (e) => {
  const item = e.target.closest(".bot-item");
  if (item && currentBot) personaFlow();
});

refreshBots();
