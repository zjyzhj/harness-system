/**
 * 共用渲染器 — 面板与宠物窗口同源。
 * 纯函数 + 白名单转义，无 DOM 依赖，可被任意 renderer 脚本加载。
 */
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
      const src = b.dataUrl || (b.url || (b.path ? `file://${b.path}` : ""));
      return src ? `<img class="msg-img" src="${esc(src)}" alt="${esc(b.alt || "image")}" />` : "";
    }
    case "tool_call": {
      const args = b.args ? `<div class="tool-args">${esc(JSON.stringify(b.args))}</div>` : "";
      const status = b.status ? `<span class="tool-status ${esc(b.status)}">${esc(b.status)}</span>` : "";
      const result = b.result ? `<div class="tool-result">${esc(b.result)}</div>` : "";
      return `<div class="tool-card"><div class="tool-head">🛠 ${esc(b.tool)} ${status}</div>${args}${result}</div>`;
    }
    case "file": return `<div class="file-card">📎 ${esc(b.name || b.path)}${b.size ? ` <span class="hint">${formatBytes(b.size)}</span>` : ""}</div>`;
    case "thinking": return `<details class="thinking"><summary>💭 思考中…</summary><div>${renderMarkdown(esc(b.text))}</div></details>`;
    default: return "";
  }
}

/** 轻量 markdown 子集：行内 code / 粗斜体 / 链接 / 代码块 / 标题 / 列表 / 引用 */
function renderMarkdown(src) {
  if (!src) return "";
  const lines = src.split(/\n/);
  let out = "", i = 0, inCode = false, codeBuf = [], codeLang = "";
  const inline = (t) => t
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      if (!inCode) { inCode = true; codeBuf = []; codeLang = line.slice(3).trim(); }
      else { inCode = false; out += `<pre class="code-block"><code${codeLang ? ` class="lang-${esc(codeLang)}"` : ""}>${esc(codeBuf.join("\n"))}</code></pre>`; }
      i++; continue;
    }
    if (inCode) { codeBuf.push(line); i++; continue; }
    if (/^###\s/.test(line)) { out += `<h3>${inline(line.slice(4))}</h3>`; }
    else if (/^##\s/.test(line)) { out += `<h2>${inline(line.slice(3))}</h2>`; }
    else if (/^#\s/.test(line)) { out += `<h1>${inline(line.slice(2))}</h1>`; }
    else if (/^[-*]\s/.test(line)) { out += `<li>${inline(line.replace(/^[-*]\s/, ""))}</li>`; }
    else if (/^>\s?/.test(line)) { out += `<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`; }
    else if (/^\d+\.\s/.test(line)) { out += `<li class="ol">${inline(line.replace(/^\d+\.\s/, ""))}</li>`; }
    else if (!line.trim()) { out += "<br/>"; }
    else { out += `<p>${inline(line)}</p>`; }
    i++;
  }
  if (inCode) out += `<pre class="code-block"><code>${esc(codeBuf.join("\n"))}</code></pre>`;
  return out;
}

function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}
