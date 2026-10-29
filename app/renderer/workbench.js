// 工作台、分享、项目与自定义指令、追问建议、软件内引用、分享 bot
/* ======== 工作台：侧边预览 / 编辑 bot 写的文档和网页 ======== */
const wb = { files: [], active: null };
const WB_PREVIEW = /\.(md|markdown|html?)$/i;
const wbFile = (path) => wb.files.find((f) => f.path === path);

document.addEventListener("click", (e) => {
  const a = e.target.closest?.("[data-artifact]");
  if (a) openInWorkbench(a.dataset.artifact);
});

async function openInWorkbench(path, name) {
  let f = wbFile(path);
  if (!f) {
    const r = await api.system.preview(path);
    if (!r?.ok) return api.system.openPath(path);
    f = { path, name: name || path.split("/").pop(), text: r.text, saved: r.text, truncated: r.truncated, mode: WB_PREVIEW.test(path) ? "preview" : "code", stale: false };
    wb.files.push(f);
    api.files.watch(path, true);
  }
  wb.active = path;
  showWorkbench(true);
}

function showWorkbench(on) {
  const pane = $("#workbench");
  pane.classList.toggle("hidden", !on);
  document.body.classList.toggle("wb-open", on);
  $("#wb-toggle").classList.toggle("on", on);
  if (on) {
    $("#details").classList.add("hidden");
    renderWorkbench();
  } else if (detailsPinned && window.innerWidth >= 1100) toggleDetails(true);
}

function closeWbFile(path) {
  const f = wbFile(path);
  if (f && f.text !== f.saved && !confirm(`「${f.name}」还没保存，确定关闭？`)) return;
  wb.files = wb.files.filter((x) => x.path !== path);
  api.files.watch(path, false);
  if (wb.active === path) wb.active = wb.files.at(-1)?.path ?? null;
  renderWorkbench();
}

async function saveWbFile(f) {
  try {
    await api.files.save(f.path, f.text);
    f.saved = f.text;
    f.stale = false;
    renderWorkbench();
  } catch (e) {
    alert(errText(e));
  }
}

async function renderWorkbench() {
  const pane = $("#workbench");
  if (pane.classList.contains("hidden")) return;
  const f = wbFile(wb.active);
  const tabs = wb.files.map((x) => `<div class="wb-tab ${x.path === wb.active ? "on" : ""}" data-path="${esc(x.path)}" title="${esc(x.path)}"><span>${fileIcon(x.name)} ${esc(x.name)}${x.text !== x.saved ? " ●" : ""}</span><button data-close="${esc(x.path)}">✕</button></div>`).join("");
  if (!f) {
    const ws = currentBot ? await api.system.workspace(currentBot.id).catch(() => null) : null;
    const recent = (ws?.files ?? []).filter((x) => !x.dir && TEXT_EXT.test(x.rel)).slice(0, 14);
    pane.innerHTML = `<div class="wb-head"><div class="wb-tabs">${tabs}</div><button class="icon-btn" data-wb="close" title="关闭工作台">✕</button></div>
      <div class="wb-empty"><div class="wb-empty-ico">▤</div><b>工作台</b><p>bot 写的文档、网页、代码会在这里打开，可以边看边改，改完保存或让 bot 接着改。</p>
      ${recent.length ? `<div class="wb-recent"><h4>${esc(currentBot.name)} 最近写的文件</h4>${recent.map((x) => `<button data-open="${esc(x.path)}">${fileIcon(x.rel)} <span>${esc(x.rel)}</span><em>${esc(fmtTime(x.mtime))}</em></button>`).join("")}</div>` : `<p class="hint">让 bot 写一份文档或网页（比如「写一个落地页 HTML」），点对话里的文件卡片就会在这里打开。</p>`}</div>`;
    pane.querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => openInWorkbench(b.dataset.open)));
    bindWbHead(pane);
    return;
  }
  const isHtml = /\.html?$/i.test(f.path), isMd = /\.(md|markdown)$/i.test(f.path);
  const dirty = f.text !== f.saved;
  pane.innerHTML = `
    <div class="wb-head"><div class="wb-tabs">${tabs}</div><button class="icon-btn" data-wb="close" title="关闭工作台">✕</button></div>
    <div class="wb-bar">
      <div class="mx-seg">${isHtml || isMd ? `<button data-mode="preview" class="${f.mode === "preview" ? "on" : ""}">预览</button>` : `<button data-mode="code" class="${f.mode === "code" ? "on" : ""}">查看</button>`}<button data-mode="edit" class="${f.mode === "edit" ? "on" : ""}">编辑</button></div>
      <span class="wb-status">${f.truncated ? "文件较大，只载入了前 256KB，不能保存" : dirty ? "未保存" : ""}</span>
      <span class="wb-ops">
        <button class="ghost-btn" data-wb="ask" title="把文件交给 bot 修改；编辑模式下选中一段只改那一段">✨ 让 bot 改</button>
        ${isHtml ? `<button class="ghost-btn" data-wb="browser">浏览器打开</button>` : ""}
        <button class="ghost-btn" data-wb="reveal">Finder</button>
        <button class="primary-btn" data-wb="save" ${dirty && !f.truncated ? "" : "disabled"}>保存</button>
      </span>
    </div>
    ${f.stale ? `<div class="wb-stale">bot 刚改了这个文件，你这边有未保存的修改。<button class="ghost-btn" data-wb="reload">载入新版本（丢弃我的修改）</button></div>` : ""}
    <div class="wb-body"></div>`;
  const body = pane.querySelector(".wb-body");
  if (f.mode === "edit") {
    body.innerHTML = `<textarea class="wb-edit" spellcheck="false"></textarea>`;
    const ta = body.querySelector("textarea");
    ta.value = f.text;
    ta.oninput = () => {
      const was = f.text !== f.saved;
      f.text = ta.value;
      if (was !== (f.text !== f.saved)) {
        pane.querySelector(".wb-status").textContent = f.text !== f.saved ? "未保存" : "";
        pane.querySelector("[data-wb=save]").disabled = f.text === f.saved || f.truncated;
        pane.querySelector(`.wb-tab[data-path="${CSS.escape(f.path)}"] span`).textContent = `${fileIcon(f.name)} ${f.name}${f.text !== f.saved ? " ●" : ""}`;
      }
    };
    ta.onkeydown = (e) => {
      if (e.key === "Tab") { e.preventDefault(); ta.setRangeText("  ", ta.selectionStart, ta.selectionEnd, "end"); ta.oninput(); }
      if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); if (f.text !== f.saved && !f.truncated) saveWbFile(f); }
    };
  } else if (f.mode === "preview" && isHtml) {
    body.innerHTML = `<iframe class="wb-frame" sandbox="allow-scripts allow-popups allow-forms" src="${esc(fileUrl(f.path))}?t=${Date.now()}"></iframe>`;
  } else if (f.mode === "preview" && isMd) {
    body.innerHTML = `<div class="wb-md pv-md">${renderMarkdown(esc(f.text))}</div>`;
    decorateCode(body);
  } else {
    body.innerHTML = `<pre class="code-block wb-code"><code>${esc(f.text)}</code></pre>`;
    decorateCode(body);
  }
  pane.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => { f.mode = b.dataset.mode; renderWorkbench(); }));
  pane.querySelector("[data-wb=save]").onclick = () => saveWbFile(f);
  pane.querySelector("[data-wb=reveal]").onclick = () => api.system.reveal(f.path);
  const br = pane.querySelector("[data-wb=browser]");
  if (br) br.onclick = () => api.system.openPath(f.path);
  const rl = pane.querySelector("[data-wb=reload]");
  if (rl) rl.onclick = async () => { const r = await api.system.preview(f.path); if (r?.ok) Object.assign(f, { text: r.text, saved: r.text, stale: false }); renderWorkbench(); };
  pane.querySelector("[data-wb=ask]").onclick = () => {
    const ta = pane.querySelector(".wb-edit");
    const sel = ta && ta.selectionEnd > ta.selectionStart ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : "";
    $("#input").value = sel
      ? `修改工作台里的「${f.name}」（${f.path}）中的这一段：\n"""\n${sel.slice(0, 1500)}\n"""\n改成：`
      : `修改工作台里的「${f.name}」（${f.path}），直接改文件：`;
    $("#input").focus();
    $("#input").dispatchEvent(new Event("input"));
  };
  bindWbHead(pane);
}

function bindWbHead(pane) {
  pane.querySelector("[data-wb=close]").onclick = () => showWorkbench(false);
  pane.querySelectorAll(".wb-tab").forEach((t) => (t.onclick = (e) => {
    if (e.target.closest("[data-close]")) return closeWbFile(t.dataset.path);
    wb.active = t.dataset.path;
    renderWorkbench();
  }));
}

api.onFileChanged(async (path) => {
  const f = wbFile(path);
  if (!f) return;
  const r = await api.system.preview(path);
  if (!r?.ok || r.text === f.saved) return;
  if (f.text === f.saved) Object.assign(f, { text: r.text, saved: r.text, stale: false });
  else f.stale = true;
  if (wb.active === path) renderWorkbench();
});
$("#wb-toggle").onclick = () => showWorkbench($("#workbench").classList.contains("hidden"));

/* ======== 分享：长图 / 网页 ======== */
async function shareFlow(m) {
  const sid = m?.sessionId ?? currentSession;
  if (!sid || !(await api.sessions.get(sid).catch(() => null))) return alert("当前没有可以分享的对话");
  const msgs = (await api.messages.list(sid)).filter((x) => x.kind !== "event");
  let pairIds = [];
  const at = m ? msgs.findIndex((x) => x.id === m.id) : msgs.length - 1;
  if (at >= 0) {
    const userIdx = msgs[at].role === "user" ? at : msgs.slice(0, at + 1).findLastIndex((x) => x.role === "user");
    const end = msgs.findIndex((x, i) => i > Math.max(userIdx, at) && x.role === "user");
    pairIds = msgs.slice(Math.max(0, userIdx), end < 0 ? msgs.length : end).map((x) => x.id);
  }
  let scope = m ? "pair" : "all";
  const modal = sheet({ icon: "⇪", title: "分享对话", sub: "图片和来源会一起带上；授权记录等不会出现在分享里" });
  const body = modal.querySelector(".mx-body");
  const render = (result) => {
    body.innerHTML = `
      <div class="mx-seg sh-scope"><button data-s="pair" class="${scope === "pair" ? "on" : ""}">${m ? "这一段问答" : "最近一段问答"}（${pairIds.length} 条）</button><button data-s="all" class="${scope === "all" ? "on" : ""}">整个对话（${msgs.length} 条）</button></div>
      <div class="sh-opts">
        <button class="sh-opt" data-f="png"><span>🖼</span><b>生成长图</b><em>保存到「下载」并复制到剪贴板，直接粘贴到微信 / 飞书</em></button>
        <button class="sh-opt" data-f="html"><span>🌐</span><b>导出网页</b><em>单个 HTML 文件，图片内嵌，发给别人用浏览器打开</em></button>
      </div>
      <div class="sh-result">${result ?? ""}</div>`;
    body.querySelectorAll("[data-s]").forEach((b) => (b.onclick = () => { scope = b.dataset.s; render(); }));
    body.querySelectorAll("[data-f]").forEach((b) => (b.onclick = async () => {
      const format = b.dataset.f;
      body.querySelectorAll("button").forEach((x) => (x.disabled = true));
      body.querySelector(".sh-result").innerHTML = `<div class="d-empty">${format === "png" ? "正在生成长图…" : "正在导出…"}</div>`;
      try {
        const r = await api.share.export(sid, format, scope === "pair" ? pairIds : undefined);
        const name = r.path.split("/").pop();
        render(format === "png"
          ? `<div class="sh-done">✓ 已复制到剪贴板，并保存为「下载/${esc(name)}」${r.dropped ? `<br/><span class="hint">对话太长，长图从第 ${r.dropped + 1} 条开始；完整内容请用「导出网页」</span>` : ""}</div>
             <div class="sh-preview"><img src="${esc(fileUrl(r.path))}" /></div>
             <div class="actions"><button class="ghost-btn" data-o="reveal">在 Finder 中显示</button><button class="primary-btn" data-o="open">打开图片</button></div>`
          : `<div class="sh-done">✓ 已保存为「下载/${esc(name)}」</div>
             <div class="actions"><button class="ghost-btn" data-o="reveal">在 Finder 中显示</button><button class="primary-btn" data-o="open">用浏览器打开</button></div>`);
        body.querySelector("[data-o=reveal]").onclick = () => api.system.reveal(r.path);
        body.querySelector("[data-o=open]").onclick = () => api.system.openPath(r.path);
      } catch (e) {
        render(`<div class="sh-done bad">✕ ${esc(errText(e))}</div>`);
      }
    }));
  };
  render();
}
$("#share-btn").onclick = () => shareFlow(null);

/* ======== 项目与自定义指令 ======== */
async function projectsFlow(opts = {}) {
  const modal = sheet({ icon: "📁", title: "项目与自定义指令", sub: "全局指令对所有 bot 生效；项目里的指令和资料只对选了这个项目的对话生效", wide: true });
  const body = modal.querySelector(".mx-body");
  let editing = opts.create ? "new" : null;
  const render = async () => {
    const [ins, prefs, list] = await Promise.all([api.config.get("instructions"), api.config.get("prefs"), api.projects.list()]);
    projectList = list;
    const p = editing && editing !== "new" ? list.find((x) => x.id === editing) : null;
    body.innerHTML = `
      <div class="d-sec mx-form"><h4>全局自定义指令</h4>
        <label class="pj-label">关于你：希望 bot 知道的背景（职业、所在城市、在做的事…）</label>
        <textarea id="gi-about" rows="3" placeholder="例如：我是独立 iOS 开发者，在杭州，主要用 Swift 和 Flutter。">${esc(ins?.about ?? "")}</textarea>
        <label class="pj-label">回复方式：语气、长度、格式偏好</label>
        <textarea id="gi-style" rows="3" placeholder="例如：先给结论再解释；代码给完整可运行版本；不要客套话。">${esc(ins?.style ?? "")}</textarea>
        <div class="pj-row"><label class="pj-check"><input type="checkbox" id="pf-sugg" ${prefs?.suggestions === false ? "" : "checked"} /> 回复后给出追问建议</label>
          <span class="gi-saved hint"></span><button class="primary-btn" id="gi-save">保存</button></div>
      </div>
      <div class="d-sec"><h4>项目 <button class="list-add" id="pj-new" title="新建项目">＋</button></h4>
        ${list.map((x) => `
          <div class="d-card pj-card ${x.id === editing ? "on" : ""}" data-id="${esc(x.id)}">
            <span class="pj-ico">📁</span>
            <div class="c-main"><div class="c-title">${esc(x.name)}${x.id === sessionProject ? ` <span class="tag on">当前对话</span>` : ""}</div>
              <div class="c-sub">${x.instructions ? esc(x.instructions.slice(0, 60)) : "没有指令"} · ${x.files.length} 份资料</div></div>
            <button class="ghost-btn" data-op="use">${x.id === sessionProject ? "取消使用" : "用于当前对话"}</button>
            <button class="ghost-btn" data-op="edit">编辑</button>
          </div>`).join("") || (editing === "new" ? "" : `<div class="d-empty">还没有项目。项目把一组对话需要的背景说明和资料放在一起，比如「App 上架」项目放审核规范和产品文档。</div>`)}
      </div>
      ${editing ? `
      <div class="d-sec mx-form" id="pj-form">
        <h4>${p ? `编辑「${esc(p.name)}」` : "新建项目"}</h4>
        <div class="mx-grid"><label>名称</label><input id="pj-name" value="${esc(p?.name ?? "")}" placeholder="例如 App 上架" /></div>
        <label class="pj-label">项目指令：这个项目里 bot 需要遵守的规则和背景</label>
        <textarea id="pj-ins" rows="5" placeholder="例如：所有文案面向美国用户，用英文；遵守 App Store 审核指南 4.3。">${esc(p?.instructions ?? "")}</textarea>
        ${p ? `<label class="pj-label">资料（PDF / Word / 表格 / 文本，bot 会读里面的文字）</label>
        <div class="pj-files">${p.files.map((f) => `<div class="att"><span class="att-ico">${fileIcon(f.name)}</span><span class="att-main"><span class="att-name">${esc(f.name)}</span><span class="att-sub">${f.chars ? `${f.chars.toLocaleString()} 字` : "读不出文字"}</span></span><button data-rmfile="${esc(f.path)}" title="移除">✕</button></div>`).join("")}
          <button class="ghost-btn" id="pj-addfile">＋ 添加资料</button></div>` : `<div class="hint">保存后可以添加资料文件</div>`}
        <div class="actions">${p ? `<button class="ghost-btn danger-text" id="pj-del">删除项目</button>` : ""}<button class="ghost-btn" id="pj-cancel">取消</button><button class="primary-btn" id="pj-save">${p ? "保存" : "创建"}</button></div>
      </div>` : ""}`;
    body.querySelector("#gi-save").onclick = async () => {
      await api.config.set("instructions", { about: body.querySelector("#gi-about").value.trim(), style: body.querySelector("#gi-style").value.trim() });
      // 只写 suggestions，避免把打开面板时的旧 pet prefs 盖回去
      await api.config.set("prefs", { suggestions: body.querySelector("#pf-sugg").checked });
      body.querySelector(".gi-saved").textContent = "✓ 已保存，下一条消息起生效";
    };
    body.querySelector("#pj-new").onclick = () => { editing = "new"; render(); };
    body.querySelectorAll(".pj-card").forEach((card) => (card.onclick = async (e) => {
      const op = e.target.closest("button")?.dataset.op;
      const id = card.dataset.id;
      if (op === "edit") { editing = id; return render(); }
      if (op === "use") {
        sessionProject = sessionProject === id ? null : id;
        if (currentSession && (await api.sessions.get(currentSession).catch(() => null))) await api.projects.setForSession(currentSession, sessionProject);
        renderComposerTools();
        return render();
      }
    }));
    if (!editing) return;
    body.querySelector("#pj-form").scrollIntoView({ block: "nearest" });
    body.querySelector("#pj-cancel").onclick = () => { editing = null; render(); };
    body.querySelector("#pj-save").onclick = async () => {
      const name = body.querySelector("#pj-name").value.trim();
      if (!name) return alert("给项目起个名字");
      const instructions = body.querySelector("#pj-ins").value;
      if (p) await api.projects.update(p.id, { name, instructions });
      else {
        const np = await api.projects.create(name, instructions);
        editing = np.id;
        if (opts.create && currentBot) { sessionProject = np.id; if (currentSession && (await api.sessions.get(currentSession).catch(() => null))) await api.projects.setForSession(currentSession, np.id); }
      }
      renderComposerTools();
      render();
    };
    const del = body.querySelector("#pj-del");
    if (del) del.onclick = async () => {
      if (!confirm(`删除项目「${p.name}」？它的资料文件会一起删除，对话保留。`)) return;
      await api.projects.remove(p.id);
      if (sessionProject === p.id) sessionProject = null;
      editing = null;
      renderComposerTools();
      render();
    };
    const add = body.querySelector("#pj-addfile");
    if (add) add.onclick = async () => { add.textContent = "读取中…"; await api.projects.addFiles(p.id).catch((e) => alert(errText(e))); render(); };
    body.querySelectorAll("[data-rmfile]").forEach((b) => (b.onclick = async () => { await api.projects.removeFile(p.id, b.dataset.rmfile); render(); }));
  };
  render();
}
$("#projects-btn").onclick = () => projectsFlow();

/* ======== 追问建议到达 ======== */
api.onSuggestions(({ sessionId, msgId, suggestions }) => {
  if (sessionId !== currentSession || pending.has(sessionId) || voiceMode) return;
  const el = document.querySelector(`#messages [data-id="${msgId}"]`);
  const lastMsg = [...document.querySelectorAll("#messages > [data-id]")].filter((x) => x.dataset.id).at(-1);
  if (el && el === lastMsg) showSuggestions(el, suggestions);
});

/* ======== 软件内引用：bot 回复里的 [文字](app:类型/标识) 点开对应的东西 ======== */
const SETTINGS_PAGES = {
  models: () => settingsFlow(),
  image: async () => { await settingsFlow(); setTimeout(() => $("#ig-sec")?.scrollIntoView({ block: "center", behavior: "smooth" }), 400); },
  usage: async () => { await settingsFlow(); setTimeout(() => $("#us-sec")?.scrollIntoView({ block: "center", behavior: "smooth" }), 400); },
  recall: async () => { await settingsFlow(); setTimeout(() => $("#em-sec")?.scrollIntoView({ block: "center", behavior: "smooth" }), 400); },
  voice: () => voiceConfigFlow(),
  env: () => envFlow(),
  secrets: () => envFlow(),
  skills: () => skillsFlow(),
  tasks: () => tasksFlow(),
  memory: () => memoryFlow(),
  mcp: () => mcpFlow(),
  plans: () => plansFlow(),
  access: () => sysaccessFlow(),
  pet: () => petSmartFlow(),
  about: () => aboutFlow(),
  notifications: () => api.system.openPrefs("notifications"),
  instructions: () => projectsFlow(),
  projects: () => projectsFlow(),
};
const decodeRef = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

async function openRef(type, rawId) {
  const id = decodeRef(rawId).trim();
  const missing = (what) => sheet({ icon: "🔍", title: `找不到${what}`, body: `<p class="hint">「${esc(id)}」可能已被删除或改了名字。</p>` });
  if (type === "bot") {
    const b = bots.find((x) => x.id === id || x.name === id) ?? bots.find((x) => x.name.includes(id) || id.includes(x.name));
    return b ? botPopup(b) : missing(" bot");
  }
  if (type === "skill") {
    const list = await api.skills.list();
    const k = list.find((x) => x.key === id) ?? list.find((x) => x.name === id)
      ?? list.find((x) => x.name.includes(id) || id.includes(x.name));
    if (k) return skillPreview(k);
    const modal = sheet({ icon: "🔍", title: "找不到技能", body: `<p class="hint">「${esc(id)}」可能还没真正创建（对话里说建好了但没调用 skill.save），或已被删除/改名。</p><div class="actions"><button class="primary-btn" id="sk-miss">打开技能管理</button></div>` });
    modal.querySelector("#sk-miss").onclick = () => { closeModal(); skillsFlow(); };
    return;
  }
  if (type === "group") {
    const g = groupList.find((x) => x.id === id || x.name === id);
    return g ? selectGroup(g) : missing("群聊");
  }
  if (type === "file") return openInWorkbench(id.startsWith("/") ? id : `/${id}`);
  if (type === "project") return projectsFlow();
  if (type === "task") return tasksFlow();
  if (type === "memory") {
    const [who, kind] = id.split("/");
    const b = bots.find((x) => x.id === who || x.name === who);
    const ns = b ? `bot:${b.id}` : /^(global|全局|共享)$/i.test(who) ? "global" : undefined;
    return memoryFlow({ ns, kind: ["rule", "fact", "event"].includes(kind) ? kind : /规范|规则/.test(kind ?? "") ? "rule" : undefined });
  }
  if (type === "settings") return (SETTINGS_PAGES[id] ?? SETTINGS_PAGES.models)();
}

document.addEventListener("click", (e) => {
  const r = e.target.closest?.("a.ref[data-ref]");
  if (!r) return;
  e.preventDefault();
  e.stopPropagation();
  openRef(r.dataset.ref, r.dataset.id ?? "");
}, true);

function botPopup(b) {
  const card = b.personaCard;
  const modal = sheet({ icon: "🤖", title: "bot 资料" });
  modal.querySelector(".mx-body").innerHTML = `
    <div class="bp-hero"><div class="bp-avatar">${avatarHtml(b)}</div>
      <div class="bp-main"><b>${esc(b.name)}</b>${b.isMaster ? `<span class="tag">主控</span>` : ""}<span class="hint">${esc(b.role || "通用助手")}</span></div></div>
    ${b.persona ? `<div class="bp-sec"><h4>人设</h4><p>${esc(b.persona)}</p></div>` : ""}
    ${card?.traits?.length ? `<div class="bp-sec"><h4>性格</h4><p>${card.traits.map((t) => `<span class="tag">${esc(t)}</span>`).join(" ")}</p></div>` : ""}
    <div class="actions">
      ${b.id === currentBot?.id && !currentGroup ? "" : `<button class="primary-btn" id="bp-chat">和 ${esc(b.name)} 聊天</button>`}
      <button class="ghost-btn" id="bp-share">分享</button>
    </div>`;
  modal.querySelector("#bp-chat")?.addEventListener("click", () => { closeModal(); selectBot(b); });
  modal.querySelector("#bp-share").onclick = () => shareBotFlow(b);
}

async function skillPreview(k) {
  const owner = k.owner ? botById(k.owner) : null;
  const modal = sheet({ icon: "🧩", title: k.name, sub: owner ? `${owner.name} 的私有技能` : "共享技能 · 所有 bot 可用", wide: true });
  modal.querySelector(".mx-body").innerHTML = `
    <p class="sp-desc">${esc(k.description)}</p>
    <div class="sp-body md">${renderMarkdown(esc(k.body || "（没有指令正文）"))}</div>
    <div class="actions">
      <label class="sp-on"><span>启用</span><label class="switch"><input type="checkbox" id="sp-on" ${k.enabled === false ? "" : "checked"}/><span></span></label></label>
      <button class="ghost-btn" id="sp-edit">编辑</button>
    </div>`;
  decorateCode(modal);
  modal.querySelector("#sp-on").onchange = (e) => api.skills.setEnabled(k.key, e.target.checked);
  modal.querySelector("#sp-edit").onclick = () => skillEditor(k, owner ?? currentBot ?? bots[0], () => currentBot && renderDetails(currentBot));
}

/* ======== 分享 bot：创建副本 / 模板链接；导入别人分享的 bot ======== */
function shareBotMenu(anchor, b) {
  popMenu(anchor, [
    { html: `<b>创建副本</b><span class="pf-sub">复制一个同样设定的 bot，可以改着用</span>`, run: () => duplicateBot(b) },
    { html: `<b>分享模板链接</b><span class="pf-sub">发给别人，一键导入同样的 bot</span>`, run: () => shareBotFlow(b) },
  ]);
}

async function duplicateBot(b) {
  const copy = await api.bots.duplicate(b.id);
  await refreshBots();
  selectBot(copy);
}

async function shareBotFlow(b) {
  const modal = sheet({ icon: "🔗", title: `分享「${b.name}」`, sub: "对方打开链接或导入文件，就能得到一个同样的 bot" });
  const body = modal.querySelector(".mx-body");
  body.innerHTML = `<p class="hint">正在打包…</p>`;
  try {
    const r = await api.bots.share(b.id);
    body.innerHTML = `
      <div class="sh-ok">✅ 链接已复制到剪贴板</div>
      <textarea class="sb-link" readonly rows="3">${esc(r.link)}</textarea>
      <ul class="sb-list">
        <li>包含：名字、角色、人设和提示词${b.avatarPath ? "、头像" : ""}${r.skills ? `、${r.skills} 个私有技能` : ""}</li>
        <li>不包含：模型和 API Key、记忆、会话记录</li>
        <li>链接太长发不出去时，发这个文件：<a class="ref ref-file" data-ref="file" data-id="${esc(r.file)}">${esc(r.file.split("/").pop())}</a></li>
      </ul>
      <div class="actions">
        <button class="ghost-btn" id="sb-reveal">在 Finder 中显示文件</button>
        <button class="primary-btn" id="sb-copy">再复制一次</button>
      </div>`;
    body.querySelector("#sb-reveal").onclick = () => api.system.reveal(r.file);
    body.querySelector("#sb-copy").onclick = async (e) => { await navigator.clipboard.writeText(r.link); e.target.textContent = "已复制"; };
    body.querySelector(".sb-link").onclick = (e) => e.target.select();
  } catch (e) {
    body.innerHTML = `<p class="err-text">打包失败：${esc(errText(e))}</p>`;
  }
}

function importBotFlow(prefill = "") {
  const modal = sheet({ icon: "📥", title: "导入 bot", sub: "粘贴别人分享的 harnessbot:// 链接，或选择 .harnessbot 文件" });
  const body = modal.querySelector(".mx-body");
  const ask = (err = "") => {
    body.innerHTML = `
      <textarea id="ib-input" rows="4" placeholder="harnessbot://bot/…">${esc(prefill)}</textarea>
      ${err ? `<p class="err-text">${esc(err)}</p>` : ""}
      <div class="actions">
        <button class="ghost-btn" id="ib-file">选择文件…</button>
        <button class="primary-btn" id="ib-next">下一步</button>
      </div>`;
    body.querySelector("#ib-file").onclick = async () => {
      try { const t = await api.bots.pickTemplate(); if (t) preview(t); } catch (e) { ask(errText(e)); }
    };
    body.querySelector("#ib-next").onclick = async () => {
      const v = body.querySelector("#ib-input").value.trim();
      if (!v) return;
      try { preview(await api.bots.parseTemplate(v)); } catch (e) { prefill = v; ask(errText(e)); }
    };
  };
  const preview = (t) => {
    const taken = bots.some((x) => x.name === t.name);
    body.innerHTML = `
      <div class="bp-hero"><div class="bp-avatar">${t.avatar ? `<img src="${esc(t.avatar)}" />` : "🤖"}</div>
        <div class="bp-main"><b>${esc(t.name)}</b><span class="hint">${esc(t.role)}</span></div></div>
      ${t.persona ? `<div class="bp-sec"><h4>人设</h4><p>${esc(t.persona)}</p></div>` : ""}
      ${t.skills.length ? `<div class="bp-sec"><h4>附带 ${t.skills.length} 个技能</h4>${t.skills.map((k) => `<div class="ib-skill"><b>🧩 ${esc(k.name)}</b><span class="hint">${esc(k.description)}</span></div>`).join("")}</div>` : ""}
      <p class="hint">导入后用你自己的默认模型${taken ? `；你已经有叫「${esc(t.name)}」的 bot，新的会自动加编号` : ""}。</p>
      <div class="actions">
        <button class="ghost-btn" id="ib-back">返回</button>
        <button class="primary-btn" id="ib-ok">导入</button>
      </div>`;
    body.querySelector("#ib-back").onclick = () => ask();
    body.querySelector("#ib-ok").onclick = async () => {
      const bot = await api.bots.importTemplate(t);
      closeModal();
      await refreshBots();
      selectBot(bot);
    };
  };
  if (prefill) api.bots.parseTemplate(prefill).then(preview, (e) => ask(errText(e)));
  else ask();
}

api.onImportLink((payload) => importBotFlow(payload));

// 要等所有面板脚本加载完再跑：它会用到后面几个文件里声明的函数
refreshBots().then(restoreView);
