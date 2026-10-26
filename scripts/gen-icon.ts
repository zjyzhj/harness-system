/**
 * 生成最小 PNG 图标（tray 用），纯 Node 手写 PNG 编码，零依赖。
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size: number, px: (x: number, y: number) => [number, number, number, number]): Buffer {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = px(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// 蓝色渐变圆点 + 白色小弧，模拟「bot 光标」
const icon = png(64, (x, y) => {
  const dx = x - 32, dy = y - 30;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d > 26) return [0, 0, 0, 0];
  const t = (y + x) / 128;
  const r = 40 + Math.round(60 * (1 - t));
  const g = 70 + Math.round(100 * t);
  const b = 220 + Math.round(30 * (1 - t));
  // 两只小眼睛
  const eye = Math.abs(dx - 0) < 6 && Math.abs(dy - 6) < 8;
  const eye2 = Math.abs(dx - 0) < 6 && Math.abs(dy + 6) < 8;
  if (eye || eye2) return [255, 255, 255, 220];
  return [r, g, b, 255];
});
const out = join(import.meta.dir, "..", "assets", "tray.png");
mkdirSync(join(out, ".."), { recursive: true });
writeFileSync(out, icon);
console.log("✅ tray icon →", out);
