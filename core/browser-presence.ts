/**
 * Bot 内部浏览器 — 对齐 Grok Computer（无云电脑）：
 * 每个 bot 一块 Chromium 页面，cookie 按分区隔离；工具点/填，人可接手。
 * 真正的 WebContents 在主进程 BrowserHost；这里管槽位、ref、状态推送。
 */

export const MAX_BROWSER_SLOTS = 4;

export type BrowserPhase = "starting" | "loading" | "ready" | "error" | "closed";

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserState {
  botId: string;
  url: string;
  title: string;
  phase: BrowserPhase;
  loading: boolean;
  error?: string;
  /** 最近一次 snapshot 的摘要行数 */
  snapshotLines?: number;
  updatedAt: number;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  text: string;
  refs: Record<string, string>;
}

export interface BrowserReadResult {
  url: string;
  title: string;
  text: string;
}

/** 主进程 / 测试注入的真实浏览器能力 */
export interface BrowserHost {
  partitionOf(botId: string): string;
  open(botId: string, url?: string): Promise<{ ok: true; url: string; title: string } | { ok: false; error: string }>;
  goto(botId: string, url: string): Promise<{ ok: true; url: string; title: string } | { ok: false; error: string }>;
  snapshot(botId: string): Promise<{ ok: true; snapshot: BrowserSnapshot } | { ok: false; error: string }>;
  click(botId: string, target: { ref?: string; selector?: string }): Promise<{ ok: true; detail: string } | { ok: false; error: string }>;
  type(botId: string, target: { ref?: string; selector?: string; text: string; submit?: boolean }): Promise<{ ok: true; detail: string } | { ok: false; error: string }>;
  keys(botId: string, keys: string): Promise<{ ok: true; detail: string } | { ok: false; error: string }>;
  read(botId: string): Promise<{ ok: true; result: BrowserReadResult } | { ok: false; error: string }>;
  /** 关掉视图；分区 cookie 默认保留 */
  stop(botId: string): Promise<void> | void;
  back?(botId: string): Promise<{ ok: true; url: string } | { ok: false; error: string }>;
  reload?(botId: string): Promise<{ ok: true; url: string } | { ok: false; error: string }>;
  setBounds?(botId: string, bounds: BrowserBounds): void;
  focus?(botId: string): void;
  show?(botId: string, on: boolean): void;
}

export function browserPartition(botId: string): string {
  const id = String(botId || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "default";
  return `persist:bot-browser-${id}`;
}

/** 把页面元素列表编成带 e1/e2… ref 的文本树 */
export function formatBrowserSnapshot(input: {
  url: string;
  title: string;
  elements: Array<{ selector: string; role: string; name: string; tag: string; value?: string }>;
}): BrowserSnapshot {
  const refs: Record<string, string> = {};
  const lines: string[] = [`url: ${input.url}`, `title: ${input.title || "(无标题)"}`, "elements:"];
  let i = 0;
  for (const el of input.elements) {
    i += 1;
    const ref = `e${i}`;
    refs[ref] = el.selector;
    const name = (el.name || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const val = el.value != null && el.value !== "" ? ` value=${JSON.stringify(String(el.value).slice(0, 40))}` : "";
    lines.push(`  [${ref}] ${el.role || el.tag}${name ? ` "${name}"` : ""}${val}`);
  }
  if (!input.elements.length) lines.push("  (没有可交互元素)");
  return { url: input.url, title: input.title, text: lines.join("\n"), refs };
}

/** 注入页面：收集可点可填元素，返回给 formatBrowserSnapshot */
export const BROWSER_SNAPSHOT_SCRIPT = `(() => {
  const sel = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [contenteditable="true"]';
  const nodes = Array.from(document.querySelectorAll(sel)).slice(0, 80);
  const pathOf = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    for (let depth = 0; cur && cur.nodeType === 1 && depth < 5; depth++) {
      let part = cur.tagName.toLowerCase();
      if (cur.name) part += '[name=' + JSON.stringify(cur.name) + ']';
      else {
        const parent = cur.parentElement;
        if (parent) {
          const sibs = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
          if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
        }
      }
      parts.unshift(part);
      if (cur.id) { parts[0] = '#' + CSS.escape(cur.id); break; }
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };
  const roleOf = (el) => {
    const r = el.getAttribute('role');
    if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'button') return 'button';
    if (t === 'input') return el.type === 'submit' || el.type === 'button' ? 'button' : 'textbox';
    if (t === 'textarea') return 'textbox';
    if (t === 'select') return 'combobox';
    return t;
  };
  const nameOf = (el) => {
    return (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.value || el.getAttribute('name') || el.getAttribute('title') || '').trim();
  };
  return {
    url: location.href,
    title: document.title || '',
    elements: nodes.map((el) => ({
      selector: pathOf(el),
      role: roleOf(el),
      name: nameOf(el).slice(0, 120),
      tag: el.tagName.toLowerCase(),
      value: 'value' in el ? String(el.value || '').slice(0, 80) : undefined,
    })),
  };
})()`;

export const BROWSER_READ_SCRIPT = `(() => {
  const body = document.body ? (document.body.innerText || '').replace(/\\s+/g, ' ').trim() : '';
  return { url: location.href, title: document.title || '', text: body.slice(0, 4000) };
})()`;

export function formatBrowserPresenceLine(state: BrowserState | null): string {
  if (!state || state.phase === "closed") return "";
  const where = state.title || state.url || "空白页";
  if (state.phase === "loading" || state.loading) return `【浏览器】正在加载 ${where}`;
  if (state.phase === "error") return `【浏览器】出错：${state.error || where}`;
  if (state.phase === "starting") return `【浏览器】正在打开…`;
  return `【浏览器】${where}${state.url && state.title ? ` · ${state.url}` : ""}`;
}

export class BrowserPresence {
  private slots = new Map<string, BrowserState>();
  private refs = new Map<string, Record<string, string>>();
  private listener: ((state: BrowserState) => void) | null = null;
  private openOrder: string[] = [];

  constructor(private host: BrowserHost, private opts: { now?: () => number; maxSlots?: number } = {}) {}

  setStateListener(fn: ((state: BrowserState) => void) | null): void {
    this.listener = fn;
  }

  partitionOf(botId: string): string {
    return this.host.partitionOf(botId);
  }

  snapshot(botId: string): BrowserState | null {
    return this.slots.get(botId) ?? null;
  }

  list(): BrowserState[] {
    return [...this.slots.values()].filter((s) => s.phase !== "closed");
  }

  line(botId: string): string {
    return formatBrowserPresenceLine(this.snapshot(botId));
  }

  resolveTarget(botId: string, target: { ref?: string; selector?: string }): { selector?: string; error?: string } {
    const ref = String(target.ref ?? "").trim();
    const selector = String(target.selector ?? "").trim();
    if (selector) return { selector };
    if (!ref) return { error: "需要 ref（来自 browser.snapshot）或 selector" };
    const map = this.refs.get(botId) ?? {};
    const hit = map[ref];
    if (!hit) return { error: `找不到 ref「${ref}」。先 browser.snapshot 再点/填。` };
    return { selector: hit };
  }

  private touch(botId: string, patch: Partial<BrowserState>): BrowserState {
    const prev = this.slots.get(botId);
    const next: BrowserState = {
      botId,
      url: patch.url ?? prev?.url ?? "",
      title: patch.title ?? prev?.title ?? "",
      phase: patch.phase ?? prev?.phase ?? "ready",
      loading: patch.loading ?? prev?.loading ?? false,
      error: patch.error,
      snapshotLines: patch.snapshotLines ?? prev?.snapshotLines,
      updatedAt: this.opts.now?.() ?? Date.now(),
    };
    this.slots.set(botId, next);
    this.listener?.(next);
    return next;
  }

  private async ensureSlot(botId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.slots.has(botId) && this.slots.get(botId)!.phase !== "closed") return { ok: true };
    const max = this.opts.maxSlots ?? MAX_BROWSER_SLOTS;
    const live = [...this.slots.values()].filter((s) => s.phase !== "closed");
    if (live.length >= max && !this.slots.has(botId)) {
      const victim = this.openOrder.find((id) => id !== botId && this.slots.get(id)?.phase !== "closed");
      if (victim) await this.stop(victim);
      else return { ok: false, error: `浏览器同时最多开 ${max} 个，先 browser.stop 关掉一个。` };
    }
    return { ok: true };
  }

  private markOpen(botId: string) {
    this.openOrder = this.openOrder.filter((id) => id !== botId);
    this.openOrder.push(botId);
  }

  async open(botId: string, url?: string): Promise<{ ok: true; state: BrowserState; output: string } | { ok: false; error: string }> {
    const slot = await this.ensureSlot(botId);
    if (!slot.ok) return slot;
    this.touch(botId, { phase: "starting", loading: true, error: undefined });
    this.markOpen(botId);
    const r = await this.host.open(botId, url);
    if (!r.ok) {
      this.touch(botId, { phase: "error", loading: false, error: r.error });
      return { ok: false, error: r.error };
    }
    const state = this.touch(botId, { phase: "ready", loading: false, url: r.url, title: r.title, error: undefined });
    this.host.show?.(botId, true);
    this.host.focus?.(botId);
    return { ok: true, state, output: `已打开 bot 浏览器${r.url ? `：${r.title || r.url}` : "（空白页，可用 browser.goto）"}` };
  }

  async goto(botId: string, url: string): Promise<{ ok: true; state: BrowserState; output: string } | { ok: false; error: string }> {
    const u = String(url || "").trim();
    if (!u) return { ok: false, error: "browser.goto 需要 url" };
    const opened = this.slots.get(botId);
    if (!opened || opened.phase === "closed") {
      const o = await this.open(botId, u);
      if (!o.ok) return o;
      return { ok: true, state: o.state, output: `已打开并前往 ${o.state.url || u}` };
    }
    this.touch(botId, { phase: "loading", loading: true, error: undefined });
    const r = await this.host.goto(botId, u);
    if (!r.ok) {
      this.touch(botId, { phase: "error", loading: false, error: r.error });
      return { ok: false, error: r.error };
    }
    this.refs.delete(botId);
    const state = this.touch(botId, { phase: "ready", loading: false, url: r.url, title: r.title });
    this.host.show?.(botId, true);
    return { ok: true, state, output: `已前往 ${r.title || r.url}` };
  }

  async takeSnapshot(botId: string): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
    if (!this.slots.get(botId) || this.slots.get(botId)!.phase === "closed") {
      return { ok: false, error: "浏览器还没开。先 browser.open 或 browser.goto。" };
    }
    const r = await this.host.snapshot(botId);
    if (!r.ok) return r;
    this.refs.set(botId, r.snapshot.refs);
    this.touch(botId, {
      url: r.snapshot.url,
      title: r.snapshot.title,
      snapshotLines: Object.keys(r.snapshot.refs).length,
      phase: "ready",
      loading: false,
    });
    return { ok: true, output: r.snapshot.text };
  }

  async click(botId: string, target: { ref?: string; selector?: string }): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
    if (!this.slots.get(botId) || this.slots.get(botId)!.phase === "closed") {
      return { ok: false, error: "浏览器还没开。先 browser.open。" };
    }
    const resolved = this.resolveTarget(botId, target);
    if (resolved.error) return { ok: false, error: resolved.error };
    const r = await this.host.click(botId, { selector: resolved.selector });
    if (!r.ok) return r;
    return { ok: true, output: r.detail || "已点击" };
  }

  async type(botId: string, target: { ref?: string; selector?: string; text: string; submit?: boolean }): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
    if (!this.slots.get(botId) || this.slots.get(botId)!.phase === "closed") {
      return { ok: false, error: "浏览器还没开。先 browser.open。" };
    }
    const resolved = this.resolveTarget(botId, target);
    if (resolved.error) return { ok: false, error: resolved.error };
    const r = await this.host.type(botId, { selector: resolved.selector, text: target.text, submit: target.submit });
    if (!r.ok) return r;
    return { ok: true, output: r.detail || (target.submit ? "已输入并提交" : "已输入") };
  }

  async keys(botId: string, keys: string): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
    if (!this.slots.get(botId) || this.slots.get(botId)!.phase === "closed") {
      return { ok: false, error: "浏览器还没开。先 browser.open。" };
    }
    const r = await this.host.keys(botId, keys);
    if (!r.ok) return r;
    return { ok: true, output: r.detail || `已送按键 ${keys}` };
  }

  async read(botId: string): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
    if (!this.slots.get(botId) || this.slots.get(botId)!.phase === "closed") {
      return { ok: false, error: "浏览器还没开。先 browser.open。" };
    }
    const r = await this.host.read(botId);
    if (!r.ok) return r;
    this.touch(botId, { url: r.result.url, title: r.result.title, phase: "ready", loading: false });
    return { ok: true, output: `url: ${r.result.url}\ntitle: ${r.result.title}\n\n${r.result.text}` };
  }

  async stop(botId: string): Promise<{ ok: true; output: string }> {
    await this.host.stop(botId);
    this.refs.delete(botId);
    this.touch(botId, { phase: "closed", loading: false, url: "", title: "" });
    this.openOrder = this.openOrder.filter((id) => id !== botId);
    return { ok: true, output: "已关掉浏览器面板（登录态仍保留在该 bot 分区里）" };
  }

  setBounds(botId: string, bounds: BrowserBounds): void {
    this.host.setBounds?.(botId, bounds);
  }

  focus(botId: string): BrowserState | null {
    const s = this.slots.get(botId);
    if (!s || s.phase === "closed") return null;
    this.host.show?.(botId, true);
    this.host.focus?.(botId);
    return s;
  }

  show(botId: string, on: boolean): void {
    this.host.show?.(botId, on);
  }

  /** 宿主导航回调：同步 url/title/loading */
  applyHostState(botId: string, patch: Partial<Pick<BrowserState, "url" | "title" | "loading" | "phase" | "error">>): void {
    if (!this.slots.has(botId)) return;
    this.touch(botId, patch);
  }

  stopAll(): void {
    for (const id of [...this.slots.keys()]) void this.stop(id);
  }
}
