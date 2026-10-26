import { readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve, normalize } from "node:path";
import { homedir } from "node:os";

export interface NotifyPayload {
  title: string;
  body: string;
}

export interface FilePermission {
  root: string;
  grantedAt: number;
}

/**
 * 系统能力：通知 / 剪贴板 / 文件读写。
 * 宿主编入 capabilities（Electron 通过 IPC 注入真实实现），core 保留可测接口。
 */
export class SystemKit {
  constructor(private host: {
    notify?: (p: NotifyPayload) => Promise<boolean> | boolean;
    clipboardWrite?: (text: string) => Promise<void> | void;
    clipboardRead?: () => Promise<string> | string;
    allowedRoot?: string;
  } = {}) {}

  async notify(title: string, body: string): Promise<boolean> {
    if (this.host.notify) return this.host.notify({ title, body });
    // 无宿主时最简降级：输出日志（测试用）
    console.log(`[notify] ${title}: ${body}`);
    return true;
  }

  async copy(text: string): Promise<void> {
    if (this.host.clipboardWrite) return this.host.clipboardWrite(text);
    console.log(`[clipboard-write] ${text.slice(0, 80)}`);
  }

  async paste(): Promise<string> {
    if (this.host.clipboardRead) return this.host.clipboardRead();
    return "";
  }

  /**
   * 白名单文件读写：仅允许读写用户批准过的根目录内的路径。
   * 防止 bot 越权访问任意文件。
   */
  canAccess(absPath: string): boolean {
    const root = this.host.allowedRoot;
    if (!root) return false;
    const abs = normalize(resolve(absPath));
    const rootAbs = normalize(resolve(root));
    return abs === rootAbs || abs.startsWith(rootAbs + "/");
  }

  readFile(absPath: string): string {
    if (!this.canAccess(absPath)) throw new Error(`无权读取 ${absPath}（不在白名单目录内）`);
    return readFileSync(absPath, "utf8");
  }

  writeFile(absPath: string, content: string) {
    if (!this.canAccess(absPath)) throw new Error(`无权写入 ${absPath}（不在白名单目录内）`);
    writeFileSync(absPath, content, "utf8");
  }

  stat(absPath: string) {
    return statSync(absPath);
  }

  defaultAllowedRoot(): string {
    return this.host.allowedRoot || joinHome("harness-bot-workspace");
  }
}

function joinHome(p: string): string {
  const h = homedir();
  return resolve(h, p);
}
