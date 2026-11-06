/**
 * 开发启动：若工程在外置卷，把 Electron.app 拷到内置盘再跑，
 * 否则 macOS 辅助功能对 /Volumes/… 上的二进制经常「开关开着也不生效」。
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const stock = join(root, "node_modules/electron/dist/Electron.app");
const onExternal = root.startsWith("/Volumes/");
const internal = join(homedir(), "Library/Application Support/harness-bot/runtime/Electron.app");

let electronBin = join(stock, "Contents/MacOS/Electron");
if (onExternal && existsSync(stock)) {
  mkdirSync(join(internal, ".."), { recursive: true });
  const internalBin = join(internal, "Contents/MacOS/Electron");
  // 已有内置副本就复用，禁止每次 rm+重签——否则 CDHash 变了，辅助功能开关开着也不生效。
  if (!existsSync(internalBin)) {
    console.log("工程在外置盘 /Volumes → 首次拷贝 Electron 到内置盘");
    cpSync(stock, internal, { recursive: true });
    try {
      const { execFileSync } = await import("node:child_process");
      execFileSync("codesign", ["--force", "--deep", "--sign", "-", internal], { stdio: "ignore" });
    } catch { /* ignore */ }
  } else {
    console.log("工程在外置盘 /Volumes → 复用已有内置盘 Electron（不重签，保住 TCC）");
  }
  electronBin = internalBin;
  console.log("Electron:", internal);
}

if (!existsSync(electronBin)) {
  console.error("找不到 Electron 可执行文件:", electronBin);
  process.exit(1);
}

const extra = process.argv.slice(2);
const child = spawn(electronBin, [root, "--remote-debugging-port=9333", ...extra], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
