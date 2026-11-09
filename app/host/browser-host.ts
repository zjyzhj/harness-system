/**
 * Electron 宿主：每个 bot 一块 WebContentsView + persist 分区。
 * 视图盖在主窗口 #bot-browser 占位区上；cookie 按 bot 隔离。
 */
import { BrowserWindow, WebContentsView, session } from "electron";
import {
  BROWSER_READ_SCRIPT,
  BROWSER_SNAPSHOT_SCRIPT,
  browserPartition,
  formatBrowserSnapshot,
  type BrowserBounds,
  type BrowserHost,
  type BrowserReadResult,
  type BrowserSnapshot,
} from "../../core/browser-presence";

type Slot = {
  botId: string;
  view: WebContentsView;
  attached: boolean;
};

export type BrowserHostDeps = {
  getMainWindow: () => BrowserWindow | null;
  onState?: (botId: string, patch: { url?: string; title?: string; loading?: boolean; phase?: string; error?: string }) => void;
};

function normalizeUrl(raw: string): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (/^file:\/\//i.test(s)) return s;
  if (/^about:/i.test(s)) return s;
  return `https://${s}`;
}

export class ElectronBrowserHost implements BrowserHost {
  private slots = new Map<string, Slot>();
  private bounds: BrowserBounds | null = null;
  private visibleBotId: string | null = null;

  constructor(private deps: BrowserHostDeps) {}

  partitionOf(botId: string): string {
    return browserPartition(botId);
  }

  private ses(botId: string) {
    return session.fromPartition(this.partitionOf(botId), { cache: true });
  }

  private ensureSlot(botId: string): Slot {
    const existing = this.slots.get(botId);
    if (existing) return existing;
    const view = new WebContentsView({
      webPreferences: {
        session: this.ses(botId),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      if (url && /^https?:/i.test(url)) void wc.loadURL(url);
      return { action: "deny" };
    });
    const push = () => {
      this.deps.onState?.(botId, {
        url: wc.getURL(),
        title: wc.getTitle(),
        loading: wc.isLoading(),
        phase: wc.isLoading() ? "loading" : "ready",
      });
    };
    wc.on("did-start-loading", push);
    wc.on("did-stop-loading", push);
    wc.on("page-title-updated", push);
    wc.on("did-navigate", push);
    wc.on("did-navigate-in-page", push);
    wc.on("did-fail-load", (_e, _code, desc, url, isMain) => {
      if (!isMain) return;
      this.deps.onState?.(botId, { phase: "error", error: desc || "加载失败", url, loading: false });
    });
    const slot: Slot = { botId, view, attached: false };
    this.slots.set(botId, slot);
    return slot;
  }

  private attach(slot: Slot): void {
    const win = this.deps.getMainWindow();
    if (!win || win.isDestroyed()) return;
    if (!slot.attached) {
      win.contentView.addChildView(slot.view);
      slot.attached = true;
    }
    for (const other of this.slots.values()) {
      if (other.botId === slot.botId) continue;
      if (other.attached) {
        try { win.contentView.removeChildView(other.view); } catch { /* */ }
        other.attached = false;
      }
    }
    this.visibleBotId = slot.botId;
    this.applyBounds(slot);
  }

  private applyBounds(slot: Slot): void {
    if (!this.bounds || this.bounds.width < 40 || this.bounds.height < 40) {
      slot.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      return;
    }
    slot.view.setBounds({ ...this.bounds });
  }

  setBounds(_botId: string, bounds: BrowserBounds): void {
    this.bounds = bounds;
    if (this.visibleBotId) {
      const slot = this.slots.get(this.visibleBotId);
      if (slot?.attached) this.applyBounds(slot);
    }
  }

  show(botId: string, on: boolean): void {
    const slot = this.slots.get(botId);
    const win = this.deps.getMainWindow();
    if (!slot || !win || win.isDestroyed()) return;
    if (on) {
      this.attach(slot);
    } else if (slot.attached) {
      try { win.contentView.removeChildView(slot.view); } catch { /* */ }
      slot.attached = false;
      if (this.visibleBotId === botId) this.visibleBotId = null;
    }
  }

  focus(botId: string): void {
    const slot = this.slots.get(botId);
    if (!slot) return;
    this.attach(slot);
    try { slot.view.webContents.focus(); } catch { /* */ }
  }

  async open(botId: string, url?: string): Promise<{ ok: true; url: string; title: string } | { ok: false; error: string }> {
    try {
      const slot = this.ensureSlot(botId);
      this.attach(slot);
      const target = normalizeUrl(url ?? "");
      if (target) {
        await slot.view.webContents.loadURL(target);
      } else if (!slot.view.webContents.getURL() || slot.view.webContents.getURL() === "about:blank") {
        await slot.view.webContents.loadURL("about:blank");
      }
      return { ok: true, url: slot.view.webContents.getURL(), title: slot.view.webContents.getTitle() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async goto(botId: string, url: string): Promise<{ ok: true; url: string; title: string } | { ok: false; error: string }> {
    const target = normalizeUrl(url);
    if (!target) return { ok: false, error: "无效网址" };
    try {
      const slot = this.ensureSlot(botId);
      this.attach(slot);
      await slot.view.webContents.loadURL(target);
      return { ok: true, url: slot.view.webContents.getURL(), title: slot.view.webContents.getTitle() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async evalJson<T>(botId: string, script: string): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    const slot = this.slots.get(botId);
    if (!slot) return { ok: false, error: "浏览器还没开" };
    try {
      const value = await slot.view.webContents.executeJavaScript(script, true) as T;
      return { ok: true, value };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async snapshot(botId: string): Promise<{ ok: true; snapshot: BrowserSnapshot } | { ok: false; error: string }> {
    const r = await this.evalJson<{ url: string; title: string; elements: Array<{ selector: string; role: string; name: string; tag: string; value?: string }> }>(botId, BROWSER_SNAPSHOT_SCRIPT);
    if (!r.ok) return r;
    return { ok: true, snapshot: formatBrowserSnapshot(r.value) };
  }

  async click(botId: string, target: { ref?: string; selector?: string }): Promise<{ ok: true; detail: string } | { ok: false; error: string }> {
    const selector = target.selector;
    if (!selector) return { ok: false, error: "缺少 selector" };
    const script = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: '找不到元素' };
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      el.click();
      return { ok: true, detail: '已点击 ' + (el.tagName || '').toLowerCase() };
    })()`;
    const r = await this.evalJson<{ ok: boolean; detail?: string; error?: string }>(botId, script);
    if (!r.ok) return r;
    if (!r.value.ok) return { ok: false, error: r.value.error || "点击失败" };
    return { ok: true, detail: r.value.detail || "已点击" };
  }

  async type(botId: string, target: { ref?: string; selector?: string; text: string; submit?: boolean }): Promise<{ ok: true; detail: string } | { ok: false; error: string }> {
    const selector = target.selector;
    if (!selector) return { ok: false, error: "缺少 selector" };
    const script = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: '找不到元素' };
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      el.focus();
      const text = ${JSON.stringify(target.text)};
      const tag = (el.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || el.isContentEditable) {
        if ('value' in el) {
          const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          desc?.set?.call(el, text);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          el.textContent = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      } else return { ok: false, error: '该元素不能输入' };
      if (${target.submit ? "true" : "false"}) {
        const form = el.closest('form');
        if (form) form.requestSubmit?.() || form.submit();
        else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }
      return { ok: true, detail: ${target.submit ? "'已输入并提交'" : "'已输入'"} };
    })()`;
    const r = await this.evalJson<{ ok: boolean; detail?: string; error?: string }>(botId, script);
    if (!r.ok) return r;
    if (!r.value.ok) return { ok: false, error: r.value.error || "输入失败" };
    return { ok: true, detail: r.value.detail || "已输入" };
  }

  async keys(botId: string, keys: string): Promise<{ ok: true; detail: string } | { ok: false; error: string }> {
    const slot = this.slots.get(botId);
    if (!slot) return { ok: false, error: "浏览器还没开" };
    const map: Record<string, string> = {
      enter: "Return",
      return: "Return",
      tab: "Tab",
      escape: "Escape",
      esc: "Escape",
      backspace: "Backspace",
      delete: "Delete",
      space: "Space",
      up: "Up",
      down: "Down",
      left: "Left",
      right: "Right",
    };
    const parts = String(keys).toLowerCase().split(/[+\s]+/).filter(Boolean);
    try {
      for (const p of parts) {
        const keyCode = map[p] || (p.length === 1 ? `Key${p.toUpperCase()}` : p);
        slot.view.webContents.sendInputEvent({ type: "keyDown", keyCode } as any);
        slot.view.webContents.sendInputEvent({ type: "keyUp", keyCode } as any);
      }
      return { ok: true, detail: `已送按键 ${keys}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async read(botId: string): Promise<{ ok: true; result: BrowserReadResult } | { ok: false; error: string }> {
    const r = await this.evalJson<BrowserReadResult>(botId, BROWSER_READ_SCRIPT);
    if (!r.ok) return r;
    return { ok: true, result: r.value };
  }

  async back(botId: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    const slot = this.slots.get(botId);
    if (!slot) return { ok: false, error: "浏览器还没开" };
    if (!slot.view.webContents.canGoBack()) return { ok: false, error: "没有上一页" };
    slot.view.webContents.goBack();
    return { ok: true, url: slot.view.webContents.getURL() };
  }

  async reload(botId: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    const slot = this.slots.get(botId);
    if (!slot) return { ok: false, error: "浏览器还没开" };
    slot.view.webContents.reload();
    return { ok: true, url: slot.view.webContents.getURL() };
  }

  async stop(botId: string): Promise<void> {
    const slot = this.slots.get(botId);
    if (!slot) return;
    const win = this.deps.getMainWindow();
    if (slot.attached && win && !win.isDestroyed()) {
      try { win.contentView.removeChildView(slot.view); } catch { /* */ }
    }
    try { (slot.view.webContents as any).destroy?.(); } catch { /* */ }
    this.slots.delete(botId);
    if (this.visibleBotId === botId) this.visibleBotId = null;
  }

  stopAll(): void {
    for (const id of [...this.slots.keys()]) void this.stop(id);
  }
}
