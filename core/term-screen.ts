/**
 * 终端屏幕。简易格子留给测例；真正派工用 XtermScreen，和界面上的 xterm 吃同一串字节。
 */
import { Terminal } from "@xterm/headless";

export class XtermScreen {
  cols: number;
  rows: number;
  private term: Terminal;

  constructor(cols = 100, rows = 30) {
    this.cols = Math.max(20, cols);
    this.rows = Math.max(8, rows);
    this.term = new Terminal({ cols: this.cols, rows: this.rows, allowProposedApi: true });
  }

  write(data: string, cb?: () => void): void {
    this.term.write(data, () => cb?.());
  }

  resize(cols: number, rows: number): void {
    this.cols = Math.max(20, cols);
    this.rows = Math.max(8, rows);
    this.term.resize(this.cols, this.rows);
  }

  text(): string {
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    const y0 = buf.viewportY;
    for (let i = 0; i < this.term.rows; i++) lines.push(buf.getLine(y0 + i)?.translateToString(true) ?? "");
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n");
  }

  tail(maxChars = 700): string {
    const t = this.text();
    return t.length <= maxChars ? t : t.slice(t.length - maxChars);
  }
}

export class TermScreen {
  readonly cols: number;
  readonly rows: number;
  private cell: string[];
  private cx = 0;
  private cy = 0;

  constructor(cols = 100, rows = 30) {
    this.cols = Math.max(20, cols);
    this.rows = Math.max(8, rows);
    this.cell = Array(this.rows * this.cols).fill(" ");
  }

  feed(input: string): void {
    const s = input.replace(/\r\n/g, "\n");
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "\u001b") {
        const next = this.escape(s, i);
        i = next;
        continue;
      }
      if (ch === "\r") {
        this.cx = 0;
        continue;
      }
      if (ch === "\n") {
        this.newline();
        continue;
      }
      if (ch === "\b" || ch === "\u007f") {
        if (this.cx > 0) this.cx -= 1;
        continue;
      }
      if (ch === "\t") {
        this.cx = Math.min(this.cols - 1, this.cx + (8 - (this.cx % 8)));
        continue;
      }
      if (ch < " ") continue;
      this.put(ch);
    }
  }

  text(): string {
    const lines: string[] = [];
    for (let r = 0; r < this.rows; r++) {
      let line = "";
      for (let c = 0; c < this.cols; c++) line += this.cell[r * this.cols + c];
      lines.push(line.replace(/\s+$/g, ""));
    }
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n");
  }

  tail(maxChars = 700): string {
    const t = this.text();
    if (t.length <= maxChars) return t;
    return t.slice(t.length - maxChars);
  }

  private put(ch: string): void {
    this.cell[this.cy * this.cols + this.cx] = ch;
    this.cx += 1;
    if (this.cx >= this.cols) this.newline();
  }

  private newline(): void {
    this.cx = 0;
    if (this.cy < this.rows - 1) {
      this.cy += 1;
      return;
    }
    this.cell = this.cell.slice(this.cols).concat(Array(this.cols).fill(" "));
  }

  private escape(s: string, at: number): number {
    const nxt = s[at + 1];
    if (nxt === "[") return this.csi(s, at + 2);
    if (nxt === "]") return this.skipUntil(s, at + 2, (ch, i, src) => ch === "\u0007" || (ch === "\u001b" && src[i + 1] === "\\"));
    if (nxt === "(" || nxt === ")") return Math.min(s.length - 1, at + 2);
    return at + (nxt ? 1 : 0);
  }

  private csi(s: string, from: number): number {
    let i = from;
    const args: number[] = [];
    let cur = "";
    while (i < s.length) {
      const ch = s[i];
      if (ch >= "0" && ch <= "9") {
        cur += ch;
        i += 1;
        continue;
      }
      if (ch === ";") {
        args.push(cur === "" ? 0 : Number(cur));
        cur = "";
        i += 1;
        continue;
      }
      if (ch === "?") {
        i += 1;
        continue;
      }
      if (cur !== "") args.push(Number(cur));
      this.applyCsi(ch, args);
      return i;
    }
    return Math.max(from, s.length - 1);
  }

  private applyCsi(cmd: string, args: number[]): void {
    const n = (i: number, dflt: number) => (args[i] == null || args[i] === 0 ? dflt : args[i]);
    if (cmd === "H" || cmd === "f") {
      this.cy = Math.min(this.rows - 1, Math.max(0, n(0, 1) - 1));
      this.cx = Math.min(this.cols - 1, Math.max(0, n(1, 1) - 1));
      return;
    }
    if (cmd === "A") this.cy = Math.max(0, this.cy - n(0, 1));
    else if (cmd === "B") this.cy = Math.min(this.rows - 1, this.cy + n(0, 1));
    else if (cmd === "C") this.cx = Math.min(this.cols - 1, this.cx + n(0, 1));
    else if (cmd === "D") this.cx = Math.max(0, this.cx - n(0, 1));
    else if (cmd === "G") this.cx = Math.min(this.cols - 1, Math.max(0, n(0, 1) - 1));
    else if (cmd === "J") this.eraseDisplay(args[0] ?? 0);
    else if (cmd === "K") this.eraseLine(args[0] ?? 0);
    else if (cmd === "P") this.deleteChars(n(0, 1));
  }

  private eraseDisplay(mode: number): void {
    if (mode === 2) {
      this.cell.fill(" ");
      this.cx = 0;
      this.cy = 0;
      return;
    }
    const start = mode === 1 ? 0 : this.cy * this.cols + this.cx;
    const end = mode === 1 ? this.cy * this.cols + this.cx : this.cell.length;
    for (let i = start; i < end; i++) this.cell[i] = " ";
  }

  private eraseLine(mode: number): void {
    const base = this.cy * this.cols;
    const from = mode === 1 ? base : mode === 2 ? base : base + this.cx;
    const to = mode === 1 ? base + this.cx : base + this.cols;
    for (let i = from; i < to; i++) this.cell[i] = " ";
  }

  private deleteChars(count: number): void {
    const base = this.cy * this.cols;
    const from = base + this.cx;
    const rest = this.cell.slice(from + count, base + this.cols);
    for (let i = 0; i < this.cols - this.cx; i++) this.cell[from + i] = rest[i] ?? " ";
  }

  private skipUntil(s: string, from: number, done: (ch: string, i: number, src: string) => boolean): number {
    for (let i = from; i < s.length; i++) {
      if (done(s[i], i, s)) return s[i] === "\u001b" ? i + 1 : i;
    }
    return s.length - 1;
  }
}

export function encodeFrame(type: number, payload: Buffer | string): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const head = Buffer.alloc(5);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

export class FrameDecoder {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): Array<{ type: number; payload: Buffer }> {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const out: Array<{ type: number; payload: Buffer }> = [];
    while (this.buf.length >= 5) {
      const type = this.buf.readUInt8(0);
      const len = this.buf.readUInt32BE(1);
      if (len > 1_000_000) {
        this.buf = Buffer.alloc(0);
        break;
      }
      if (this.buf.length < 5 + len) break;
      out.push({ type, payload: this.buf.subarray(5, 5 + len) });
      this.buf = this.buf.subarray(5 + len);
    }
    return out;
  }
}
