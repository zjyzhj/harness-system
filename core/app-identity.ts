/**
 * 软件 / 系统身份：显示名、品牌、bundle 路径、磁盘卷标注。
 * 图标由宿主 Electron getFileIcon 注入；这里只做可测试的解析。
 */
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

export type AppKind = "app" | "cli" | "system" | "unknown";
export type BrandId =
  | "cursor" | "codex" | "claude" | "vscode" | "chrome" | "safari"
  | "finder" | "terminal" | "iterm" | "electron" | "wechat" | "feishu"
  | "macos" | "disk" | "usb" | "network" | "shell" | "node" | "python"
  | "unknown";

export interface AppIdentity {
  /** 缓存 / UI key */
  id: string;
  label: string;
  kind: AppKind;
  brand: BrandId;
  /** 用于取图标的 .app 或可执行文件路径 */
  iconPath?: string;
  bundlePath?: string;
  /** 无图标时的短标 */
  mark: string;
}

export interface VolumeIdentity {
  mount: string;
  label: string;
  kind: "system" | "data" | "external" | "network" | "other";
  brand: BrandId;
  mark: string;
}

const BRAND_MARK: Record<BrandId, string> = {
  cursor: "Cu",
  codex: "Cx",
  claude: "Cl",
  vscode: "VS",
  chrome: "Ch",
  safari: "Sf",
  finder: "Fn",
  terminal: "Tt",
  iterm: "iT",
  electron: "El",
  wechat: "Wx",
  feishu: "Fs",
  macos: "",
  disk: "HD",
  usb: "USB",
  network: "Net",
  shell: "Sh",
  node: "Nd",
  python: "Py",
  unknown: "·",
};

const BRAND_LABEL: Partial<Record<BrandId, string>> = {
  cursor: "Cursor",
  codex: "Codex",
  claude: "Claude",
  vscode: "VS Code",
  chrome: "Chrome",
  safari: "Safari",
  finder: "Finder",
  terminal: "Terminal",
  iterm: "iTerm",
  electron: "Electron",
  wechat: "微信",
  feishu: "飞书",
  macos: "macOS",
  shell: "Shell",
  node: "Node",
  python: "Python",
};

/** 从命令行 / 进程名猜品牌 */
export function detectBrand(raw: string): BrandId {
  const s = raw.toLowerCase();
  if (/cursor/.test(s)) return "cursor";
  if (/codex/.test(s)) return "codex";
  if (/claude/.test(s)) return "claude";
  if (/visual studio code|code helper|\/code$|com\.microsoft\.vscode/.test(s)) return "vscode";
  if (/google chrome|chrome helper|chromium/.test(s)) return "chrome";
  if (/safari/.test(s)) return "safari";
  if (/finder/.test(s)) return "finder";
  if (/iterm/.test(s)) return "iterm";
  if (/\bterminal\b|Terminal\.app/.test(s)) return "terminal";
  if (/wechat|微信/.test(s)) return "wechat";
  if (/feishu|lark|飞书/.test(s)) return "feishu";
  if (/electron/.test(s)) return "electron";
  if (/\bnode\b/.test(s)) return "node";
  if (/python/.test(s)) return "python";
  if (/\b(zsh|bash|sh|fish)\b/.test(s)) return "shell";
  if (/kernel_task|launchd|WindowServer|systemstats/.test(s)) return "macos";
  return "unknown";
}

/** 从完整 command 抽出 Foo.app 路径（不要求此刻一定存在，便于标注） */
export function extractBundlePath(command: string): string | undefined {
  const m = command.match(/(\/(?:Applications|System\/Applications|Users\/[^/]+\/Applications)\/[^/]+\.app)\b/i);
  if (m?.[1]) return m[1];
  const any = command.match(/(\/[^\s]*?\.app)\b/i);
  if (any?.[1]) {
    const idx = any[1].toLowerCase().indexOf(".app");
    return any[1].slice(0, idx + 4);
  }
  return undefined;
}

let appIndex: Map<string, string> | null = null;

function buildAppIndex(): Map<string, string> {
  const map = new Map<string, string>();
  const roots = [
    "/Applications",
    "/System/Applications",
    join(process.env.HOME || "", "Applications"),
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let ents: string[] = [];
    try {
      ents = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of ents) {
      if (!name.endsWith(".app")) continue;
      const full = join(root, name);
      const base = name.replace(/\.app$/i, "");
      map.set(base.toLowerCase(), full);
      map.set(name.toLowerCase(), full);
      // 可执行名常与 bundle 名相同
      map.set(base.replace(/\s+/g, "").toLowerCase(), full);
    }
  }
  return map;
}

export function lookupAppBundle(nameOrCmd: string): string | undefined {
  const fromPath = extractBundlePath(nameOrCmd);
  if (fromPath) return fromPath;
  if (!appIndex) appIndex = buildAppIndex();
  const base = basename(nameOrCmd).replace(/\.app$/i, "");
  return appIndex.get(base.toLowerCase())
    || appIndex.get(`${base.toLowerCase()}.app`)
    || appIndex.get(base.replace(/\s+/g, "").toLowerCase());
}

export function resolveAppIdentity(input: {
  command: string;
  /** 完整 command 行（可含路径） */
  rawCommand?: string;
  displayHint?: string | null;
}): AppIdentity {
  const raw = input.rawCommand || input.command;
  const brand = detectBrand(input.displayHint || raw);
  const bundlePath = lookupAppBundle(raw) || lookupAppBundle(input.command);
  const kind: AppKind =
    brand === "macos" ? "system"
      : bundlePath ? "app"
        : brand === "shell" || brand === "node" || brand === "python" || brand === "cli" as never ? "cli"
          : /bin\/|sbin\//.test(raw) ? "cli"
            : "unknown";
  const label =
    input.displayHint?.trim()
    || (bundlePath ? basename(bundlePath).replace(/\.app$/i, "") : undefined)
    || BRAND_LABEL[brand]
    || basename(input.command)
    || "未知";
  const id = bundlePath || `${brand}:${label.toLowerCase()}`;
  return {
    id,
    label,
    kind: kind === "unknown" && brand !== "unknown" ? (brand === "shell" || brand === "node" || brand === "python" ? "cli" : "app") : kind,
    brand,
    bundlePath,
    iconPath: bundlePath,
    mark: BRAND_MARK[brand] || label.slice(0, 2),
  };
}

export function resolveVolumeIdentity(mount: string): VolumeIdentity {
  if (mount === "/") {
    return { mount, label: "系统盘", kind: "system", brand: "macos", mark: "" };
  }
  if (mount === "/System/Volumes/Data" || mount.endsWith("/Data")) {
    return { mount, label: "数据盘", kind: "data", brand: "disk", mark: "HD" };
  }
  if (mount.startsWith("/Volumes/")) {
    const name = mount.slice("/Volumes/".length) || "外置卷";
    return { mount, label: name, kind: "external", brand: "usb", mark: "USB" };
  }
  if (mount.startsWith("//") || mount.startsWith("/Network")) {
    return { mount, label: "网络卷", kind: "network", brand: "network", mark: "Net" };
  }
  return { mount, label: basename(mount) || mount, kind: "other", brand: "disk", mark: "HD" };
}

/** Coding CLI 品牌（账本展示） */
export function codingCliIdentity(cli: string): AppIdentity {
  const brand = detectBrand(cli);
  const bundle =
    brand === "cursor" ? lookupAppBundle("Cursor")
      : brand === "vscode" ? lookupAppBundle("Visual Studio Code") || lookupAppBundle("Code")
        : undefined;
  const label = BRAND_LABEL[brand] || cli;
  return {
    id: `cli:${cli}`,
    label,
    kind: brand === "shell" ? "cli" : "app",
    brand: brand === "unknown" ? (cli === "shell" ? "shell" : "unknown") : brand,
    bundlePath: bundle,
    iconPath: bundle,
    mark: BRAND_MARK[brand === "unknown" && cli === "shell" ? "shell" : brand] || cli.slice(0, 2),
  };
}

export function brandMark(brand: BrandId): string {
  return BRAND_MARK[brand] || "·";
}
