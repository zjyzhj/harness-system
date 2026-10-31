/**
 * Electron 42+ 在 macOS 上用 UNNotification，要求真签名；
 * node_modules 里自带的是 linker-signed，会失败：UNErrorDomain error 1。
 * 开发态用本机 Apple Development / 自签身份重签一次，通知才能点进会话。
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";

const root = process.cwd();
const electronApp = join(root, "node_modules", "electron", "dist", "Electron.app");

function codesignDv(app: string): string {
  const r = spawnSync("codesign", ["-dv", "--verbose=2", app], { encoding: "utf8" });
  return `${r.stderr ?? ""}${r.stdout ?? ""}`;
}

function pickIdentity(): string | null {
  if (process.env.HARNESS_CODESIGN_IDENTITY?.trim()) return process.env.HARNESS_CODESIGN_IDENTITY.trim();
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { build?: { mac?: { identity?: string } } };
    const fromPkg = pkg.build?.mac?.identity?.trim();
    if (fromPkg && fromPkg !== "-") return fromPkg;
  } catch { /* ignore */ }
  try {
    const list = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
    const apple = list.match(/"(Apple Development: [^"]+)"/);
    if (apple) return apple[1];
    const any = list.match(/^\s*\d+\)\s+[A-F0-9]+\s+"([^"]+)"/m);
    if (any) return any[1];
  } catch { /* ignore */ }
  return null;
}

function main() {
  if (process.platform !== "darwin") {
    console.log("[sign:electron] 非 macOS，跳过");
    return;
  }
  if (!existsSync(electronApp)) {
    console.log("[sign:electron] 未找到 Electron.app，先 bun install");
    process.exit(0);
  }

  const before = codesignDv(electronApp);
  const linker = /linker-signed/i.test(before);
  const identity = pickIdentity();

  // 已非 linker-signed，且未强制重签时跳过（FORCE_SIGN=1 可强制带 entitlements 再签）
  if (!linker && /Authority=/i.test(before) && process.env.FORCE_SIGN !== "1") {
    console.log("[sign:electron] Electron.app 已有有效签名，跳过");
    console.log(before.split("\n").filter((l) => /Authority=|flags=|Identifier=/.test(l)).join("\n"));
    return;
  }

  if (!identity) {
    console.warn("[sign:electron] 没有可用 codesign 身份。通知会继续走 osascript（点不进会话）。");
    console.warn("  可在 Keychain 建「Apple Development」证书，或设 HARNESS_CODESIGN_IDENTITY。");
    process.exit(0);
  }

  const ents = join(root, "build", "entitlements.mac.plist");
  const signArgs = (id: string) => {
    const args = ["--force", "--deep", "--sign", id];
    if (existsSync(ents)) args.push("--entitlements", ents);
    args.push(electronApp);
    return args;
  };

  console.log(`[sign:electron] 用「${identity}」重签（去掉 linker-signed）…`);
  try {
    execFileSync("codesign", signArgs(identity), { stdio: "inherit" });
  } catch (e) {
    console.warn("[sign:electron] 指定身份失败，尝试 ad-hoc（通知可用，但钥匙串可能反复弹窗）…");
    try {
      execFileSync("codesign", signArgs("-"), { stdio: "inherit" });
    } catch (e2) {
      console.error("[sign:electron] 签名失败", e2);
      process.exit(1);
    }
  }

  const after = codesignDv(electronApp);
  if (/linker-signed/i.test(after)) {
    console.error("[sign:electron] 仍是 linker-signed，通知多半还会失败");
    process.exit(1);
  }
  console.log(after.split("\n").filter((l) => /Authority=|flags=|Identifier=|Signature=/.test(l)).join("\n") || after.slice(0, 400));

  // 让通知守护进程认到这个 bundle
  const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
  if (existsSync(lsregister)) {
    try {
      execFileSync(lsregister, ["-f", electronApp], { stdio: "ignore" });
      console.log("[sign:electron] 已 lsregister");
    } catch { /* ignore */ }
  }
  console.log("[sign:electron] 完成。若仍无横幅：系统设置 → 通知 → Electron → 允许通知。首次启动钥匙串选「始终允许」。");
}

main();
