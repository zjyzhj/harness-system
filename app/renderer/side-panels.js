// 附件、bot 列表与右栏详情（产出、工作区）、技能编辑器
/* ---------- 附件：图片 / PDF / Word / 表格 / 代码，发送前在输入框上方排成一行 ---------- */
let pendingAtt = [];

function addPending(block) {
  pendingAtt.push(block);
  renderPending();
}

function clearPending() {
  pendingAtt = [];
  renderPending();
}

function renderPending() {
  let row = $("#attach-row");
  if (!pendingAtt.length) { row?.remove(); return; }
  if (!row) {
    row = document.createElement("div");
    row.id = "attach-row";
    $("#composer").insertBefore(row, $(".composer-box"));
  }
  row.innerHTML = pendingAtt.map((b, i) => b.type === "image"
    ? `<div class="att img" title="${esc(b.alt || "")}"><img src="${esc(imgSrc(b))}" /><button data-i="${i}" title="移除">✕</button></div>`
    : `<div class="att" title="${esc(b.name)}"><span class="att-ico">${fileIcon(b.name)}</span><span class="att-main"><span class="att-name">${esc(b.name)}</span><span class="att-sub">${b.error ? "读不出内容" : b.chars ? `${b.chars.toLocaleString()} 字` : formatBytes(b.size ?? 0)}</span></span><button data-i="${i}" title="移除">✕</button></div>`).join("");
  row.querySelectorAll("button[data-i]").forEach((btn) => (btn.onclick = () => { pendingAtt.splice(Number(btn.dataset.i), 1); renderPending(); }));
}

/** 本机文件（拖入 / 选择）→ 复制进附件目录并抽出文字 */
async function attachPaths(paths) {
  if (!paths.length) return;
  const row = $("#attach-row");
  const hint = document.createElement("div");
  hint.className = "att loading";
  hint.textContent = `正在读取 ${paths.length} 个文件…`;
  (row ?? $("#composer")).insertBefore(hint, row ? null : $(".composer-box"));
  try {
    (await api.files.ingest(paths)).forEach((b) => pendingAtt.push(b));
  } catch (e) {
    alert(`添加附件失败：${errText(e)}`);
  } finally {
    hint.remove();
    renderPending();
  }
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
  if (e.target.closest?.(".wb-edit, .edit-box, .modal, .mx-body")) return;
  const files = [...(e.clipboardData?.files ?? [])];
  if (!files.length) return;
  e.preventDefault();
  const paths = files.map((f) => api.files.pathOf(f)).filter(Boolean);
  if (paths.length) return attachPaths(paths);
  for (const f of files.filter((x) => x.type.startsWith("image/"))) {
    try { addPending({ type: "image", dataUrl: await fileToDataUrl(f), alt: f.name || "粘贴图片" }); } catch { /* 读不了就跳过 */ }
  }
});

$("#composer").addEventListener("dragover", (e) => { e.preventDefault(); $("#composer").classList.add("drop"); });
$("#composer").addEventListener("dragleave", () => $("#composer").classList.remove("drop"));
$("#composer").addEventListener("drop", async (e) => {
  e.preventDefault();
  $("#composer").classList.remove("drop");
  const files = [...(e.dataTransfer?.files ?? [])];
  const paths = files.map((f) => api.files.pathOf(f)).filter(Boolean);
  if (paths.length) return attachPaths(paths);
  for (const f of files.filter((x) => x.type.startsWith("image/"))) {
    try { addPending({ type: "image", dataUrl: await fileToDataUrl(f), alt: f.name }); } catch { /* 读不了就跳过 */ }
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
async function openSessionById(sid, botId) {
  const s = (await api.sessions.get(sid).catch(() => null)) ?? (pending.has(sid) && botId ? { id: sid, botId } : null);
  if (!s) return;
  const g = groupList.find((x) => x.id === s.botId) ?? (sid.startsWith("group-") ? groupList.find((x) => sid.startsWith(`group-${x.id}`)) : null);
  if (g) return selectGroup(g, sid);
  const bot = bots.find((b) => b.id === s.botId);
  if (!bot) return;
  currentBot = bot;
  currentSession = sid;
  markActiveBot(bot);
  clearMessages();
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
        clearMessages();
      }
      // 刷新会话（无 UI 会话列表，仅清空/保留）
      if (act === "delete" && currentBot) { /* 重新选 bot 刷新 */ }
    };
  });
  const off = (e) => { if (!e.target.closest(".ctx-menu")) { menu.remove(); document.removeEventListener("click", off); } };
  setTimeout(() => document.addEventListener("click", off), 0);
});

$("#input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!pending.has(currentSession)) send();
    else if (currentGroup && $("#input").value.trim()) interject(currentGroup, currentSession);
  }
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

// G3：宠物「打开完整会话」→ 主面板聚焦并跳转
api.onOpenSession(async (sid) => {
  if (!sid) { alert("没有可打开的会话，先和宠物聊一句吧"); return; }
  await openSessionById(sid);
});

// ---- 右栏详情（Grok Bot 式：头像 / 名称 / 详情·记忆 / 定时任务） ----
let detailsTab = "info";
let showArchived = false;
let detailsPinned = true;
function toggleDetails(show) {
  const panel = $("#details");
  const on = show ?? panel.classList.contains("hidden");
  detailsPinned = on;
  panel.classList.toggle("hidden", !on);
  document.body.classList.toggle("details-open", on);
  // 右栏始终占 flex 位挤窄会话，不再叠层遮罩
  $("#details-mask")?.classList.add("hidden");
  if (on && typeof realmPresence !== "undefined" && realmPresence && typeof renderRealmDetails === "function") renderRealmDetails();
  else if (on && currentGroup) renderGroupDetails(currentGroup);
  else if (on && currentBot) renderDetails(currentBot);
}

async function exportSession(sid) {
  if (!sid) return alert("当前没有会话可导出");
  const path = await api.sessions.export(sid);
  if (path) api.system.reveal(path);
}

/* ---- 产出：bot 交付过的图片和文件 ---- */
function libraryHtml(items) {
  const images = items.filter((x) => x.type === "image");
  const files = items.filter((x) => x.type === "file");
  if (!items.length) return `<div class="d-sec"><div class="d-empty">还没有产出物。bot 用 file.send 交付的图片和文件会汇总在这里</div></div>`;
  return `
    ${images.length ? `<div class="d-sec"><h4>图片 · ${images.length}</h4><div class="lib-grid">${images.map((x, i) => `<button class="lib-img" data-i="${i}" title="${esc(x.alt || "")}"><img src="${esc(imgSrc(x))}" loading="lazy" /></button>`).join("")}</div></div>` : ""}
    ${files.length ? `<div class="d-sec"><h4>文件 · ${files.length}</h4><div class="lib-files"></div></div>` : ""}`;
}
function bindLibrary(panel, items) {
  const images = items.filter((x) => x.type === "image");
  panel.querySelectorAll(".lib-img").forEach((el) => (el.onclick = () => openLightbox(images, Number(el.dataset.i))));
  const box = panel.querySelector(".lib-files");
  if (box) items.filter((x) => x.type === "file").forEach((f) => box.appendChild(fileCard(f)));
}

/* ---- 工作区：工作目录 + 最近操作 + 当前状态 + 已存密钥 ---- */
function workspaceHtml(ws, b) {
  if (!ws) return `<div class="d-sec"><div class="d-empty">工作区不可用</div></div>`;
  const running = ws.status?.state === "running";
  const files = ws.files.filter((f) => !f.dir).slice(0, 60);
  return `
    <div class="d-sec"><h4>状态</h4>
      <div class="d-card"><span class="ws-dot ${running ? "on" : ""}"></span><div class="c-main"><div class="c-title">${running ? "正在处理" : "空闲"}</div><div class="c-sub">${esc(running ? ws.status.currentTask || "" : ws.status?.lastRunAt ? `上次活动 ${fmtTime(ws.status.lastRunAt)}` : "还没有活动")}</div></div></div>
    </div>
    <div class="d-sec"><h4>工作目录 <button class="list-add" id="ws-open" title="在 Finder 中打开">↗</button></h4>
      <div class="ws-path" title="${esc(ws.dir || "")}">${esc((ws.dir || "").replace(/^\/Users\/[^/]+/, "~"))}</div>
      ${files.length ? `<div class="ws-files">${files.map((f) => `<div class="ws-file" data-path="${esc(f.path)}"><span>${fileIcon(f.rel)}</span><span class="ws-name">${esc(f.rel)}</span><span class="ws-meta">${formatBytes(f.size)}</span></div>`).join("")}</div>` : `<div class="d-empty">目录是空的。${esc(b.name)} 用 fs.write 生成的文件会出现在这里</div>`}
    </div>
    <div class="d-sec"><h4>最近操作</h4>
      ${ws.activity.length ? `<div class="ws-acts">${ws.activity.map((a) => { const t = toolLabel(a); return `<div class="ws-act ${a.status === "error" ? "err" : ""}" data-sid="${esc(a.sessionId)}" title="${esc(a.result || "")}"><span>${t.icon}</span><span class="ws-name">${esc(t.label)}${t.arg ? ` · ${esc(t.arg)}` : ""}</span><span class="ws-meta">${esc(fmtTime(a.at))}</span></div>`; }).join("")}</div>` : `<div class="d-empty">还没有调用过工具</div>`}
    </div>
    ${ws.env?.length || ws.secrets.length ? `<div class="d-sec"><h4>它记得的配置 <a class="ref" data-ref="settings" data-id="env">管理</a></h4>
      ${(ws.env || []).map((e) => `<div class="d-card"><div class="c-main"><div class="c-title">⚙️ ${esc(e.label || e.key)}</div><div class="c-sub">$${esc(e.key)} = ${esc(e.value.length > 60 ? `${e.value.slice(0, 60)}…` : e.value)}${e.botId ? "" : " · 共用"}</div></div></div>`).join("")}
      ${ws.secrets.map((x) => `<div class="d-card"><div class="c-main"><div class="c-title">🔑 ${esc(x.label || x.name)}</div><div class="c-sub">$${esc(x.name)} · 加密${x.botId ? "" : " · 共用"} · ${esc(fmtTime(x.savedAt))}</div></div><button class="ghost-btn" data-secret-del="${esc(x.name)}">删除</button></div>`).join("")}</div>` : ""}`;
}
function bindWorkspace(panel, ws, b) {
  if (!ws) return;
  const open = panel.querySelector("#ws-open");
  if (open) open.onclick = () => ws.dir && api.system.openPath(ws.dir);
  panel.querySelectorAll(".ws-file").forEach((el) => (el.onclick = () => {
    const path = el.dataset.path;
    const name = path.split("/").pop();
    if (/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name)) openLightbox([{ type: "image", path, alt: name }], 0);
    else if (TEXT_EXT.test(name)) openInWorkbench(path, name);
    else api.system.openPath(path);
  }));
  panel.querySelectorAll(".ws-act").forEach((el) => (el.onclick = async () => { currentSession = el.dataset.sid; await loadSessionMessages(el.dataset.sid, true); }));
  panel.querySelectorAll("[data-secret-del]").forEach((btn) => (btn.onclick = async () => {
    if (!confirm(`删除密钥 ${btn.dataset.secretDel}？用到它的工具会失败`)) return;
    await api.secrets.remove(btn.dataset.secretDel);
    renderDetails(b);
  }));
}

/* ---- 技能编辑器（名称 / 描述 / 指令 / 可见范围 / 启用） ---- */
function skillEditor(skill, bot, onDone) {
  const isNew = !skill;
  const modal = openModal(`
    <div class="sk-head">
      <div class="sk-icon">🧩</div>
      <div class="sk-title"><b>${esc(skill?.name || "新技能")}</b><span class="hint">${skill ? (skill.owner ? `私有技能 · 仅 ${esc(botById(skill.owner)?.name || "所属 bot")} 可用` : "共享技能 · 所有 bot 可用") : `默认只给 ${esc(bot.name)} 用`}</span></div>
      ${isNew ? "" : `<button class="danger-btn" id="sk-del">删除技能</button>`}
    </div>
    <label class="sk-label">名称</label><input id="sk-name" value="${esc(skill?.name || "")}" placeholder="App Store 商店图规范" />
    <label class="sk-label">描述 <span class="hint">（bot 根据它决定什么时候用这个技能）</span></label>
    <textarea id="sk-desc" rows="2" placeholder="生成 App Store 商店截图时使用：先满足官方规格…">${esc(skill?.description || "")}</textarea>
    <label class="sk-label">指令</label>
    <textarea id="sk-body" class="sk-body" rows="16" placeholder="# 规范&#10;## 官方合规&#10;- 尺寸…">${esc(skill?.body || "")}</textarea>
    <div class="sk-row">
      <label class="sk-label" style="margin:0">可见范围</label>
      <select id="sk-owner" class="skin-select">
        <option value="${esc(skill?.owner || bot.id)}" ${!skill || skill.owner ? "selected" : ""}>仅 ${esc(botById(skill?.owner || bot.id)?.name || bot.name)}</option>
        <option value="" ${skill && !skill.owner ? "selected" : ""}>所有 bot</option>
      </select>
      <label class="switch" title="启用"><input type="checkbox" id="sk-on" ${skill?.enabled === false ? "" : "checked"}/><span></span></label>
    </div>
    <div class="actions"><button class="ghost-btn" id="sk-cancel">取消</button><button class="primary-btn" id="sk-save" disabled>保存</button></div>`);
  modal.classList.add("wide");
  const save = modal.querySelector("#sk-save");
  modal.querySelectorAll("input, textarea, select").forEach((x) => x.addEventListener("input", () => (save.disabled = false)));
  modal.querySelector("#sk-on").addEventListener("change", () => (save.disabled = false));
  modal.querySelector("#sk-cancel").onclick = closeModal;
  save.onclick = async () => {
    try {
      await api.skills.save({
        key: skill?.key,
        name: modal.querySelector("#sk-name").value,
        description: modal.querySelector("#sk-desc").value,
        body: modal.querySelector("#sk-body").value,
        owner: modal.querySelector("#sk-owner").value,
        enabled: modal.querySelector("#sk-on").checked,
      });
      closeModal();
      if (currentBot) renderDetails(currentBot);
      onDone?.();
    } catch (e) {
      alert(String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  };
  const del = modal.querySelector("#sk-del");
  if (del) del.onclick = async () => {
    if (!confirm(`删除技能「${skill.name}」？`)) return;
    await api.skills.remove(skill.key);
    closeModal();
    if (currentBot) renderDetails(currentBot);
    onDone?.();
  };
}

let groupTab = "members";
let groupArchived = false;
async function refreshGroup(gid) {
  await refreshBots();
  const g = groupList.find((x) => x.id === gid);
  if (g && currentGroup?.id === gid) {
    currentGroup = g;
    $("#chat-title").innerHTML = `<span class="t-avatar">👥</span>${esc(g.name)}`;
    renderGroupDetails(g);
  }
  return g;
}
async function renderGroupDetails(g) {
  const panel = $("#details");
  const members = g.members.map(botById).filter(Boolean);
  const st = g.settings ?? {};
  const master = bots.find((b) => b.isMaster && g.members.includes(b.id));
  const modId = st.moderator === undefined ? master?.id ?? "" : st.moderator;
  const [sessPage, library] = await Promise.all([
    groupTab === "sessions" ? api.sessions.page({ botId: g.id, limit: 100, archived: groupArchived }).catch(() => ({ sessions: [] })) : Promise.resolve({ sessions: [] }),
    groupTab === "library" ? api.system.library(null, g.id).catch(() => []) : Promise.resolve([]),
  ]);
  if (currentGroup?.id !== g.id) return;
  const others = bots.filter((b) => !g.members.includes(b.id));
  const tabBody = groupTab === "members" ? `
    <div class="d-sec"><h4>成员 · 发言顺序</h4>
      ${members.map((m, i) => `
        <div class="d-card gm-card" data-bot="${esc(m.id)}">
          <span class="bot-avatar" style="width:28px;height:28px;font-size:15px">${avatarHtml(m)}</span>
          <div class="c-main"><div class="c-title">${i + 1}. ${esc(m.name)}${m.id === modId ? ' <span class="tag">主持人</span>' : ""}</div><div class="c-sub">${esc(m.role || "通用助手")}</div></div>
          <span class="sess-ops">
            <button data-mv="-1" title="上移" ${i === 0 ? "disabled" : ""}>↑</button>
            <button data-mv="1" title="下移" ${i === members.length - 1 ? "disabled" : ""}>↓</button>
            <button data-rm title="移出群聊">✕</button>
          </span>
        </div>`).join("")}
      ${others.length ? `<div class="gm-add"><select id="gm-pick" class="skin-select">${others.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join("")}</select><button class="ghost-btn" id="gm-add">＋ 拉进群</button></div>` : ""}
    </div>
    <div class="d-sec d-actions">
      <button class="ghost-btn" id="g-export">导出对话</button>
      <button class="ghost-btn" id="g-clear">清空当前会话</button>
      <button class="danger-btn" id="g-del">解散群聊</button>
    </div>` : groupTab === "settings" ? `
    <div class="d-sec gs-form">
      <label class="sk-label">群目标 <span class="hint">（每次发言都会带上，让讨论不跑题）</span></label>
      <textarea id="gs-goal" rows="3" placeholder="例如：一周内定下 App 的首页改版方案">${esc(st.goal || "")}</textarea>
      <div class="d-card"><div class="c-main"><div class="c-title">自动接力</div><div class="c-sub">成员 @ 谁，谁就接着说；关掉后只回应你</div></div>
        <label class="switch"><input type="checkbox" id="gs-relay" ${st.relay === false ? "" : "checked"}/><span></span></label></div>
      <div class="d-card"><div class="c-main"><div class="c-title">最多发言次数</div><div class="c-sub">一次接力最多多少次发言，到了就停</div></div>
        <input id="gs-max" type="number" min="1" max="40" value="${st.maxTurns ?? 12}" class="gs-num" /></div>
      <label class="sk-label">主持人 <span class="hint">（每轮小结，结束时出结论卡片；插话没 @ 人时由他回应）</span></label>
      <select id="gs-mod" class="skin-select" style="width:100%">
        <option value="" ${modId ? "" : "selected"}>不设主持人</option>
        ${members.map((m) => `<option value="${esc(m.id)}" ${m.id === modId ? "selected" : ""}>${esc(m.name)}</option>`).join("")}
      </select>
      <div class="actions"><button class="primary-btn" id="gs-save" disabled>保存设置</button></div>
    </div>` : groupTab === "sessions" ? `
    <div class="d-sec">
      <div class="d-actions" style="margin-bottom:8px">
        <button class="ghost-btn" id="gss-new">＋ 新会话</button>
        <button class="ghost-btn" id="gss-arch">${groupArchived ? "← 返回会话" : "已归档"}</button>
      </div>
      ${sessPage.sessions.length ? sessPage.sessions.map((x) => `
        <div class="d-card sess-card ${x.id === currentSession ? "on" : ""}" data-sid="${esc(x.id)}">
          <div class="c-main"><div class="c-title">${sessionTitle(x, g.id)}</div>
            <div class="c-sub">${esc(fmtTime(x.updatedAt))} · ${x.messageCount ?? 0} 条</div></div>
          <span class="sess-ops">
            <button title="重命名" data-op="rename">✎</button>
            <button title="${groupArchived ? "取消归档" : "归档"}" data-op="archive">${groupArchived ? "↩" : "🗂"}</button>
            <button title="删除" data-op="delete">🗑</button>
          </span>
        </div>`).join("") : `<div class="d-empty">${groupArchived ? "没有归档的会话" : "还没有会话"}</div>`}
    </div>` : libraryHtml(library);
  panel.innerHTML = `
    <button class="icon-btn d-close" title="关闭">✕</button>
    <button class="icon-btn d-share" title="分享 bot：创建副本 / 模板链接">⇪</button>
    <div class="d-hero">
      <div class="d-avatar">👥</div>
      <div class="d-name gd-name" title="点击改群名">${esc(g.name)} <span class="gd-edit">✎</span></div>
      <div class="d-role">${members.length} 位成员${st.goal ? ` · ${esc(st.goal.slice(0, 24))}${st.goal.length > 24 ? "…" : ""}` : ""}</div>
    </div>
    <div class="d-tabs">
      <button data-tab="members" class="${groupTab === "members" ? "on" : ""}">成员</button>
      <button data-tab="settings" class="${groupTab === "settings" ? "on" : ""}">设置</button>
      <button data-tab="sessions" class="${groupTab === "sessions" ? "on" : ""}">会话</button>
      <button data-tab="library" class="${groupTab === "library" ? "on" : ""}">产出</button>
    </div>
    ${tabBody}`;
  panel.querySelector(".d-close").onclick = () => toggleDetails(false);
  panel.querySelector(".d-share").onclick = (e) => { e.stopPropagation(); shareBotMenu(e.currentTarget, b); };
  panel.querySelectorAll(".d-tabs button").forEach((btn) => (btn.onclick = () => { groupTab = btn.dataset.tab; renderGroupDetails(g); }));
  panel.querySelector(".gd-name").onclick = async () => {
    const name = await askInput("群名", "", g.name);
    if (name && name.trim() && name.trim() !== g.name) { await api.groups.update(g.id, { name: name.trim() }); refreshGroup(g.id); }
  };
  const setMembers = async (ids) => { await api.groups.update(g.id, { members: ids }); refreshGroup(g.id); };
  panel.querySelectorAll(".gm-card").forEach((card) => (card.onclick = async (e) => {
    const id = card.dataset.bot;
    const btn = e.target.closest("button");
    const ids = [...g.members];
    const i = ids.indexOf(id);
    if (btn?.dataset.mv) {
      const j = i + Number(btn.dataset.mv);
      [ids[i], ids[j]] = [ids[j], ids[i]];
      return setMembers(ids);
    }
    if (btn?.hasAttribute("data-rm")) {
      if (ids.length <= 1) return alert("群里至少要留一个成员");
      if (!confirm(`把 ${botById(id)?.name ?? id} 移出群聊？`)) return;
      return setMembers(ids.filter((x) => x !== id));
    }
    const b = botById(id);
    if (b) selectBot(b);
  }));
  const add = panel.querySelector("#gm-add");
  if (add) add.onclick = () => setMembers([...g.members, panel.querySelector("#gm-pick").value]);
  const exp = panel.querySelector("#g-export");
  if (exp) exp.onclick = () => exportSession(currentSession);
  const clr = panel.querySelector("#g-clear");
  if (clr) clr.onclick = async () => {
    if (!currentSession || !confirm("清空当前会话的全部记录？")) return;
    await api.sessions.remove(currentSession);
    clearMessages();
  };
  const del = panel.querySelector("#g-del");
  if (del) del.onclick = async () => {
    if (!confirm(`解散群聊「${g.name}」？（聊天记录保留）`)) return;
    await api.groups.remove(g.id);
    currentGroup = null;
    currentSession = null;
    clearMessages();
    $("#chat-bar").classList.add("hidden");
    $("#empty-state").style.display = "";
    toggleDetails(false);
    refreshBots();
  };
  const save = panel.querySelector("#gs-save");
  if (save) {
    panel.querySelectorAll(".gs-form input, .gs-form textarea, .gs-form select").forEach((x) => x.addEventListener("input", () => (save.disabled = false)));
    panel.querySelector("#gs-relay").addEventListener("change", () => (save.disabled = false));
    save.onclick = async () => {
      const maxTurns = Math.max(1, Math.min(40, Number(panel.querySelector("#gs-max").value) || 12));
      await api.groups.update(g.id, { settings: {
        goal: panel.querySelector("#gs-goal").value.trim() || undefined,
        relay: panel.querySelector("#gs-relay").checked,
        maxTurns,
        moderator: panel.querySelector("#gs-mod").value,
      } });
      save.textContent = "已保存";
      refreshGroup(g.id);
    };
  }
  const nw = panel.querySelector("#gss-new");
  if (nw) nw.onclick = () => { currentSession = `group-${g.id}-${Date.now()}`; clearMessages(); setSending(); renderRelayBar(); $("#input").focus(); renderGroupDetails(g); };
  const arch = panel.querySelector("#gss-arch");
  if (arch) arch.onclick = () => { groupArchived = !groupArchived; renderGroupDetails(g); };
  panel.querySelectorAll(".sess-card").forEach((card) => (card.onclick = async (e) => {
    const sid = card.dataset.sid;
    const op = e.target.closest("button")?.dataset.op;
    if (op === "rename") {
      const title = await askInput("会话名称", "", card.querySelector(".c-title").textContent);
      if (title) { await api.sessions.rename(sid, title); renderGroupDetails(g); }
      return;
    }
    if (op === "archive") {
      await api.sessions.archive(sid, !groupArchived);
      if (sid === currentSession) { currentSession = `group-${g.id}-${Date.now()}`; clearMessages(); }
      return renderGroupDetails(g);
    }
    if (op === "delete") {
      if (!confirm("删除这个会话及全部消息？")) return;
      await api.sessions.remove(sid);
      if (sid === currentSession) { currentSession = `group-${g.id}-${Date.now()}`; clearMessages(); }
      return renderGroupDetails(g);
    }
    currentSession = sid;
    await loadSessionMessages(sid, true);
    renderRelayBar();
    renderGroupDetails(g);
  }));
  if (groupTab === "library") bindLibrary(panel, library);
}

async function renderDetails(b) {
  const panel = $("#details");
  const [tasks, providers, mem, sessPage, botSkills, library, ws, grants, caps, cmd] = await Promise.all([
    api.tasks.list(b.id).catch(() => []),
    api.providers.list().catch(() => []),
    detailsTab === "memory" ? api.memory.list(b.id).catch(() => []) : Promise.resolve([]),
    detailsTab === "sessions" ? api.sessions.page({ botId: b.id, limit: 100, archived: showArchived }).catch(() => ({ sessions: [] })) : Promise.resolve({ sessions: [] }),
    detailsTab === "info" ? api.skills.forBot(b.id).catch(() => []) : Promise.resolve([]),
    detailsTab === "library" ? api.system.library(b.id).catch(() => []) : Promise.resolve([]),
    detailsTab === "computer" ? api.system.workspace(b.id).catch(() => null) : Promise.resolve(null),
    detailsTab === "info" ? api.consent.list(b.id).catch(() => []) : Promise.resolve([]),
    detailsTab === "info" ? api.consent.caps().catch(() => []) : Promise.resolve([]),
    detailsTab === "info" ? api.consent.rules().catch(() => ({ rules: [], trusted: [] })) : Promise.resolve({ rules: [], trusted: [] }),
  ]);
  const sessList = sessPage.sessions.filter((x) => !isB2b(x.id) || b2bAsker(x.id, b.id));
  const sessHtml = `
    <div class="d-actions" style="margin-bottom:8px">
      <button class="ghost-btn" id="d-newchat2">＋ 新会话</button>
      <button class="ghost-btn" id="d-archived">${showArchived ? "← 返回会话" : "已归档"}</button>
    </div>
    ${sessList.length ? sessList.map((x) => `
      <div class="d-card sess-card ${x.id === currentSession ? "on" : ""}" data-sid="${esc(x.id)}">
        <div class="c-main"><div class="c-title">${sessionTitle(x, b.id)}</div>
          <div class="c-sub">${esc(fmtTime(x.updatedAt))} · ${x.messageCount ?? 0} 条${x.summary ? " · 已压缩" : ""}</div></div>
        <span class="sess-ops">
          <button title="重命名" data-op="rename">✎</button>
          <button title="${showArchived ? "取消归档" : "归档"}" data-op="archive">${showArchived ? "↩" : "🗂"}</button>
          <button title="删除" data-op="delete">🗑</button>
        </span>
      </div>`).join("") : `<div class="d-empty">${showArchived ? "没有归档的会话" : "还没有会话"}</div>`}`;
  if (currentBot?.id !== b.id) return;
  const bound = providers.find((p) => p.id === b.providerId);
  const def = providers.find((p) => isDefaultProvider(p, providers));
  const provLabel = (p) => `${p.name}${p.model ? ` · ${p.model}` : ""}`;
  const provOptions = [
    `<option value="">跟随默认${def ? `（${esc(provLabel(def))}）` : "（离线人格）"}</option>`,
    ...providers.map((p) => `<option value="${esc(p.id)}" ${bound?.id === p.id ? "selected" : ""}>${esc(provLabel(p))}</option>`),
  ].join("");
  const routines = tasks.length ? tasks.map((t) => `
    <div class="d-card">
      <div class="c-main"><div class="c-title">${esc(t.name)}</div><div class="c-sub">${esc(t.cron)}${t.nextRunAt ? ` · 下次 ${esc(fmtTime(t.nextRunAt))}` : ""}</div></div>
      <label class="switch"><input type="checkbox" data-task="${esc(t.id)}" ${t.enabled ? "checked" : ""}/><span></span></label>
    </div>`).join("") : `<div class="d-empty">还没有定时任务，可以对它说「每天早上 9 点提醒我…」</div>`;
  const memHtml = mem.length ? mem.slice(-30).reverse().map((m) => `
    <div class="d-card"><div class="c-main"><div class="c-title" title="${esc(m.content)}">${esc(m.content)}</div><div class="c-sub">${esc(MEMORY_KIND[m.kind] || m.kind)}${m.createdAt ? ` · ${esc(fmtTime(m.createdAt))}` : ""}</div></div></div>`).join("") : `<div class="d-empty">暂无记忆</div>`;
  panel.innerHTML = `
    <button class="icon-btn d-close" title="关闭">✕</button>
    <button class="icon-btn d-share" title="分享 bot：创建副本 / 模板链接">⇪</button>
    <div class="d-hero">
      <div class="d-avatar${isBusy(b.id) ? " busy" : ""}" data-av-bot="${esc(b.id)}" title="换头像">${avatarHtml(b)}</div>
      <div class="d-name gd-name" title="点击改名">${esc(b.name)} <span class="gd-edit">✎</span></div>
      <div class="d-role gd-name" title="点击改角色">${esc(b.role || "通用助手")} <span class="gd-edit">✎</span></div>
      <div class="d-actions d-hero-actions">
        <button class="ghost-btn" id="d-persona">生成形象</button>
        <button class="ghost-btn" id="d-avatar-pick" title="换形状头像">换头像</button>
      </div>
    </div>
    <div class="d-tabs">
      <button data-tab="info" class="${detailsTab === "info" ? "on" : ""}">详情</button>
      <button data-tab="sessions" class="${detailsTab === "sessions" ? "on" : ""}">会话</button>
      <button data-tab="library" class="${detailsTab === "library" ? "on" : ""}">产出</button>
      <button data-tab="computer" class="${detailsTab === "computer" ? "on" : ""}">工作区</button>
      <button data-tab="memory" class="${detailsTab === "memory" ? "on" : ""}">记忆</button>
    </div>
    ${detailsTab === "info" ? `
    <div class="d-sec"><h4>定时任务</h4>${notifyBlocked ? NOTIFY_HINT() : ""}${routines}</div>
    <div class="d-sec"><h4>桌面宠物</h4>
      <div class="d-card"><div class="c-main"><div class="c-title">在桌面显示</div><div class="c-sub">${b.petEnabled ? "已开启" : "已关闭"}</div></div>
      <label class="switch"><input type="checkbox" id="d-pet" ${b.petEnabled ? "checked" : ""}/><span></span></label></div>
    </div>
    <div class="d-sec"><h4>配置</h4>
      <div class="d-kv">
        <span>模型</span><span><select id="d-provider" class="skin-select" style="width:100%">${provOptions}</select></span>
        <span title="复杂任务先用推理模型想清楚思路，执行完再自检一遍">深度思考</span><span><select id="d-reasoning" class="skin-select" style="width:100%">${[["auto", "复杂任务自动"], ["always", "每次都用"], ["off", "关闭"]].map(([v, l]) => `<option value="${v}" ${(b.reasoning ?? (b.isMaster ? "auto" : "off")) === v ? "selected" : ""}>${l}</option>`).join("")}</select></span>
        <span>人设</span><span>${esc(b.persona || "—")}</span>
      </div>
    </div>
    <div class="d-sec"><h4>技能 <button class="list-add" id="d-skill-add" title="新建技能">＋</button></h4>
      ${botSkills.length ? botSkills.map((k) => `
        <div class="d-card skill-card" data-skill="${esc(k.key)}">
          <div class="c-main"><div class="c-title">${esc(k.name)} <span class="tag">${k.owner ? "私有" : "共享"}</span></div><div class="c-sub" title="${esc(k.description)}">${esc(k.description)}</div></div>
          <label class="switch" title="启用"><input type="checkbox" data-skill-on="${esc(k.key)}" ${k.enabled ? "checked" : ""}/><span></span></label>
        </div>`).join("") : `<div class="d-empty">还没有技能。可以对它说「把这套规范记成技能」</div>`}
    </div>
    ${botPermSection(b.id, grants, caps, !!cmd.trusted?.includes(b.id))}
    <div class="d-sec d-actions">
      <button class="ghost-btn" id="d-more">更多设置</button>
      <button class="ghost-btn" id="d-newchat">新会话</button>
      <button class="ghost-btn" id="d-export">导出对话</button>
    </div>` : detailsTab === "sessions" ? `<div class="d-sec">${sessHtml}</div>`
      : detailsTab === "library" ? libraryHtml(library)
      : detailsTab === "computer" ? workspaceHtml(ws, b)
      : `<div class="d-sec"><h4>最近记忆</h4>${memHtml}</div>`}`;
  panel.querySelector(".d-close").onclick = () => toggleDetails(false);
  panel.querySelector(".d-share").onclick = (e) => { e.stopPropagation(); shareBotMenu(e.currentTarget, b); };
  const nameEl = panel.querySelector(".d-name");
  if (nameEl) nameEl.onclick = async () => {
    const name = await askInput("Bot 名称", "", b.name);
    if (!name || name.trim() === b.name) return;
    try {
      await api.bots.update(b.id, { name: name.trim() });
      await refreshBots();
      if (currentBot) renderDetails(currentBot);
    } catch (err) { alert(err?.message || String(err)); }
  };
  const roleEl = panel.querySelector(".d-role");
  if (roleEl) roleEl.onclick = async () => {
    const role = await askInput("角色", "如：通用助手 / 飞书机器人", b.role || "通用助手");
    if (role == null || role.trim() === (b.role || "")) return;
    await api.bots.update(b.id, { role: role.trim() });
    await refreshBots();
    if (currentBot) renderDetails(currentBot);
  };
  const openAvatar = () => changeAvatarFlow(b);
  panel.querySelector(".d-avatar").onclick = openAvatar;
  const pickAv = panel.querySelector("#d-avatar-pick");
  if (pickAv) pickAv.onclick = openAvatar;
  panel.querySelectorAll(".d-tabs button").forEach((btn) => (btn.onclick = () => { detailsTab = btn.dataset.tab; renderDetails(b); }));
  panel.querySelectorAll("input[data-task]").forEach((inp) => (inp.onchange = () => api.tasks.setEnabled(inp.dataset.task, inp.checked)));
  const pet = panel.querySelector("#d-pet");
  if (pet) pet.onchange = async () => { await api.bots.setPet(b.id, pet.checked); await refreshBots(); if (currentBot) renderDetails(currentBot); };
  const provSel = panel.querySelector("#d-provider");
  if (provSel) provSel.onchange = async () => { await api.bots.update(b.id, { providerId: provSel.value }); await refreshBots(); };
  const reasonSel = panel.querySelector("#d-reasoning");
  if (reasonSel) reasonSel.onchange = async () => { await api.bots.update(b.id, { reasoning: reasonSel.value }); await refreshBots(); };
  const more = panel.querySelector("#d-more");
  if (more) more.onclick = () => botDetailFlow(b);
  const persona = panel.querySelector("#d-persona");
  if (persona) persona.onclick = () => personaFlow();
  const newChat = () => { currentSession = null; clearMessages(); setSending(); $("#input").focus(); if (detailsTab === "sessions") renderDetails(b); };
  const nc = panel.querySelector("#d-newchat");
  if (nc) nc.onclick = newChat;
  const nc2 = panel.querySelector("#d-newchat2");
  if (nc2) nc2.onclick = newChat;
  const exp = panel.querySelector("#d-export");
  if (exp) exp.onclick = () => exportSession(currentSession);
  const addSkill = panel.querySelector("#d-skill-add");
  if (addSkill) addSkill.onclick = () => skillEditor(null, b);
  panel.querySelectorAll(".skill-card").forEach((card) => (card.onclick = (e) => {
    if (e.target.closest(".switch")) return;
    const k = botSkills.find((x) => x.key === card.dataset.skill);
    if (k) skillEditor(k, b);
  }));
  panel.querySelectorAll("input[data-skill-on]").forEach((inp) => (inp.onchange = () => api.skills.setEnabled(inp.dataset.skillOn, inp.checked)));
  if (detailsTab === "info") bindBotPerm(panel, b.id, () => { if (currentBot?.id === b.id) renderDetails(currentBot); });
  if (detailsTab === "library") bindLibrary(panel, library);
  if (detailsTab === "computer") bindWorkspace(panel, ws, b);
  const arch = panel.querySelector("#d-archived");
  if (arch) arch.onclick = () => { showArchived = !showArchived; renderDetails(b); };
  panel.querySelectorAll(".sess-card").forEach((card) => {
    const sid = card.dataset.sid;
    card.onclick = async (e) => {
      const op = e.target.closest("button")?.dataset.op;
      if (op === "rename") {
        const title = await askInput("会话名称", "", card.querySelector(".c-title").textContent);
        if (title) { await api.sessions.rename(sid, title); renderDetails(b); }
        return;
      }
      if (op === "archive") {
        await api.sessions.archive(sid, !showArchived);
        if (sid === currentSession) { currentSession = null; clearMessages(); }
        return renderDetails(b);
      }
      if (op === "delete") {
        if (!confirm("删除这个会话及全部消息？")) return;
        await api.sessions.remove(sid);
        if (sid === currentSession) { currentSession = null; clearMessages(); }
        refreshBots();
        return renderDetails(b);
      }
      currentSession = sid;
      await loadSessionMessages(sid, true);
      renderDetails(b);
    };
  });
}
