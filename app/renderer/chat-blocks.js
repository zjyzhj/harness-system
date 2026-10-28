// 消息里的内容块：旁白与工具动作、交互卡片、产出物、群聊进度、授权请求
/* ---------- 边做边说：每段旁白一个气泡，工具调用折叠成一行动作 ---------- */
const TOOL_LABEL = {
  "fs.read": ["📖", "读取文件", "path"], "fs.write": ["✍️", "写入文件", "path"], "fs.list": ["📂", "查看目录", "path"],
  "bash.run": ["⌨️", "执行命令", "command"], "web.search": ["🔎", "搜索", "query"], "web.fetch": ["🌐", "打开网页", "url"],
  "image.generate": ["🎨", "画图", "prompt"], "image.edit": ["🖌", "改图", "prompt"], "notify": ["🔔", "发送通知", "title"],
  "memory.add": ["🧠", "记住", "content"], "memory.search": ["🧠", "回忆", "query"], "memory.update": ["🧠", "改记忆", "content"], "memory.forget": ["🧠", "删记忆", "match"], "remember": ["🧠", "记住", "content"], "recall": ["🧠", "回忆", "query"],
  "task.create": ["⏰", "创建定时任务", "name"], "task.list": ["⏰", "查看定时任务"], "task.delete": ["⏰", "删除定时任务", "name"],
  "bot.list": ["👥", "查看团队"], "app.updateSelf": ["🪪", "修改资料"], "app.setModel": ["🔀", "切换模型", "provider"], "app.listModels": ["🔀", "查看可用模型"],
  "app.state": ["🗂", "查看软件现状"], "app.createBot": ["➕", "新建 bot", "name"], "app.createGroup": ["👥", "新建群聊", "name"],
  "app.updateGroup": ["👥", "修改群聊", "group"], "plan.start": ["🧩", "发起编排", "title"], "plan.list": ["🧩", "查看编排"], "plan.cancel": ["🧩", "停止编排", "plan"],
  "env.set": ["⚙️", "保存配置", "key"], "env.delete": ["⚙️", "删除配置", "key"],
  "skill.list": ["🧩", "查看技能"], "skill.get": ["🧩", "查看技能", "key"], "skill.save": ["🧩", "保存技能", "name"], "skill.delete": ["🧩", "删除技能", "key"],
  "screen.screenshot": ["📸", "截屏"], "apple.openApp": ["🖥", "打开应用", "app"], "apple.activate": ["🖥", "切换应用", "app"], "apple.type": ["⌨️", "键盘输入"], "apple.hotkey": ["⌨️", "快捷键", "key"], "apple.tellApp": ["🖥", "控制应用", "app"],
};
function toolLabel(b) {
  const [icon, label, argKey] = TOOL_LABEL[b.tool] ?? (b.tool.startsWith("skill:") ? ["🧩", `使用技能 ${b.tool.slice(6)}`] : b.tool.startsWith("mcp:") ? ["🔌", b.tool.slice(4)] : ["🛠", b.tool]);
  const arg = argKey && b.args?.[argKey] != null ? String(b.args[argKey]) : "";
  return { icon, label, arg: arg.length > 48 ? arg.slice(0, 48) + "…" : arg };
}
function actRow(b) {
  const { icon, label, arg } = toolLabel(b);
  const st = b.status === "error" ? `<span class="act-st err">失败</span>` : b.status === "running" ? `<span class="act-st run">进行中</span>` : "";
  const body = [b.args && Object.keys(b.args).length ? `<div class="tool-args">${esc(JSON.stringify(b.args, null, 1))}</div>` : "", b.result ? `<div class="tool-result">${esc(b.result)}</div>` : ""].join("");
  return `<details class="act ${b.status === "error" ? "err" : ""}"><summary><span class="act-ico">${icon}</span><span class="act-label">${esc(label)}</span>${arg ? `<span class="act-arg">${esc(arg)}</span>` : ""}${st}</summary>${body ? `<div class="act-body">${body}</div>` : ""}</details>`;
}
function renderSegments(blocks, sources) {
  let html = "", texts = [], acts = [];
  const flushText = () => { const h = texts.map(renderBlock).join(""); if (h.trim()) html += `<div class="bubble">${mentionLinks(citeLinks(h, sources))}</div>`; texts = []; };
  const flushActs = () => {
    if (!acts.length) return;
    html += `<div class="act-list">${acts.map(actRow).join("")}</div>`;
    const written = [...new Set(acts.filter((b) => b.tool === "fs.write" && b.status !== "error" && String(b.args?.path ?? "").startsWith("/")).map((b) => String(b.args.path)))];
    html += written.filter((p) => TEXT_EXT.test(p)).map((p) => `<button class="artifact" data-artifact="${esc(p)}"><span class="af-ico">${fileIcon(p)}</span><span class="af-name">${esc(p.split("/").pop())}</span><span class="af-go">在工作台打开 ›</span></button>`).join("");
    acts = [];
  };
  for (const b of blocks) {
    if (b.type === "tool_call" && b.tool === "bot.ask") { flushText(); flushActs(); html += b2bOutHtml(b) + (b.result ? b2bInHtml(b) : ""); }
    else if (b.type === "tool_call") { flushText(); acts.push(b); }
    else if (b.type === "thinking") { flushText(); flushActs(); if (b.text?.trim()) html += thinkHtml(b); }
    else { flushActs(); texts.push(b); }
  }
  flushText();
  flushActs();
  return html;
}

/* ---------- 交互卡片：选项 / 确认 / 密钥 ---------- */
/** 以用户身份在当前会话发一句话（卡片点选后用） */
function sendAsUser(text, m) {
  if (pending.has(currentSession)) return;
  // 群里只唤醒发卡片的那个 bot；单聊里卡片来自被 @ 的其他 bot 时也指回它
  const other = m && (currentGroup || (currentBot && m.from !== currentBot.id)) ? botById(m.from) : null;
  $("#input").value = other ? `@${other.name} ${text}` : text;
  send();
}

function choiceCard(c, m) {
  const el = document.createElement("div");
  const answered = !!c.answer;
  el.className = `q-card ${c.mode === "confirm" ? "confirm" : ""} ${answered ? "answered" : ""}`;
  const key = (i) => String.fromCharCode(65 + i);
  const picked = (label) => answered && (c.answer === label || c.answer.startsWith(label));
  el.innerHTML = `
    <div class="q-title">${c.mode === "confirm" ? "⚠️ " : ""}${esc(c.question)}</div>
    ${c.detail ? `<div class="q-detail">${esc(c.detail)}</div>` : ""}
    ${c.mode === "confirm" ? `
      <div class="q-btns">
        <button class="primary-btn ${picked("确认") ? "picked" : ""}" data-v="确认">确认执行</button>
        <button class="ghost-btn ${picked("修改") ? "picked" : ""}" data-v="修改">修改</button>
        <button class="ghost-btn ${picked("取消") ? "picked" : ""}" data-v="取消">取消</button>
      </div>` : `
      ${c.options.map((o, i) => `<button class="q-opt ${picked(`${key(i)}. `) ? "picked" : ""}" data-v="${esc(`${key(i)}. ${o}`)}"><span class="q-key">${key(i)}</span><span>${esc(o)}</span></button>`).join("")}
      ${answered ? "" : `<div class="q-other"><input placeholder="其他想法…" /><button class="ghost-btn">发送</button></div>`}`}
    ${answered ? `<div class="q-done">已选：${esc(c.answer)}</div>` : ""}`;
  if (answered || m.id == null) { el.querySelectorAll("button, input").forEach((x) => (x.disabled = true)); return el; }
  const answer = async (value, text, sendIt = true) => {
    await api.messages.answer(m.sessionId, m.id, c.id, value);
    c.answer = value;
    el.replaceWith(choiceCard(c, m));
    if (sendIt) sendAsUser(text, m);
  };
  el.querySelectorAll("[data-v]").forEach((btn) => (btn.onclick = () => {
    const v = btn.dataset.v;
    if (c.mode !== "confirm") return answer(v, `选 ${v}`);
    if (v === "确认") return answer(v, "确认，执行吧");
    if (v === "取消") return answer(v, "取消，先不要执行");
    answer(v, "", false);
    $("#input").value = "修改：";
    $("#input").focus();
  }));
  const other = el.querySelector(".q-other input");
  if (other) {
    const go = () => { const t = other.value.trim(); if (t) answer(`其他：${t}`, t); };
    el.querySelector(".q-other button").onclick = go;
    other.onkeydown = (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); go(); } };
  }
  return el;
}

function secretCard(c, m) {
  const el = document.createElement("div");
  el.className = `s-card ${c.saved ? "saved" : ""}`;
  if (c.saved) {
    el.innerHTML = `<span class="s-ico">🔑</span><b>Secrets</b><span class="s-dim">已保存 · ${esc(c.label)}</span>`;
    return el;
  }
  el.innerHTML = `
    <div class="s-head"><span class="s-ico">🔑</span><b>${esc(c.label)}</b></div>
    <div class="s-row"><input type="password" placeholder="在这里粘贴，不会出现在聊天记录里" autocomplete="off" /><button class="primary-btn">保存</button></div>
    ${c.note ? `<div class="s-dim">用途：${esc(c.note)}</div>` : ""}
    <div class="s-dim">加密保存在本机钥匙串，${c.scope === "all" ? "所有 bot 都能" : `只有 ${esc(bots.find((b) => b.id === m.from)?.name || "这个 bot")} 能`}通过名字 ${esc(c.name)} 使用，看不到内容</div>`;
  const inp = el.querySelector("input");
  const save = async () => {
    const v = inp.value;
    if (!v || m.id == null) return;
    inp.value = "";
    await api.secrets.save(m.sessionId, m.id, c.name, v, c.label);
    c.saved = true;
    el.replaceWith(secretCard(c, m));
    sendAsUser(`已在加密框里填好「${c.label}」`, m);
  };
  el.querySelector("button").onclick = save;
  inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } };
  return el;
}

/* ---------- 产出物：图片相册 / 文件卡片 / 大图浏览 / 文件预览 ---------- */
const GALLERY_SHOW = 4;
const TEXT_EXT = /\.(md|markdown|txt|json|ya?ml|csv|tsv|log|js|ts|tsx|jsx|py|swift|dart|kt|java|go|rs|rb|sh|zsh|html|css|xml|plist|toml|ini|env|sql)$/i;
const FILE_ICON = [[/\.(md|markdown|txt|log)$/i, "📝"], [/\.(json|ya?ml|toml|xml|plist|csv|tsv)$/i, "🧾"], [/\.(zip|tar|gz|rar|7z)$/i, "🗜"], [/\.(pdf)$/i, "📕"], [/\.(mp4|mov|m4v|webm)$/i, "🎬"], [/\.(mp3|wav|m4a|aac)$/i, "🎵"], [/\.(js|ts|tsx|jsx|py|swift|dart|kt|java|go|rs|rb|sh|html|css|sql)$/i, "💻"]];
const imgSrc = (b) => b.dataUrl || b.url || (b.path ? fileUrl(b.path) : "");
const fileIcon = (name) => (FILE_ICON.find(([re]) => re.test(name)) ?? [null, "📄"])[1];

function renderMedia(media) {
  const box = document.createElement("div");
  box.className = "msg-media";
  const images = media.filter((b) => b.type === "image" && imgSrc(b));
  if (images.length) {
    const g = document.createElement("div");
    g.className = `gallery n${Math.min(images.length, GALLERY_SHOW)}`;
    images.slice(0, GALLERY_SHOW).forEach((b, i) => {
      const cell = document.createElement("button");
      cell.className = "g-cell";
      cell.title = b.alt || "";
      cell.innerHTML = `<img src="${esc(imgSrc(b))}" alt="${esc(b.alt || "")}" loading="lazy" />`;
      const more = images.length - GALLERY_SHOW;
      if (i === GALLERY_SHOW - 1 && more > 0) cell.insertAdjacentHTML("beforeend", `<span class="g-more">+${more}</span>`);
      cell.onclick = () => openLightbox(images, i);
      g.appendChild(cell);
    });
    box.appendChild(g);
  }
  media.filter((b) => b.type === "file").forEach((b) => box.appendChild(fileCard(b)));
  return box;
}

function fileCard(b) {
  const name = b.name || b.path.split("/").pop();
  const el = document.createElement("div");
  el.className = "f-card";
  el.title = b.path;
  el.innerHTML = `<div class="f-icon">${fileIcon(name)}</div>
    <div class="f-main"><div class="f-name">${esc(name)}</div><div class="f-sub">${[b.size != null ? formatBytes(b.size) : "", b.chars ? `${b.chars.toLocaleString()} 字` : "", b.error ? "读不出内容" : ""].filter(Boolean).join(" · ")}</div></div>
    <div class="f-ops"><button data-op="open" title="用默认应用打开">打开</button><button data-op="reveal" title="在 Finder 中显示">Finder</button></div>`;
  el.onclick = (e) => {
    const op = e.target.closest("button")?.dataset.op;
    if (op === "open") return api.system.openPath(b.path);
    if (op === "reveal") return api.system.reveal(b.path);
    if (TEXT_EXT.test(name)) openInWorkbench(b.path, name);
    else if (b.textPath) openInWorkbench(b.textPath, `${name} · 文字`);
    else api.system.openPath(b.path);
  };
  return el;
}

function openLightbox(images, start) {
  let i = start;
  const lb = document.createElement("div");
  lb.className = "lightbox";
  lb.innerHTML = `
    <div class="lb-bar"><span class="lb-name"></span><span class="lb-idx"></span>
      <span class="lb-ops"><button data-op="edit" title="把这张图交给 bot 修改">✏️ 改这张图</button><button data-op="open">打开</button><button data-op="reveal">Finder</button><button data-op="close">✕</button></span></div>
    <button class="lb-nav prev">‹</button><img class="lb-img" /><button class="lb-nav next">›</button>
    <div class="lb-strip">${images.map((b, k) => `<img data-k="${k}" src="${esc(imgSrc(b))}" loading="lazy" />`).join("")}</div>`;
  const show = () => {
    const b = images[i];
    lb.querySelector(".lb-img").src = imgSrc(b);
    lb.querySelector(".lb-name").textContent = b.alt || (b.path ? b.path.split("/").pop() : "图片");
    lb.querySelector(".lb-idx").textContent = images.length > 1 ? `${i + 1} / ${images.length}` : "";
    lb.querySelectorAll(".lb-strip img").forEach((t, k) => t.classList.toggle("on", k === i));
    lb.querySelector(".lb-strip img.on")?.scrollIntoView({ block: "nearest", inline: "center" });
    lb.querySelector("[data-op=open]").style.display = lb.querySelector("[data-op=reveal]").style.display = b.path ? "" : "none";
    lb.querySelectorAll(".lb-nav").forEach((n) => (n.style.visibility = images.length > 1 ? "" : "hidden"));
  };
  const go = (d) => { i = (i + d + images.length) % images.length; show(); };
  const close = () => { lb.remove(); document.removeEventListener("keydown", onKey, true); };
  const onKey = (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft") go(-1);
    else if (e.key === "ArrowRight") go(1);
    else return;
    e.preventDefault(); e.stopPropagation();
  };
  lb.onclick = (e) => {
    const op = e.target.closest("button")?.dataset.op;
    if (op === "close" || e.target === lb) return close();
    if (op === "open") return api.system.openPath(images[i].path);
    if (op === "edit") {
      const b = images[i];
      close();
      addPending(b.path ? { type: "image", path: b.path, alt: b.alt || b.path.split("/").pop() } : { type: "image", dataUrl: b.dataUrl, alt: b.alt || "图片" });
      $("#input").value = "把这张图改成：";
      $("#input").focus();
      return;
    }
    if (op === "reveal") return api.system.reveal(images[i].path);
    if (e.target.classList.contains("prev")) return go(-1);
    if (e.target.classList.contains("next")) return go(1);
    if (e.target.dataset.k) { i = Number(e.target.dataset.k); show(); }
  };
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(lb);
  show();
}

function makeMsgEl(m) {
  const wrapper = document.createElement("div");
  wrapper.dataset.id = m.id ?? "";
  wrapper.dataset.ts = m.createdAt ?? "";
  if (m.kind === "event") {
    wrapper.className = "msg sys";
    wrapper.innerHTML = `<div class="bubble">${esc(m.content)}</div>`;
    return wrapper;
  }
  const blocks = Array.isArray(m.content) ? m.content : null;
  const media = blocks ? blocks.filter((b) => b.type === "image" || b.type === "file") : [];
  const cards = blocks ? blocks.filter((b) => b.type === "choice" || b.type === "secret" || b.type === "conclusion") : [];
  const sources = blocks?.find((b) => b.type === "sources")?.items ?? [];
  const rest = blocks ? blocks.filter((b) => !["image", "file", "choice", "secret", "conclusion", "sources"].includes(b.type)) : null;
  const isUser = m.from === "user";
  const sender = botById(m.from);
  const showWho = !isUser && (m.kind === "bot-to-bot" || !currentBot || m.from !== currentBot.id);
  wrapper.className = "msg " + (isUser ? "user" : "bot") + (m.meta?.tag ? ` ${m.meta.tag}` : "");
  const inner = rest ? renderSegments(rest, sources) : `<div class="bubble">${mentionLinks(renderMarkdown(esc(m.content)))}</div>`;
  const meta = m.meta ? [m.meta.model, m.meta.latencyMs ? m.meta.latencyMs + "ms" : "", m.meta.tokensUsed ? fmtTok(m.meta.tokensUsed) + " tok" : "", m.meta.usage?.calls > 1 ? `${m.meta.usage.calls} 次模型调用` : "", m.meta.usage?.cached && m.meta.usage.input ? `缓存命中 ${Math.round((m.meta.usage.cached / m.meta.usage.input) * 100)}%` : ""].filter(Boolean).join(" · ") : "";
  wrapper.innerHTML = `${showWho ? whoHtml(sender?.name ?? m.from, m.meta, sender) : ""}${inner}<div class="msg-meta">${esc([m.createdAt ? fmtTime(m.createdAt) : "", meta].filter(Boolean).join(" · "))}</div>`;
  if (media.length) wrapper.insertBefore(renderMedia(media), wrapper.querySelector(".msg-meta"));
  if (sources.length) wrapper.insertBefore(sourcesStrip(sources), wrapper.querySelector(".msg-meta"));
  cards.forEach((c) => wrapper.insertBefore(c.type === "choice" ? choiceCard(c, m) : c.type === "secret" ? secretCard(c, m) : conclusionCard(c, m), wrapper.querySelector(".msg-meta")));
  decorateCode(wrapper);
  attachMsgActions(wrapper, m);
  return wrapper;
}

/** 联网来源：一行「N 个来源」+ 站点，点开看列表 */
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };
function sourcesStrip(items) {
  const el = document.createElement("div");
  el.className = "src-strip";
  const hosts = [...new Set(items.map((s) => hostOf(s.url)))];
  el.innerHTML = `
    <button class="src-chip"><span class="src-ico">🌐</span>${items.length} 个来源<span class="src-hosts">${esc(hosts.slice(0, 3).join(" · "))}${hosts.length > 3 ? " …" : ""}</span><span class="src-arrow">›</span></button>
    <div class="src-list hidden">${items.map((s, i) => `
      <a class="src-item" href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.url)}">
        <span class="src-n">${i + 1}</span>
        <span class="src-main"><span class="src-title">${esc(s.title || s.url)}</span><span class="src-host">${esc(hostOf(s.url))}</span>${s.snippet ? `<span class="src-snip">${esc(s.snippet)}</span>` : ""}</span>
      </a>`).join("")}</div>`;
  el.querySelector(".src-chip").onclick = () => {
    el.querySelector(".src-list").classList.toggle("hidden");
    el.classList.toggle("open");
  };
  return el;
}

/** 追问建议：只挂在会话最后一条 bot 回复下面 */
function showSuggestions(msgEl, list) {
  document.querySelectorAll("#messages .sugg").forEach((x) => x.remove());
  if (!msgEl || !list?.length || currentGroup) return;
  const box = document.createElement("div");
  box.className = "sugg";
  box.innerHTML = list.map((s) => `<button>${esc(s)}<span>↗</span></button>`).join("");
  box.querySelectorAll("button").forEach((btn, i) => (btn.onclick = () => {
    if (pending.has(currentSession)) return;
    box.remove();
    $("#input").value = list[i];
    send();
  }));
  (msgEl.classList.contains("msg-group") ? msgEl.lastElementChild ?? msgEl : msgEl).appendChild(box);
  const mb = $("#messages");
  if (mb.scrollHeight - mb.scrollTop - mb.clientHeight < 160) mb.scrollTop = mb.scrollHeight;
}

/** 发言人一行：群聊里标出在回应谁（A → B / → 你），主持人小结和结论单独标注 */
function whoHtml(name, meta, bot) {
  const tag = meta?.tag === "summary" ? `<span class="who-tag">主持人小结</span>` : meta?.tag === "conclusion" ? `<span class="who-tag">讨论结论</span>` : "";
  const to = meta?.replyTo === "user" ? "你" : meta?.replyTo ? botById(meta.replyTo)?.name ?? "" : "";
  const av = currentGroup && bot ? `<span class="who-av${isBusy(bot.id, true) ? " busy" : ""}" data-av-bot="${esc(bot.id)}" data-av-group>${avatarHtml(bot)}</span>` : "";
  return `<div class="who">${av}${esc(name)}${currentGroup && to ? `<span class="who-to"> → ${esc(to)}</span>` : ""}${tag}</div>`;
}

/** 讨论结论卡片：总结 / 决定 / 任务（可勾选、可分派执行）/ 待定问题 */
function conclusionCard(c, m) {
  const el = document.createElement("div");
  el.className = "cc-card";
  const canAct = m.id != null && currentGroup;
  const todo = c.tasks.map((t, i) => (!t.dispatched && t.ownerId && botById(t.ownerId) ? i : -1)).filter((i) => i >= 0);
  el.innerHTML = `
    <div class="cc-head">📋 讨论结论</div>
    ${c.summary ? `<div class="cc-sum">${esc(c.summary)}</div>` : ""}
    ${c.decisions.length ? `<div class="cc-sec"><h5>决定了什么</h5><ul>${c.decisions.map((d) => `<li>${esc(d)}</li>`).join("")}</ul></div>` : ""}
    ${c.tasks.length ? `<div class="cc-sec"><h5>谁负责</h5>${c.tasks.map((t, i) => `
      <div class="cc-task ${t.done ? "done" : ""}">
        <input type="checkbox" data-done="${i}" ${t.done ? "checked" : ""} ${canAct ? "" : "disabled"} />
        <span class="cc-owner">${esc(t.owner)}</span><span class="cc-text">${esc(t.task)}</span>
        ${t.dispatched ? `<span class="cc-st">已分派</span>` : canAct && t.ownerId && botById(t.ownerId) ? `<button class="ghost-btn" data-go="${i}">分派执行</button>` : ""}
      </div>`).join("")}</div>` : ""}
    ${c.open?.length ? `<div class="cc-sec"><h5>还没定</h5><ul>${c.open.map((d) => `<li>${esc(d)}</li>`).join("")}</ul></div>` : ""}
    ${canAct && todo.length > 1 ? `<div class="cc-ops"><button class="primary-btn" data-go="all">全部分派执行</button></div>` : ""}`;
  el.querySelectorAll("[data-done]").forEach((cb) => (cb.onchange = async () => {
    const i = Number(cb.dataset.done);
    await api.groups.taskDone(m.sessionId, m.id, i, cb.checked);
    c.tasks[i].done = cb.checked;
    cb.closest(".cc-task").classList.toggle("done", cb.checked);
  }));
  el.querySelectorAll("[data-go]").forEach((btn) => (btn.onclick = () => {
    if (pending.has(m.sessionId)) return;
    const idx = btn.dataset.go === "all" ? todo : [Number(btn.dataset.go)];
    const first = botById(c.tasks[idx[0]].ownerId);
    const g = currentGroup;
    streamReply({ sid: m.sessionId, run: () => api.groups.dispatch(g.id, m.sessionId, m.id, idx), firstBot: first, firstKey: first ? `${first.id}:d1` : undefined });
  }));
  return el;
}

function appendMsg(m) {
  const box = $("#messages");
  const ts = Number(m.createdAt) || 0;
  const lastTs = Number(box.dataset.lastTs) || 0;
  if (ts && (!lastTs || ts - lastTs > 10 * 60_000)) {
    const sep = document.createElement("div");
    sep.className = "time-sep";
    sep.textContent = fmtTime(ts);
    box.appendChild(sep);
  }
  if (ts) box.dataset.lastTs = String(ts);
  const el = makeMsgEl(m);
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  return el;
}

/** 进行中的回复：sessionId → 该轮的界面节点（用户消息、bot 间往来、流式气泡），切走再切回来可重新挂上 */
const pending = new Map();
/** 等待用户处理的授权请求：id → { req, inline 会话内卡片, float 右下角浮卡 } */
const consents = new Map();

async function send() {
  if (pending.has(currentSession)) {
    if (currentGroup && $("#input").value.trim()) return interject(currentGroup, currentSession);
    return api.chat.cancel(currentSession);
  }
  const text = $("#input").value.trim();
  if ((!text && !pendingAtt.length) || (!currentBot && !currentGroup)) return;
  $("#input").value = "";
  inputEl.style.height = "auto";
  const rich = pendingAtt.length ? [{ type: "text", text }, ...pendingAtt] : text;
  clearPending();
  if (currentGroup) return sendGroup(currentGroup, rich, text);
  // @组名 → 群组广播（G4）
  const groups = await api.groups.list();
  const gMatch = text.match(/^@([\p{L}\p{N}_\-\u4e00-\u9fa5]+)\s+([\s\S]+)/u);
  const g = gMatch ? groups.find((x) => x.name === gMatch[1]) : null;
  if (g) {
    const members = await api.groups.broadcast(g.id, currentBot.id, gMatch[2]);
    members.forEach((m) => appendMsg(m));
    return;
  }
  // @bot名 → 由被 @ 的 bot 在当前会话里接话（共享上下文，像群聊）
  const replyBot = currentBot;
  if (isForeign(currentSession)) await openOwnSession();
  const sid = currentSession ?? `s-${Date.now()}`;
  currentSession = sid;
  const userEl = appendMsg({ sessionId: sid, from: "user", to: replyBot.id, role: "user", content: rich, kind: "chat", createdAt: Date.now() });
  await streamReply({ sid, userEl, run: () => api.chat.sendStream(replyBot.id, rich, sid, chatOpts()), firstBot: replyBot });
}

/**
 * 一轮流式回复的界面：思考计时 → 按 bot 分气泡打字 → bot 间往来实时框 → 结束后整体刷新会话。
 * firstBot 有值时立即出它的「思考中」气泡（单聊）；群聊成员的气泡在各自首个增量到达时创建。
 */
async function streamReply({ sid, userEl, run, firstBot, firstKey }) {
  const nodes = [userEl].filter(Boolean);
  const bubbles = new Map();
  const asks = new Map();
  const entry = { nodes, add: (...els) => add(...els) };
  pending.set(sid, entry);
  setSending();
  const t0 = Date.now();
  const follow = () => { if (nodes.some((n) => n.isConnected)) { const box = $("#messages"); box.scrollTop = box.scrollHeight; } };
  const tail = () => nodes[nodes.length - 1];
  const add = (...els) => {
    const anchor = tail();
    if (anchor?.isConnected) anchor.after(...els);
    else if (!nodes.length && currentSession === sid) $("#messages").append(...els);
    nodes.push(...els);
  };
  const bubbleFor = (key, botId = key) => {
    let b = bubbles.get(key);
    if (b) return b;
    const el = document.createElement("div");
    el.className = "msg bot";
    const showWho = !currentBot || botId !== currentBot.id;
    const kind = String(key).split(":")[1] ?? "";
    const tag = kind.startsWith("s") ? { tag: "summary" } : kind === "c" ? { tag: "conclusion" } : null;
    if (tag) el.classList.add(tag.tag);
    const wait = kind === "c" ? "整理讨论结论" : "思考中";
    el.innerHTML = `${showWho ? whoHtml(botById(botId)?.name ?? botId, tag, botById(botId)) : ""}<div class="bubble"><span class="thinking">${wait}<span class="dots"></span> <span class="secs">0s</span></span></div>`;
    b = { el, bubble: el.querySelector(".bubble"), started: false, text: "", done: "", live: new Map() };
    bubbles.set(key, b);
    add(el);
    return b;
  };
  if (firstBot) bubbleFor(firstKey ?? firstBot.id, firstBot.id);
  const ticker = setInterval(() => {
    const secs = `${Math.floor((Date.now() - t0) / 1000)}s`;
    bubbles.forEach((b) => {
      const el = b.el.querySelector(".secs");
      if (el) el.textContent = secs;
      if (b.thinkEl?.classList.contains("live")) b.thinkEl.querySelector(".tb-label").textContent = `正在思考 ${Math.floor((Date.now() - b.thinkStart) / 1000)} 秒`;
    });
  }, 500);
  follow();
  /** 思考结束（开始出正文或调用工具）：折叠成「已深度思考 N 秒」 */
  const endThink = (b) => {
    if (!b.thinkEl?.classList.contains("live")) return;
    b.thinkEl.classList.remove("live");
    b.thinkEl.open = false;
    b.thinkEl.querySelector(".dots")?.remove();
    b.thinkEl.querySelector(".tb-label").textContent = `已深度思考 ${thinkSecs(Date.now() - b.thinkStart)}`;
    b.bubble.classList.remove("hidden");
  };
  const offStream = api.onChatStream((chunk) => {
    if (chunk.sessionId !== sid) return;
    const b = bubbleFor(chunk.turn != null ? `${chunk.botId}:${chunk.turn}` : chunk.botId, chunk.botId);
    if (chunk.type === "thinking") {
      if (!chunk.text) return;
      if (!b.thinkEl) {
        const holder = document.createElement("div");
        holder.innerHTML = thinkHtml({ text: "" }, true);
        b.thinkEl = holder.firstElementChild;
        b.el.insertBefore(b.thinkEl, b.bubble);
        b.think = "";
      }
      if (!b.thinkEl.classList.contains("live")) {
        b.thinkStart = Date.now();
        b.thinkEl.classList.add("live");
        b.thinkEl.open = true;
        if (b.think) b.think += "\n\n";
      }
      if (!b.started) b.bubble.classList.add("hidden");
      b.think += chunk.text;
      const body = b.thinkEl.querySelector(".tb-body");
      body.textContent = b.think;
      body.scrollTop = body.scrollHeight;
      follow();
      return;
    }
    if (chunk.type === "retract") {
      b.text = "";
      const paint = () => {
        b.bubble.innerHTML = b.done || `<span class="thinking">处理中<span class="dots"></span></span>`;
      };
      paint();
      follow();
      return;
    }
    if ((chunk.type === "text" && chunk.text) || chunk.type === "tool_call") endThink(b);
    if (!b.started && ((chunk.type === "text" && chunk.text) || chunk.type === "tool_call")) {
      b.started = true;
      b.bubble.innerHTML = "";
    }
    const shownText = () => b.text.replace(/```tool[\s\S]*?(```|$)/g, "").trim();
    const paint = () => {
      const t = shownText();
      b.bubble.innerHTML = b.done + (t ? renderMarkdown(esc(t)) : b.done ? "" : `<span class="thinking">处理中<span class="dots"></span></span>`);
    };
    if (chunk.type === "text" && chunk.text) {
      b.text += chunk.text;
      paint();
    } else if (chunk.type === "tool_call" && chunk.tool === "bot.ask") {
      let entry = asks.get(chunk.callId);
      if (!entry) {
        const t = shownText();
        entry = { b, call: chunk, botId: askTarget(chunk)?.id, answer: "", html: b2bLiveHtml(chunk, "") };
        asks.set(chunk.callId, entry);
        b.done += (t ? renderMarkdown(esc(t)) : "") + b2bOutHtml(chunk) + entry.html;
        b.text = "";
      }
      if (chunk.status !== "running") {
        const fin = b2bInHtml(chunk);
        b.done = b.done.replace(entry.html, fin);
        entry.html = fin;
        entry.done = true;
      }
      paint();
    } else if (chunk.type === "tool_call" && chunk.status === "running") {
      const t = shownText();
      const { icon, label, arg } = toolLabel(chunk);
      const live = `<div class="act-live"><span class="thinking">${icon} ${esc(label)}${arg ? ` · ${esc(arg)}` : ""}<span class="dots"></span></span></div>`;
      b.done += (t ? renderMarkdown(esc(t)) : "") + live;
      b.live.set(chunk.callId, live);
      b.text = "";
      paint();
    } else if (chunk.type === "tool_call") {
      const live = b.live.get(chunk.callId);
      b.done = live ? b.done.replace(live, actRow(chunk)) : b.done + actRow(chunk);
      paint();
    }
    follow();
  });
  const offB2b = api.onB2bStream((ev) => {
    if (ev.parentSessionId !== sid || ev.block.type !== "text" || !ev.block.text) return;
    const entry = [...asks.values()].reverse().find((x) => x.botId === ev.botId && !x.done);
    if (!entry) return;
    entry.answer += ev.block.text;
    const next = b2bLiveHtml(entry.call, entry.answer.replace(/```tool[\s\S]*?(```|$)/g, ""));
    entry.b.done = entry.b.done.replace(entry.html, next);
    entry.html = next;
    entry.b.bubble.innerHTML = entry.b.done + `<span class="thinking">处理中<span class="dots"></span></span>`;
    follow();
  });
  try {
    await run();
  } catch {
    // 失败信息已由主进程写入会话，刷新后显示
  }
  offStream();
  offB2b();
  clearInterval(ticker);
  pending.delete(sid);
  setSending();
  if (currentSession === sid) await loadSessionMessages(sid, true);
  refreshBots();
  onReplyDone(sid);
}

/** 重新生成：删掉这条回复及其对应的用户消息，用同一内容重新发给同一个 bot */
async function regenerate(m) {
  const sid = m.sessionId;
  if (pending.has(sid)) return;
  const msgs = await api.messages.list(sid);
  const idx = msgs.findIndex((x) => x.id === m.id);
  const userMsg = msgs.slice(0, idx).reverse().find((x) => x.role === "user");
  if (!userMsg) return;
  const tail = msgs.slice(msgs.indexOf(userMsg));
  if (tail.some((x) => x.role === "assistant" && x.id !== m.id)) {
    if (!confirm("这条之后还有其他回复，重新生成会把它们一并删除，继续？")) return;
  }
  await api.messages.remove(sid, tail.map((x) => x.id));
  await loadSessionMessages(sid, true);
  const bot = botById(m.from) ?? currentBot;
  const userEl = appendMsg({ ...userMsg, id: undefined });
  await streamReply({ sid, userEl, run: () => api.chat.sendStream(bot.id, userMsg.content, sid, chatOpts()), firstBot: bot });
}

/** 接力进行中插话：消息立即上屏，下一个发言位优先回应（@ 了谁就谁回，没 @ 由主持人回） */
async function interject(g, sid) {
  const text = $("#input").value.trim();
  const rich = pendingAtt.length ? [{ type: "text", text }, ...pendingAtt] : text;
  $("#input").value = "";
  inputEl.style.height = "auto";
  clearPending();
  const r = await api.groups.interject(g.id, sid, rich);
  if (!r?.ok) { $("#input").value = text; setSending(); return; }
  const el = makeMsgEl({ sessionId: sid, from: "user", to: g.id, role: "user", content: rich, kind: "chat", createdAt: Date.now() });
  pending.get(sid)?.add(el);
  const box = $("#messages");
  box.scrollTop = box.scrollHeight;
  setSending();
}

/** 群聊：一个共享会话，成员依次接话 */
async function sendGroup(g, rich, text) {
  const sid = currentSession ?? `group-${g.id}-${Date.now()}`;
  currentSession = sid;
  const userEl = appendMsg({ sessionId: sid, from: "user", to: g.id, role: "user", content: rich, kind: "chat", createdAt: Date.now() });
  const named = bots.filter((b) => text.includes("@" + b.name)).sort((a, b) => text.indexOf("@" + a.name) - text.indexOf("@" + b.name));
  const first = named[0] ?? botById(g.members[0]);
  await streamReply({ sid, userEl, run: () => api.groups.chat(g.id, rich, sid), firstBot: first, firstKey: first ? `${first.id}:0` : undefined });
  if (currentGroup?.id === g.id && !$("#details").classList.contains("hidden")) renderGroupDetails(currentGroup);
}

/** 消息里 @ 到的其他 bot（取最长匹配的名字，避免「灵感助手」误中「灵感小助手」） */
/** 当前会话有回复进行中时，发送按钮变成「停止生成」 */
function setSending() {
  const busy = pending.has(currentSession);
  const talk = busy && !!currentGroup && !!$("#input").value.trim();
  const btn = $("#send-btn");
  btn.classList.toggle("stop", busy && !talk);
  btn.textContent = busy && !talk ? "■" : "↑";
  btn.title = talk ? "插话：下一位发言者会先回应你" : busy ? "停止生成" : "发送";
  syncConsentDock();
}

/* ---------- 群聊接力进度条 ---------- */
const relayState = new Map();
api.onGroupProgress((p) => {
  relayState.set(p.sessionId, p);
  if (p.state === "done") setTimeout(() => { if (relayState.get(p.sessionId) === p) { relayState.delete(p.sessionId); renderRelayBar(); } }, 6000);
  renderRelayBar();
  renderBotList();
});
function renderRelayBar() {
  const bar = $("#relay-bar");
  const p = currentSession && relayState.get(currentSession);
  if (!p) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  bar.classList.toggle("done", p.state === "done");
  const pct = p.max ? Math.min(100, Math.round(((p.turn ?? 0) / p.max) * 100)) : 0;
  const what = p.dispatch ? "分派执行" : "接力";
  const text = p.state === "done" ? `${what}结束 · ${esc(p.reason || "")}`
    : p.state === "summary" ? `🧭 ${esc(p.speaker)} 正在做第 ${p.round} 轮小结`
    : p.state === "conclusion" ? `📋 ${esc(p.speaker)} 正在整理结论`
    : `${what}中 · 第 ${p.turn}/${p.max} ${p.dispatch ? "项" : "次发言"}${p.round > 1 ? ` · 第 ${p.round} 轮` : ""} · <b>${esc(p.speaker)}</b> 发言中${p.next?.length ? ` · 接下来：${esc(p.next.slice(0, 3).join("、"))}${p.next.length > 3 ? "…" : ""}` : ""}`;
  bar.innerHTML = `<div class="rb-track"><div class="rb-fill" style="width:${p.state === "done" ? 100 : pct}%"></div></div>
    <div class="rb-row"><span class="rb-text">${text}</span>${p.state === "done" ? "" : `<span class="rb-hint">输入框打字可插话</span><button class="ghost-btn" id="rb-stop">停止</button>`}</div>`;
  const stop = bar.querySelector("#rb-stop");
  if (stop) stop.onclick = () => api.chat.cancel(p.sessionId);
}

/* ---------- 授权请求：显示在 bot 干活的会话里；不在当前会话时浮在右下角 ---------- */
function consentCard(req, floating) {
  const el = document.createElement("div");
  el.className = `cs-card ${req.danger ? "danger" : ""} ${floating ? "floating" : ""}`;
  const always = !req.danger && !req.onceOnly && req.command ? `<button class="ghost-btn" data-d="allow-command">总是允许 ${esc(req.command)}</button>` : "";
  const group = !req.danger && !req.command && req.cap !== "bash:other" ? `<button class="ghost-btn" data-d="allow" title="以后不再问">长期批准「${esc(req.capLabel)}」</button>` : "";
  const reasons = req.reasons?.length ? `<div class="cs-reasons">${req.reasons.map((r) => `<div>· ${esc(r)}</div>`).join("")}${req.onceOnly && !req.danger ? `<div class="hint">这种写法只能逐次批准</div>` : ""}</div>` : "";
  el.innerHTML = `
    <div class="cs-head">🔐 <b>${esc(req.botName)}</b> ${req.command ? `想执行 <code>${esc(req.command)}</code>` : `请求使用「${esc(req.capLabel)}」`}</div>
    <pre class="cs-desc">${esc(req.description)}</pre>
    ${reasons}
    ${req.danger ? `<div class="cs-warn">⚠️ 危险操作：每次都要确认，输入 confirm 后才能批准 <input placeholder="confirm" /></div>` : ""}
    <div class="cs-btns"><button class="primary-btn" data-d="allow-once">允许一次</button>${always}${group}<button class="ghost-btn" data-d="deny">拒绝</button>${floating && req.sessionId ? `<button class="ghost-btn" data-d="open">查看会话</button>` : ""}</div>`;
  const gate = el.querySelector(".cs-warn input");
  const allowBtns = [...el.querySelectorAll('[data-d^="allow"]')];
  if (gate) { allowBtns.forEach((b) => (b.disabled = true)); gate.oninput = () => allowBtns.forEach((b) => (b.disabled = gate.value.trim().toLowerCase() !== "confirm")); }
  el.querySelectorAll("[data-d]").forEach((btn) => (btn.onclick = () => {
    if (btn.dataset.d === "open") return openSessionById(req.sessionId, req.botId);
    api.consent.respond(req.id, btn.dataset.d);
  }));
  return el;
}
function syncConsentDock() {
  let dock = $("#consent-dock");
  for (const c of consents.values()) {
    const away = !c.inline || c.req.sessionId !== currentSession;
    if (away && !c.float) {
      if (!dock) { dock = document.createElement("div"); dock.id = "consent-dock"; document.body.appendChild(dock); }
      c.float = consentCard(c.req, true);
      dock.appendChild(c.float);
    } else if (!away && c.float) {
      c.float.remove();
      c.float = null;
    }
  }
}
/* ---------- 系统通知发不出：右下角提示；开对条目或点「不再提醒」后收起 ---------- */
let notifyBlocked = false;
let notifyAppLabel = "harness-bot";
const NOTIFY_HINT = () => `<div class="notify-hint">🔔 系统通知发不出（设置里找「${esc(notifyAppLabel)}」）· <a class="ref" data-ref="settings" data-id="notifications">去开启</a></div>`;
function applyNotifyState(p) {
  const state = typeof p === "string" ? p : p?.state;
  const reason = typeof p === "object" ? p?.reason : undefined;
  if (p && typeof p === "object") {
    if (p.appLabel) notifyAppLabel = p.appLabel;
    if (p.muted) { notifyBlocked = false; $("#notify-card")?.remove(); }
    else notifyBlocked = state === "blocked";
  } else {
    notifyBlocked = state === "blocked";
  }
  if (notifyBlocked) showNotifyCard(reason);
  else $("#notify-card")?.remove();
  if (currentBot && !$("#details").classList.contains("hidden")) renderDetails(currentBot);
}
api.onNotifyState((p) => applyNotifyState(p));
api.system.notifyState().then(applyNotifyState).catch(() => {});

function showNotifyCard(reason) {
  let dock = $("#consent-dock");
  if (!dock) { dock = document.createElement("div"); dock.id = "consent-dock"; document.body.appendChild(dock); }
  let el = $("#notify-card");
  if (!el) {
    el = document.createElement("div");
    el.id = "notify-card";
    el.className = "cs-card floating";
    dock.appendChild(el);
  }
  const extra = reason ? `<div class="hint" style="margin-top:6px;opacity:.85">${esc(reason)}</div>` : "";
  el.innerHTML = `<div class="cs-head">🔔 系统通知发不出来</div>
    <div class="hint">到点提醒只能在软件里看到。请到「系统设置 → 通知」里找到 <b>${esc(notifyAppLabel)}</b>（开发运行时是 Electron，不是 harness-bot），打开「允许通知」，再点「重新检测」。检测时会弹一条测试通知。</div>${extra}
    <div class="cs-btns"><button class="primary-btn" data-n="open">去开启通知</button><button class="ghost-btn" data-n="recheck">重新检测</button><button class="ghost-btn" data-n="mute">不再提醒</button><button class="ghost-btn" data-n="close">关闭</button></div>`;
  el.onclick = async (e) => {
    const btn = e.target.closest("button");
    const d = btn?.dataset.n;
    if (d === "open") api.system.openPrefs("notifications");
    if (d === "recheck") {
      btn.disabled = true;
      btn.textContent = "检测中…";
      const r = await api.system.notifyRecheck().catch(() => ({ state: "blocked", appLabel: notifyAppLabel, reason: "检测失败" }));
      applyNotifyState(r);
      if (r.state === "blocked") {
        btn.disabled = false;
        btn.textContent = "重新检测";
        showNotifyCard(r.reason || "仍发不出，可点「不再提醒」先关掉提示");
      }
      return;
    }
    if (d === "mute") {
      applyNotifyState(await api.system.notifyMute().catch(() => ({ state: "blocked", muted: true })));
      return;
    }
    if (d) el.remove();
  };
}

api.onConsentRequest((req) => {
  const c = { req, inline: null, float: null };
  const live = req.sessionId && pending.get(req.sessionId);
  if (live) {
    c.inline = consentCard(req, false);
    live.add(c.inline);
    if (currentSession === req.sessionId) { const box = $("#messages"); box.scrollTop = box.scrollHeight; }
  }
  consents.set(req.id, c);
  syncConsentDock();
});
api.onConsentResolved(({ id, decision }) => {
  const c = consents.get(id);
  if (!c) return;
  consents.delete(id);
  c.float?.remove();
  if (c.inline) {
    c.inline.classList.add("resolved");
    c.inline.querySelector(".cs-btns").innerHTML = `<span class="cs-done">${decision === "deny" ? "已拒绝" : decision === "allow" ? "已长期批准" : decision === "allow-command" ? `以后总是允许 ${esc(c.req.command || "")}` : "已允许一次"}</span>`;
    c.inline.querySelector(".cs-warn")?.remove();
  }
});


function openModal(html) {
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-mask"><div class="modal">${html}</div></div>`;
  root.querySelector(".modal-mask").onclick = (e) => { if (e.target === e.currentTarget) root.innerHTML = ""; };
  return root.querySelector(".modal");
}

function closeModal() { $("#modal-root").innerHTML = ""; }

/** 形状 + 颜色选择器；onChange 每次选中都会回调当前的 {shape, color} */
function avatarPicker(container, initial, onChange) {
  const cur = { ...initial };
  container.innerHTML = `
    <div class="ap-shapes">${BOT_SHAPES.map((s) => `<button class="ap-shape" data-shape="${s.id}" title="${s.id}">${blobAvatarSvg({ shape: s.id, color: cur.color })}</button>`).join("")}</div>
    <div class="ap-colors">${BOT_COLORS.map((c) => `<button class="ap-color" data-color="${c}" style="--c:${c}" title="${c}"></button>`).join("")}</div>`;
  const sync = () => {
    container.querySelectorAll(".ap-shape").forEach((el) => {
      el.classList.toggle("on", el.dataset.shape === cur.shape);
      el.innerHTML = blobAvatarSvg({ shape: el.dataset.shape, color: cur.color });
    });
    const fixed = SHAPE_BY_ID[cur.shape]?.color;
    container.querySelectorAll(".ap-color").forEach((el) => {
      el.classList.toggle("on", !fixed && el.dataset.color === cur.color);
      el.disabled = !!fixed;
    });
    onChange({ ...cur });
  };
  container.querySelectorAll(".ap-shape").forEach((el) => (el.onclick = () => { cur.shape = el.dataset.shape; sync(); }));
  container.querySelectorAll(".ap-color").forEach((el) => (el.onclick = () => { cur.color = el.dataset.color; sync(); }));
  sync();
}

function randomAvatar() {
  const shapes = BOT_SHAPES.filter((s) => !s.color);
  return { shape: shapes[Math.floor(Math.random() * shapes.length)].id, color: BOT_COLORS[1 + Math.floor(Math.random() * (BOT_COLORS.length - 1))] };
}

/** 选中头像时让预览跳一下 */
function bouncePreview(el) {
  el.classList.remove("pop");
  void el.offsetWidth;
  el.classList.add("pop");
}

async function createBotFlow() {
  let avatar = randomAvatar();
  const modal = openModal(`
    <div class="cb-head"><h2>新建 Bot</h2><button class="cb-x" title="关闭">✕</button></div>
    <div class="cb-body">
      <div class="cb-preview"></div>
      <input id="cb-name" class="cb-name" placeholder="给 Bot 起个名字" maxlength="24" />
      <div class="cb-picker"></div>
    </div>
    <div class="cb-foot">
      <span class="cb-links"><button class="link-btn" id="cb-text">用一句话描述创建…</button><button class="link-btn" id="cb-import">导入</button></span>
      <button class="ghost-btn" id="cb-cancel">取消</button>
      <button class="primary-btn" id="cb-ok" disabled>创建</button>
    </div>`);
  modal.classList.add("cb-modal");
  const preview = modal.querySelector(".cb-preview");
  const nameEl = modal.querySelector("#cb-name");
  const ok = modal.querySelector("#cb-ok");
  avatarPicker(modal.querySelector(".cb-picker"), avatar, (a) => {
    avatar = a;
    preview.innerHTML = blobAvatarSvg(a, "preview");
    bouncePreview(preview);
  });
  nameEl.oninput = () => {
    ok.disabled = !nameEl.value.trim();
    preview.classList.toggle("typing", !!nameEl.value);
  };
  nameEl.onkeydown = (e) => { if (e.key === "Enter" && !e.isComposing && !ok.disabled) ok.click(); };
  ok.onclick = async () => {
    const name = nameEl.value.trim();
    if (!name) return;
    ok.disabled = true;
    ok.textContent = "创建中…";
    preview.classList.add("busy");
    try {
      const bot = await api.bots.create(`创建 bot：${name}`, { name, avatar });
      closeModal();
      await refreshBots();
      selectBot(bots.find((x) => x.id === bot.id) ?? bot);
    } catch (e) {
      ok.disabled = false;
      ok.textContent = "创建";
      preview.classList.remove("busy");
      alert(`创建失败：${e?.message || e}`);
    }
  };
  modal.querySelector(".cb-x").onclick = closeModal;
  modal.querySelector("#cb-cancel").onclick = closeModal;
  modal.querySelector("#cb-text").onclick = () => createBotByTextFlow();
  modal.querySelector("#cb-import").onclick = () => importBotFlow();
  setTimeout(() => nameEl.focus(), 30);
}

async function changeAvatarFlow(b) {
  let avatar = validAvatar(b.avatar) ? b.avatar : randomAvatar();
  const modal = openModal(`
    <div class="cb-head"><h2>换头像 — ${esc(b.name)}</h2><button class="cb-x" title="关闭">✕</button></div>
    <div class="cb-body"><div class="cb-preview"></div><div class="cb-picker"></div>
      ${b.avatarPath ? `<div class="hint">保存后会替换现在的图片头像。</div>` : ""}</div>
    <div class="cb-foot"><span class="cb-links"></span><button class="ghost-btn" id="cb-cancel">取消</button><button class="primary-btn" id="cb-ok">保存</button></div>`);
  modal.classList.add("cb-modal");
  const preview = modal.querySelector(".cb-preview");
  avatarPicker(modal.querySelector(".cb-picker"), avatar, (a) => { avatar = a; preview.innerHTML = blobAvatarSvg(a, b.id); bouncePreview(preview); });
  modal.querySelector(".cb-x").onclick = closeModal;
  modal.querySelector("#cb-cancel").onclick = closeModal;
  modal.querySelector("#cb-ok").onclick = async () => {
    await api.bots.update(b.id, { avatar });
    closeModal();
    await refreshBots();
    const nb = bots.find((x) => x.id === b.id);
    if (nb && currentBot?.id === nb.id) selectBot(nb);
  };
}

async function createBotByTextFlow() {
  const modal = openModal(`
    <h2>一句话创建 bot</h2>
    <textarea id="mb-input" placeholder="例如：创建 bot：翻译助手，用 claude 模型，风格活泼">创建 bot：灵感助手，用 deepseek-chat 模型，风格活泼</textarea>
    <div class="hint">也可以说「创建 bot：一只负责提醒我的小狐狸」——名字、角色、模型会自动解析。</div>
    <div class="actions">
      <button class="link-btn" id="mb-import">导入别人分享的 bot…</button>
      <button class="ghost-btn" id="mb-cancel">取消</button>
      <button class="primary-btn" id="mb-ok">创建</button>
    </div>`);
  modal.querySelector("#mb-ok").onclick = async () => {
    const text = modal.querySelector("#mb-input").value.trim();
    if (!text) return;
    const bot = await api.bots.create(text, { avatar: randomAvatar() });
    closeModal();
    await refreshBots();
    selectBot(bot);
  };
  modal.querySelector("#mb-cancel").onclick = closeModal;
  modal.querySelector("#mb-import").onclick = () => importBotFlow();
}

async function personaFlow() {
  if (!currentBot) return;
  const botId = currentBot.id;
  const modal = openModal(`
    <h2>一句话生成形象 — ${esc(currentBot.name)}</h2>
    <input id="mp-input" placeholder="例如：一只蓝色狐狸，可爱，戴眼镜" value="一只蓝色狐狸，可爱" />
    <div class="hint">会生成头像（本地文件）与角色卡；未配置图片模型时用程序化 SVG 头像，不阻塞。</div>
    <div class="actions">
      <button class="ghost-btn" id="mp-cancel">取消</button>
      <button class="primary-btn" id="mp-ok">生成</button>
    </div>`);
  modal.querySelector("#mp-ok").onclick = async () => {
    const desc = modal.querySelector("#mp-input").value.trim();
    const ok = modal.querySelector("#mp-ok");
    ok.disabled = true;
    ok.textContent = "生成中…";
    try {
      await api.persona.generate(botId, desc || "一只蓝色狐狸，可爱");
      closeModal();
      await refreshBots();
      const nb = bots.find((x) => x.id === botId);
      if (nb) selectBot(nb);
    } catch (e) {
      ok.disabled = false;
      ok.textContent = "生成";
      alert(`生成失败：${String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")}`);
    }
  };
  modal.querySelector("#mp-cancel").onclick = closeModal;
}

function isDefaultProvider(p, providers) {
  return providers.some((x) => x.isDefault) ? !!p.isDefault : providers[0]?.id === p.id;
}

/** bot 实际使用的 provider：绑定的存在就用它，否则跟随默认 */
function effectiveProvider(b, providers) {
  return providers.find((p) => p.id === b.providerId) ?? providers.find((p) => isDefaultProvider(p, providers));
}
