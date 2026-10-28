/**
 * 对话附件：把用户发来的文件复制进工作区，并抽出可读文本（PDF / Word / 表格 / 幻灯片 / 代码）。
 * 抽取只用 macOS 自带能力（PDFKit、textutil、unzip），不引入依赖。
 */
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { ContentBlock } from "./types";

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|bmp)$/i;
const PLAIN_EXT = /\.(md|markdown|txt|log|json|jsonl|ya?ml|csv|tsv|xml|plist|toml|ini|env|sql|html?|css|scss|less|js|mjs|cjs|ts|tsx|jsx|vue|svelte|py|rb|go|rs|java|kt|kts|swift|m|mm|h|hpp|c|cc|cpp|cs|php|dart|lua|r|pl|sh|zsh|bash|fish|gradle|dockerfile|makefile|gitignore|srt|vtt|tex|bib|rst|adoc)$/i;
const TEXTUTIL_EXT = /\.(docx?|rtf|rtfd|odt|wordml|webarchive)$/i;
/** 单个附件抽取文本的存盘上限 */
const MAX_TEXT = 2_000_000;
/** 每个附件随消息发给模型的上限；更长的留在 .txt 里让 bot 用 fs.read 翻 */
export const INLINE_CHARS = 30_000;

const run = (cmd: string, args: string[], timeout = 30_000) =>
  new Promise<string>((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message));
      else resolve(stdout);
    });
  });

const xmlText = (s: string) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");

async function pdfText(path: string): Promise<string> {
  const script = `ObjC.import("PDFKit");
var d = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(${JSON.stringify(path)}));
var out = [];
if (d) for (var i = 0; i < d.pageCount; i++) { var p = d.pageAtIndex(i); out.push("—— 第 " + (i + 1) + " 页 ——\\n" + (p.string.js || "")); }
out.join("\\n\\n");`;
  return run("osascript", ["-l", "JavaScript", "-e", script], 60_000);
}

/** 列名：0 → A，26 → AA */
const colName = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : colName(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));
const colIndex = (ref: string) => [...ref.replace(/\d+/g, "")].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

async function xlsxText(path: string): Promise<string> {
  const list = await run("unzip", ["-Z1", path]);
  const files = list.split("\n").map((s) => s.trim());
  const shared: string[] = [];
  if (files.includes("xl/sharedStrings.xml")) {
    const xml = await run("unzip", ["-p", path, "xl/sharedStrings.xml"]);
    for (const si of xml.match(/<si>[\s\S]*?<\/si>/g) ?? []) shared.push(xmlText((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join("")));
  }
  const names: string[] = [];
  if (files.includes("xl/workbook.xml")) {
    const wb = await run("unzip", ["-p", path, "xl/workbook.xml"]);
    for (const m of wb.matchAll(/<sheet [^>]*name="([^"]+)"/g)) names.push(xmlText(m[1]));
  }
  const sheets = files.filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const out: string[] = [];
  for (const [i, f] of sheets.entries()) {
    const xml = await run("unzip", ["-p", path, f]);
    const rows: string[] = [];
    for (const row of xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? []) {
      const cells: string[] = [];
      for (const c of row.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
        const ref = c.match(/ r="([A-Z]+\d+)"/)?.[1];
        const type = c.match(/ t="(\w+)"/)?.[1];
        const v = c.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        const inline = c.match(/<is>([\s\S]*?)<\/is>/)?.[1];
        let val = type === "s" && v !== undefined ? shared[Number(v)] ?? "" : inline ? xmlText(inline.replace(/<[^>]+>/g, "")) : v !== undefined ? xmlText(v) : "";
        if (/[,"\n]/.test(val)) val = `"${val.replace(/"/g, '""')}"`;
        const at = ref ? colIndex(ref) : cells.length;
        while (cells.length < at) cells.push("");
        cells[at] = val;
      }
      if (cells.some(Boolean)) rows.push(cells.join(","));
    }
    out.push(`## 工作表 ${names[i] ?? i + 1}（${rows.length} 行${rows[0] ? `，${rows[0].split(",").length} 列：${colName(0)}–${colName(rows[0].split(",").length - 1)}` : ""}）\n${rows.join("\n")}`);
  }
  return out.join("\n\n");
}

async function pptxText(path: string): Promise<string> {
  const list = await run("unzip", ["-Z1", path]);
  const slides = list.split("\n").map((s) => s.trim()).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const out: string[] = [];
  for (const [i, f] of slides.entries()) {
    const xml = await run("unzip", ["-p", path, f]);
    const paras = (xml.match(/<a:p>[\s\S]*?<\/a:p>/g) ?? []).map((p) => xmlText((p.match(/<a:t>([\s\S]*?)<\/a:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join(""))).filter(Boolean);
    out.push(`—— 第 ${i + 1} 页 ——\n${paras.join("\n")}`);
  }
  return out.join("\n\n");
}

/** 抽取文件的可读文本；不支持的格式返回 null */
export async function extractText(path: string): Promise<string | null> {
  const ext = extname(path).toLowerCase();
  const name = basename(path).toLowerCase();
  let text: string | null = null;
  if (ext === ".pdf") text = await pdfText(path);
  else if (ext === ".xlsx" || ext === ".xlsm") text = await xlsxText(path);
  else if (ext === ".pptx") text = await pptxText(path);
  else if (TEXTUTIL_EXT.test(path)) text = await run("textutil", ["-convert", "txt", "-stdout", path]);
  else if (PLAIN_EXT.test(path) || ["dockerfile", "makefile", "readme", "license"].includes(name)) {
    const buf = readFileSync(path);
    if (buf.subarray(0, 8000).includes(0)) return null;
    text = buf.toString("utf8");
  }
  if (text === null) return null;
  text = text.replace(/\r\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
}

export type FileBlock = Extract<ContentBlock, { type: "file" }>;

/** 把本机文件收进附件目录，抽好文本；图片返回 image 块 */
export async function ingestFiles(paths: string[], destDir: string): Promise<ContentBlock[]> {
  mkdirSync(join(destDir, ".text"), { recursive: true });
  const out: ContentBlock[] = [];
  for (const src of paths) {
    if (!existsSync(src) || !statSync(src).isFile()) continue;
    const name = basename(src);
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const dest = join(destDir, `${stamp}-${name}`);
    copyFileSync(src, dest);
    if (IMAGE_EXT.test(name)) { out.push({ type: "image", path: dest, alt: name }); continue; }
    const block: FileBlock = { type: "file", path: dest, name, size: statSync(dest).size };
    try {
      const text = await extractText(dest);
      if (text) {
        const textPath = join(destDir, ".text", `${stamp}-${name}.txt`);
        writeFileSync(textPath, text, "utf8");
        block.textPath = textPath;
        block.chars = text.length;
      }
    } catch (e) {
      block.error = `无法读取内容：${e instanceof Error ? e.message.slice(0, 120) : String(e)}`;
    }
    out.push(block);
  }
  return out;
}

/** 附件发给模型时的文字：正文（截断）+ 全文位置 */
export function attachmentPrompt(b: FileBlock): string {
  if (!b.textPath || !existsSync(b.textPath)) return `【附件：${b.name}】${b.error ? `（${b.error}）` : "（这个格式读不出文字，只能告诉用户文件已收到）"}`;
  const text = readFileSync(b.textPath, "utf8");
  const cut = text.length > INLINE_CHARS;
  return `【附件：${b.name}，共 ${text.length} 字${cut ? `，下面只是前 ${INLINE_CHARS} 字，全文在 ${b.textPath}，需要时用 fs.read 读` : ""}】\n<<<\n${cut ? text.slice(0, INLINE_CHARS) : text}\n>>>`;
}
