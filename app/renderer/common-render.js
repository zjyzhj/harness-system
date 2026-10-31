/**
 * 共用渲染器 — 面板与宠物窗口同源。
 * 纯函数 + 白名单转义，无 DOM 依赖，可被任意 renderer 脚本加载。
 */
/** 本地绝对路径 → file URL（路径含空格/#/? 时必须编码，如 ~/Library/Application Support） */
function fileUrl(path) {
  return "file://" + encodeURI(path).replace(/#/g, "%23").replace(/\?/g, "%3F");
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** 内容块列表 → HTML（text/code/image/tool_call/file/thinking） */
function renderBlocks(blocks) {
  if (!Array.isArray(blocks)) return renderMarkdown(esc(String(blocks ?? "")));
  return blocks.map(renderBlock).join("");
}

function renderBlock(b) {
  switch (b.type) {
    case "text": return renderMarkdown(esc(b.text ?? ""));
    case "code": return `<pre class="code-block"><code${b.lang ? ` class="lang-${esc(b.lang)}"` : ""}>${esc(b.code)}</code></pre>`;
    case "image": {
      const src = b.dataUrl || (b.url || (b.path ? fileUrl(b.path) : ""));
      return src ? `<img class="msg-img" src="${esc(src)}" alt="${esc(b.alt || "image")}" />` : "";
    }
    case "tool_call": {
      const args = b.args ? `<div class="tool-args">${esc(JSON.stringify(b.args))}</div>` : "";
      const status = b.status ? `<span class="tool-status ${esc(b.status)}">${esc(b.status)}</span>` : "";
      const result = b.result ? `<div class="tool-result">${esc(b.result)}</div>` : "";
      const demo = typeof b.tool === "string" && b.tool.startsWith("demo.");
      const icon = demo ? "🎬" : "🛠";
      const klass = demo ? "tool-card demo-tool" : "tool-card";
      return `<div class="${klass}"><div class="tool-head">${icon} ${esc(b.tool)} ${status}</div>${args}${result}</div>`;
    }
    case "file": return `<div class="file-card">📎 ${esc(b.name || b.path)}${b.size ? ` <span class="hint">${formatBytes(b.size)}</span>` : ""}</div>`;
    case "thinking": return thinkHtml(b);
    default: return "";
  }
}

/** 思考过程：默认折叠成一行「已深度思考 N 秒」，展开看全文 */
function thinkSecs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "不到 1 秒";
  if (n < 1000) return "不到 1 秒";
  // 用向下取整，避免 1.4s 被四舍五入成「2 秒」
  const s = Math.floor(n / 1000);
  return s < 10 ? `${(n / 1000).toFixed(1)} 秒` : `${s} 秒`;
}

/** 整轮耗时（含工具），不要跟「深度思考」混淆 */
function fmtLatency(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1000) return `整轮 ${Math.round(n)}ms`;
  if (n < 10_000) return `整轮 ${(n / 1000).toFixed(1)}s`;
  return `整轮 ${Math.round(n / 1000)}s`;
}

function thinkHtml(b, live) {
  let ms = Number(b?.ms);
  // 正文很长但 ms<1s：多半是旧数据/一次性吐出的错误计时，宁可只显示「已深度思考」也不误导
  if (Number.isFinite(ms) && ms > 0 && ms < 1000 && (b?.text?.length ?? 0) > 80) ms = NaN;
  const hasMs = Number.isFinite(ms) && ms > 0;
  const label = live ? "正在思考" : `已深度思考${hasMs ? ` ${thinkSecs(ms)}` : ""}`;
  return `<details class="think-box${live ? " live" : ""}"${live ? " open" : ""}><summary><span class="tb-ico">💭</span><span class="tb-label">${label}</span>${live ? `<span class="dots"></span>` : ""}<span class="tb-arrow">›</span></summary><div class="tb-body">${esc(b.text ?? "")}</div></details>`;
}

/** 正文里的 [1] [2] → 指向来源的角标（sources 是本条回复的来源列表） */
function citeLinks(html, sources) {
  if (!sources || !sources.length) return html;
  return html.replace(/\[(\d{1,2})\](?![(\]])/g, (m, n) => {
    const s = sources[Number(n) - 1];
    if (!s) return m;
    let host = s.url;
    try { host = new URL(s.url).hostname.replace(/^www\./, ""); } catch { /* 保留原样 */ }
    return `<a class="cite" href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.title)} · ${esc(host)}">${n}</a>`;
  });
}

/** 软件内引用 [文字](app:类型/标识) → 可点的彩色标签；label / id 已转义 */
const REF_ICON = { skill: "🧩", bot: "🤖", group: "👥", file: "📄", project: "📁", settings: "⚙️", task: "⏰", memory: "🧠" };
function refHtml(type, id, label) {
  const icon = REF_ICON[type];
  if (!icon) return label;
  return `<a class="ref ref-${type}" data-ref="${type}" data-id="${id}" title="点击打开"><span class="ref-ico">${icon}</span>${label}</a>`;
}

/** 轻量 markdown 子集：行内 code / 粗斜体 / 链接 / 代码块 / 标题 / 列表 / 引用。src 须已 esc() 转义 */
function renderMarkdown(src) {
  if (!src) return "";
  const lines = src.split(/\n/);
  let out = "", i = 0, inCode = false, codeBuf = [], codeLang = "";
  const inline = (t) => t
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(app:([a-z]+)\/([^)]+)\)/g, (_, label, type, id) => refHtml(type, id, label))
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  let list = null;
  const closeList = () => { if (list) { out += `</${list}>`; list = null; } };
  const openList = (tag) => { if (list !== tag) { closeList(); out += `<${tag}>`; list = tag; } };
  const cells = (row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const isTableSep = (row) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(row ?? "");
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      closeList();
      if (!inCode) { inCode = true; codeBuf = []; codeLang = line.slice(3).trim(); }
      else { inCode = false; out += `<pre class="code-block"><code${codeLang ? ` class="lang-${codeLang}"` : ""}>${codeBuf.join("\n")}</code></pre>`; }
      i++; continue;
    }
    if (inCode) { codeBuf.push(line); i++; continue; }
    if (line.includes("|") && isTableSep(lines[i + 1])) {
      closeList();
      const head = cells(line);
      i += 2;
      let body = "";
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        body += `<tr>${cells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`;
        i++;
      }
      out += `<table class="md-table"><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table>`;
      continue;
    }
    if (/^\s*[-*]\s/.test(line)) { openList("ul"); out += `<li>${inline(line.replace(/^\s*[-*]\s/, ""))}</li>`; i++; continue; }
    if (/^\s*\d+\.\s/.test(line)) { openList("ol"); out += `<li>${inline(line.replace(/^\s*\d+\.\s/, ""))}</li>`; i++; continue; }
    closeList();
    if (/^###\s/.test(line)) { out += `<h3>${inline(line.slice(4))}</h3>`; }
    else if (/^##\s/.test(line)) { out += `<h2>${inline(line.slice(3))}</h2>`; }
    else if (/^#\s/.test(line)) { out += `<h1>${inline(line.slice(2))}</h1>`; }
    else if (/^>\s?/.test(line)) { out += `<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`; }
    else if (/^-{3,}$/.test(line.trim())) { out += "<hr/>"; }
    else if (!line.trim()) { out += "<br/>"; }
    else { out += `<p>${inline(line)}</p>`; }
    i++;
  }
  closeList();
  if (inCode) out += `<pre class="code-block"><code>${codeBuf.join("\n")}</code></pre>`;
  return out;
}

function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

/** 输入浮层（替代 window.prompt —— Electron 沙箱渲染进程不支持 prompt()）。
 * 返回 Promise<string | null>：确定返回输入值（空串返回 null），取消返回 null。
 */
function askInput(label, placeholder, defaultValue) {
  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "ask-input-mask";
    mask.innerHTML = `
      <div class="ask-input-box">
        <div class="ask-input-label">${esc(label)}</div>
        <input class="ask-input-field" type="text" placeholder="${esc(placeholder || "")}" value="${esc(defaultValue || "")}" />
        <div class="ask-input-actions">
          <button class="ghost-btn ask-input-cancel">取消</button>
          <button class="primary-btn ask-input-ok">确定</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    const input = mask.querySelector(".ask-input-field");
    const done = (val) => { mask.remove(); resolve(val); };
    mask.querySelector(".ask-input-ok").onclick = () => done(input.value.trim() || null);
    mask.querySelector(".ask-input-cancel").onclick = () => done(null);
    mask.onclick = (e) => { if (e.target === mask) done(null); };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") done(input.value.trim() || null); if (e.key === "Escape") done(null); });
    input.focus();
    input.select();
  });
}
