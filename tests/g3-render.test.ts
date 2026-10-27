import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

// 用 VM 加载 common-render.js，确保纯函数无 DOM 依赖且输出一致
const src = readFileSync(join(import.meta.dir, "../app/renderer/common-render.js"), "utf8");
const sandbox: Record<string, any> = {};
runInNewContext(src, sandbox);
const { esc, renderBlocks, renderMarkdown, formatBytes } = sandbox;

describe("G3 common-render", () => {
  test("T3.2a renderBlocks 同一输入输出稳定（快照）", () => {
    const blocks = [
      { type: "text", text: "你好 **世界**" },
      { type: "tool_call", tool: "fs.read", args: { path: "a.txt" }, result: "内容", status: "ok" },
      { type: "code", code: "const x = 1;", lang: "ts" },
    ];
    const out = renderBlocks(blocks);
    expect(out).toContain("<strong>世界</strong>");
    expect(out).toContain("tool-card");
    expect(out).toContain('class="lang-ts"');
    expect(out).toContain("<pre class=\"code-block\">");
  });

  test("T3.2b 转义安全：入口先转义，注入不产生标签", () => {
    const evil = "<script>alert(1)</script> & \"x\"";
    // renderMarkdown 约定输入已转义（与面板 renderer.js 同源）
    expect(esc(evil)).not.toContain("<script>");
    expect(renderMarkdown(esc(evil))).not.toContain("<script>");
    // renderBlocks 内部对 text 自动转义（对外安全入口）
    expect(renderBlocks([{ type: "text", text: evil }])).not.toContain("<script>");
    expect(renderBlocks([{ type: "text", text: evil }])).not.toContain("<img");
  });

  test("T3.2c markdown 子集：标题/列表/链接/代码块", () => {
    const md = "# 标题\n\n- 列表项\n\n[链接](https://example.com)\n\n```js\nconsole.log(1)\n```";
    const out = renderMarkdown(md);
    expect(out).toContain("<h1>标题</h1>");
    expect(out).toContain("<li>列表项</li>");
    expect(out).toContain('<a href="https://example.com" target="_blank" rel="noopener">链接</a>');
    expect(out).toContain("console.log(1)");
  });

  test("T3.2d formatBytes 边界", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1048576)).toBe("5.0 MB");
  });
});
