/**
 * 分享：把一段对话渲染成独立 HTML（图片内嵌成 data URL，不依赖本机文件），
 * 网页分享直接保存它，长图分享在隐藏窗口里打开它再截图。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { ChatMessage, ContentBlock } from "./types";

export interface ShareRender {
  /** 已转义文本 → HTML（共用渲染器的 renderMarkdown） */
  markdown: (escaped: string) => string;
  esc: (s: string) => string;
}

export interface ShareInput {
  title: string;
  messages: ChatMessage[];
  nameOf: (id: string) => string;
  /** 头像 data URL（没有时用首字） */
  avatarOf?: (id: string) => string | null;
  /** 长图模式：去掉网页里的交互（折叠展开） */
  forImage?: boolean;
}

const IMG_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp" };
const MAX_INLINE_IMAGE = 4 * 1024 * 1024;

function imageSrc(b: Extract<ContentBlock, { type: "image" }>): string | null {
  if (b.dataUrl) return b.dataUrl;
  if (b.url && /^https?:/.test(b.url)) return b.url;
  if (b.path && existsSync(b.path) && statSync(b.path).size <= MAX_INLINE_IMAGE) {
    return `data:${IMG_MIME[extname(b.path).toLowerCase()] ?? "image/png"};base64,${readFileSync(b.path).toString("base64")}`;
  }
  return null;
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font:14px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif;color:#1d1d1f;background:#f6f6f4}
.page{max-width:760px;margin:0 auto;padding:28px 24px 20px;background:#fff;min-height:100vh}
.img .page{min-height:0}
header{display:flex;align-items:center;gap:10px;padding-bottom:16px;margin-bottom:18px;border-bottom:1px solid #ecece8}
header h1{font-size:18px;font-weight:700;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
header .date{font-size:12px;color:#8a8a86}
.msg{display:flex;gap:10px;margin:0 0 16px}
.msg.user{flex-direction:row-reverse}
.av{width:30px;height:30px;border-radius:50%;flex:none;background:#efefec;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;color:#555;overflow:hidden}
.av img{width:100%;height:100%;object-fit:cover}
.col{max-width:82%;min-width:0;display:flex;flex-direction:column;gap:6px}
.user .col{align-items:flex-end}
.who{font-size:11.5px;color:#8a8a86}
.bubble{padding:10px 14px;border-radius:16px;background:#f1f1ef;white-space:pre-wrap;word-break:break-word}
.user .bubble{background:#2f8f4e;color:#fff}
.inbound .bubble{background:#eef3fb;border:1px solid #c9daf0;border-radius:16px 16px 16px 6px}
.inbound .av{background:#d9e6f8;color:#3559c7}
.bubble p,.bubble li{margin:2px 0}
.bubble ul,.bubble ol{padding-left:20px;white-space:normal}
.bubble h1,.bubble h2,.bubble h3{font-size:15px;margin:6px 0 2px}
.bubble code{background:rgba(0,0,0,.06);padding:1px 5px;border-radius:5px;font:12.5px Menlo,monospace}
.user .bubble code{background:rgba(255,255,255,.2)}
.bubble pre{background:#f6f6f3;border:1px solid #ececea;border-radius:10px;padding:10px 12px;overflow-x:auto;white-space:pre;margin:6px 0}
.bubble pre code{background:none;padding:0}
.bubble blockquote{border-left:3px solid #d8d8d3;padding-left:10px;color:#666}
.bubble a{color:#2f8f4e}
.bubble table{border-collapse:collapse;margin:6px 0;white-space:normal}
.bubble td,.bubble th{border:1px solid #e0e0dc;padding:4px 8px;font-size:13px}
.bubble br{display:none}
a.ref{color:#1f7a4d;font-weight:500;text-decoration:none}
sup.cite a{font-size:10px;color:#2f8f4e;text-decoration:none;background:#e9f4ec;border-radius:6px;padding:0 4px;margin:0 1px}
details.think{font-size:12.5px;color:#777;border-left:2px solid #e2e2de;padding:2px 0 2px 10px}
details.think summary{cursor:pointer;list-style:none}
details.think div{white-space:pre-wrap;margin-top:4px}
.acts{font-size:12px;color:#8a8a86;display:flex;flex-direction:column;gap:2px}
.gallery{display:flex;flex-wrap:wrap;gap:6px}
.gallery img{max-width:240px;max-height:240px;border-radius:12px;border:1px solid #ececea;object-fit:cover}
.file{display:inline-flex;gap:6px;align-items:center;font-size:12.5px;border:1px solid #e4e4e0;border-radius:10px;padding:6px 10px;background:#fff}
.sources{display:flex;flex-direction:column;gap:4px;font-size:12px;border:1px solid #ecece8;border-radius:12px;padding:8px 10px;background:#fafaf8}
.sources a{color:#1d1d1f;text-decoration:none;display:flex;gap:6px}
.sources .n{color:#2f8f4e;font-weight:600;flex:none}
.sources .host{color:#8a8a86;flex:none}
.sources .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card{border:1px solid #e4e4e0;border-radius:12px;padding:10px 12px;font-size:13px;background:#fff}
.card b{display:block;margin-bottom:4px}
.card .ans{color:#2f8f4e;margin-top:4px}
.event{text-align:center;font-size:12px;color:#8a8a86;margin:0 0 14px}
footer{text-align:center;font-size:11.5px;color:#a0a09c;padding:14px 0 4px;border-top:1px solid #ecece8;margin-top:8px}
`;

const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };

/** 正文里的 [1] [2] → 指向来源的小角标 */
export function linkCitations(html: string, sources: { url: string }[]): string {
  if (!sources.length) return html;
  return html.replace(/\[(\d{1,2})\](?![(\]])/g, (m, n) => {
    const s = sources[Number(n) - 1];
    return s ? `<sup class="cite"><a href="${s.url.replace(/"/g, "&quot;")}" target="_blank" rel="noopener" title="${host(s.url)}">${n}</a></sup>` : m;
  });
}

function blocksHtml(blocks: ContentBlock[], r: ShareRender, forImage: boolean): string {
  const sources = (blocks.find((b) => b.type === "sources") as Extract<ContentBlock, { type: "sources" }> | undefined)?.items ?? [];
  const out: string[] = [];
  const images: string[] = [];
  const acts: string[] = [];
  const flushActs = () => { if (acts.length) out.push(`<div class="acts">${acts.splice(0).join("")}</div>`); };
  for (const b of blocks) {
    if (b.type !== "tool_call") flushActs();
    switch (b.type) {
      case "text": {
        const t = b.text.replace(/```tool[\s\S]*?(```|$)/g, "").trim();
        if (t) out.push(`<div class="bubble">${linkCitations(r.markdown(r.esc(t)), sources)}</div>`);
        break;
      }
      case "thinking":
        if (!forImage) out.push(`<details class="think"><summary>💭 思考过程${b.ms ? `（${Math.round(b.ms / 1000)} 秒）` : ""}</summary><div>${r.esc(b.text)}</div></details>`);
        else out.push(`<details class="think"><summary>💭 已深度思考${b.ms ? ` ${b.ms < 1000 ? "不到 1" : Math.round(b.ms / 1000)} 秒` : ""}</summary></details>`);
        break;
      case "tool_call":
        if (b.tool === "bot.ask") {
          const to = r.esc(String(b.args?.to ?? "bot"));
          flushActs();
          out.push(`<div class="acts b2b">💬 已发消息给 <b>${to}</b>${b.result ? `<br/>↩ 收到 <b>${to}</b> 的回复` : ""}</div>`);
          break;
        }
        acts.push(`<div>🛠 ${r.esc(b.tool)}${b.args?.query ? ` · ${r.esc(String(b.args.query))}` : b.args?.url ? ` · ${r.esc(host(String(b.args.url)))}` : ""}</div>`);
        break;
      case "image": {
        const src = imageSrc(b);
        if (src) images.push(`<img src="${src}" alt="${r.esc(b.alt ?? "")}" />`);
        break;
      }
      case "file":
        out.push(`<div class="file">📎 ${r.esc(b.name)}</div>`);
        break;
      case "code":
        out.push(`<div class="bubble"><pre><code>${r.esc(b.code)}</code></pre></div>`);
        break;
      case "choice":
        out.push(`<div class="card"><b>${b.mode === "confirm" ? "⚠️ " : "❓ "}${r.esc(b.question)}</b>${b.mode === "confirm" ? "" : b.options.map((o, i) => `<div>${String.fromCharCode(65 + i)}. ${r.esc(o)}</div>`).join("")}${b.answer ? `<div class="ans">已选：${r.esc(b.answer)}</div>` : ""}</div>`);
        break;
      case "conclusion":
        out.push(`<div class="card"><b>📋 讨论结论</b>${r.esc(b.summary)}${b.decisions.map((d) => `<div>· ${r.esc(d)}</div>`).join("")}${b.tasks.map((t) => `<div>· ${r.esc(t.owner)}：${r.esc(t.task)}</div>`).join("")}</div>`);
        break;
      case "sources":
        out.push(`<div class="sources">${b.items.map((s, i) => `<a href="${r.esc(s.url)}" target="_blank" rel="noopener"><span class="n">${i + 1}</span><span class="host">${r.esc(host(s.url))}</span><span class="t">${r.esc(s.title)}</span></a>`).join("")}</div>`);
        break;
    }
  }
  flushActs();
  if (images.length) out.push(`<div class="gallery">${images.join("")}</div>`);
  return out.join("");
}

export function buildShareHtml(input: ShareInput, r: ShareRender): string {
  const rows: string[] = [];
  for (const m of input.messages) {
    if (m.kind === "event") {
      if (typeof m.content === "string" && !/授权|批准|拒绝/.test(m.content)) rows.push(`<div class="event">${r.esc(m.content)}</div>`);
      continue;
    }
    const blocks: ContentBlock[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    const body = blocksHtml(blocks, r, !!input.forImage);
    if (!body) continue;
    const isInbound = m.from === "webhook" || m.from === "inbound" || (!!(m.meta as { webhook?: boolean } | undefined)?.webhook && m.role === "user");
    const isUser = m.from === "user" && !isInbound;
    const name = isUser ? "我" : isInbound ? "Webhook 入站" : input.nameOf(m.from);
    const av = isInbound ? null : input.avatarOf?.(m.from);
    const cls = isInbound ? "inbound" : isUser ? "user" : "bot";
    rows.push(`<div class="msg ${cls}"><div class="av">${av ? `<img src="${av}" />` : r.esc(name.slice(0, 1))}</div><div class="col">${isUser ? "" : `<div class="who">${r.esc(name)}</div>`}${body}</div></div>`);
  }
  const first = input.messages[0]?.createdAt ?? Date.now();
  const date = new Date(first).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${r.esc(input.title)}</title><style>${CSS}</style></head>
<body class="${input.forImage ? "img" : ""}"><div class="page"><header><h1>${r.esc(input.title)}</h1><span class="date">${date}</span></header>${rows.join("\n")}<footer>由 Harness Bot 分享</footer></div></body></html>`;
}
