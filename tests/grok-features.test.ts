import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { thinkSplitter } from "../core/adapters/openai-compat";
import { parseBing, readableText } from "../core/web-search";
import { attachmentPrompt, extractText, ingestFiles, type FileBlock } from "../core/attachments";
import { ProjectRegistry, instructionsPrompt } from "../core/projects";
import { linkCitations } from "../core/share-page";

const dir = mkdtempSync(join(tmpdir(), "grok-feat-"));

function split(chunks: string[]) {
  const out: [string, string][] = [];
  const s = thinkSplitter((k, t) => {
    const last = out[out.length - 1];
    if (last && last[0] === k) last[1] += t; else out.push([k, t]);
  });
  chunks.forEach((c) => s.push(c));
  s.end();
  return out;
}

/** 手写一个最小 PDF（带正确的 xref 偏移） */
function tinyPdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 50 700 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

describe("深度思考", () => {
  test("开头的 <think> 被拆成思考，标签跨增量也能识别", () => {
    expect(split(["<thi", "nk>先想", "想</th", "ink>\n\n答案是 42"])).toEqual([["thinking", "先想想"], ["text", "答案是 42"]]);
  });
  test("正文中间的 <think> 当普通文字", () => {
    expect(split(["你好 <think>x</think>"])).toEqual([["text", "你好 <think>x</think>"]]);
  });
  test("没闭合的思考在结束时全部吐出", () => {
    expect(split(["<think>想到一半"])).toEqual([["thinking", "想到一半"]]);
  });
});

describe("联网搜索", () => {
  test("Bing 结果解析：解 base64 跳转地址、去标签和日期前缀", () => {
    const real = "https://example.com/a?b=1";
    const u = "a1" + Buffer.from(real).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const html = `<ol><li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=x&amp;u=${u}&amp;ntb=1">Example <strong>站点</strong></a></h2>
      <div class="b_caption"><p>2026年10月1日 · 这是 &amp; 摘要</p></div></li>
      <li class="b_algo"><h2><a href="javascript:void(0)">坏链接</a></h2></li></ol>`;
    expect(parseBing(html)).toEqual([{ title: "Example 站点", url: real, snippet: "这是 & 摘要" }]);
  });
  test("网页正文提取去掉脚本和导航", () => {
    const r = readableText("<html><head><title>标题 &amp; X</title><script>evil()</script></head><body><nav>菜单</nav><p>正文第一段</p></body></html>");
    expect(r.title).toBe("标题 & X");
    expect(r.text).toContain("正文第一段");
    expect(r.text).not.toContain("evil");
  });
  test("[n] 变成来源角标，越界的保持原样，链接语法不动", () => {
    const html = linkCitations("A[1] B[3] [link](x) C[2]", [{ url: "https://a.com/1" }, { url: "https://www.b.org/2" }]);
    expect(html).toContain('href="https://a.com/1"');
    expect(html).toContain('title="b.org"');
    expect(html).toContain("B[3]");
    expect(html).toContain("[link](x)");
  });
});

describe("文件附件", () => {
  test("PDF / Word / 表格 / 代码都能抽出文字", async () => {
    const pdf = join(dir, "a.pdf");
    writeFileSync(pdf, tinyPdf("Hello PDF World"));
    expect(await extractText(pdf)).toContain("Hello PDF World");

    const txt = join(dir, "w.txt");
    writeFileSync(txt, "合同第一条：甲方付款");
    execFileSync("textutil", ["-convert", "docx", "-output", join(dir, "w.docx"), txt]);
    expect(await extractText(join(dir, "w.docx"))).toContain("甲方付款");

    const x = join(dir, "x");
    execFileSync("python3", ["-c", `
import zipfile
z = zipfile.ZipFile(${JSON.stringify(join(dir, "t.xlsx"))}, "w")
z.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
z.writestr("xl/workbook.xml", '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="r"><sheets><sheet name="销售" sheetId="1" r:id="rId1"/></sheets></workbook>')
z.writestr("xl/sharedStrings.xml", '<sst><si><t>产品</t></si><si><t>苹果</t></si></sst>')
z.writestr("xl/worksheets/sheet1.xml", '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>9</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>120</v></c></row></sheetData></worksheet>')
z.close()`]);
    const xs = await extractText(join(dir, "t.xlsx"));
    expect(xs).toContain("苹果");
    expect(xs).toContain("120");

    writeFileSync(x + ".ts", "export const answer = 42;\n");
    expect(await extractText(x + ".ts")).toContain("answer = 42");
    writeFileSync(x + ".bin", Buffer.from([0, 1, 2, 3]));
    expect(await extractText(x + ".bin")).toBeNull();
  });

  test("收进附件目录：图片变 image 块，文档带全文路径，长文截断提示 fs.read", async () => {
    writeFileSync(join(dir, "p.png"), Buffer.from([0x89, 0x50]));
    writeFileSync(join(dir, "long.md"), "字".repeat(40_000));
    const blocks = await ingestFiles([join(dir, "p.png"), join(dir, "long.md"), join(dir, "nope.txt")], join(dir, "att"));
    expect(blocks.map((b) => b.type)).toEqual(["image", "file"]);
    const f = blocks[1] as FileBlock;
    expect(f.chars).toBe(40_000);
    const p = attachmentPrompt(f);
    expect(p).toContain("fs.read");
    expect(p).toContain(f.textPath!);
  });
});

describe("项目与自定义指令", () => {
  test("全局指令 + 项目指令 + 项目资料进系统提示，资料超预算时给出全文路径", async () => {
    const reg = new ProjectRegistry(join(dir, "home"));
    const p = reg.create("提审", "回答都用表格");
    writeFileSync(join(dir, "spec.md"), "截图尺寸 1320×2868");
    await reg.addFiles(p.id, [join(dir, "spec.md")]);
    const got = reg.get(p.id)!;
    const prompt = instructionsPrompt({ about: "我是 iOS 开发", style: "简洁" }, got);
    expect(prompt).toContain("我是 iOS 开发");
    expect(prompt).toContain("【当前项目：提审】");
    expect(prompt).toContain("回答都用表格");
    expect(prompt).toContain("1320×2868");
    expect(new ProjectRegistry(join(dir, "home")).list().map((x) => x.name)).toEqual(["提审"]);
    expect(instructionsPrompt(undefined, null)).toBe("");
  });
});
