/**
 * 用 bun build 编译 Electron 主进程与 preload 到 dist/，并复制 renderer 静态文件。
 * 用法：bun run scripts/build-shell.ts
 */
import { $ } from "bun";
import { mkdirSync, cpSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const rendererSrc = join(root, "app", "renderer");
const rendererDist = join(dist, "renderer");

mkdirSync(dist, { recursive: true });
mkdirSync(rendererDist, { recursive: true });

// 主进程（CJS，external electron）
await $`bun build ${join(root, "app/main.ts")} --outfile ${join(dist, "main.cjs")} --format cjs --target node --external electron --external @huggingface/transformers`.quiet();
// preload（CJS）
await $`bun build ${join(root, "app/preload.ts")} --outfile ${join(dist, "preload.cjs")} --format cjs --target node --external electron`.quiet();

cpSync(rendererSrc, rendererDist, { recursive: true });
const xtermCss = join(root, "node_modules", "@xterm", "xterm", "css", "xterm.css");
if (existsSync(xtermCss)) cpSync(xtermCss, join(rendererDist, "xterm.css"));
await $`bun build ${join(root, "app/renderer/xterm-bundle.ts")} --outfile ${join(rendererDist, "xterm-bundle.js")} --format iife --target browser`.quiet();
console.log("✅ shell built → dist/");
