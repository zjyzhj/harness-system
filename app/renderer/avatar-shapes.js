// 形状头像：一块带两只眼睛的色块，主面板和桌宠共用
const BOT_COLORS = ["#1d1d1f", "#94603a", "#ef4444", "#f26b1d", "#f29a1d", "#3dba6a", "#2fae9b", "#3b82f6", "#8b5cf6", "#ec4899", "#8e8e8e"];
const ORANGE = "#f26b1d";

function starPoints(n, ro, ri, rot = -90) {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? ri : ro;
    const a = ((rot + (i * 180) / n) * Math.PI) / 180;
    pts.push(`${(50 + r * Math.cos(a)).toFixed(1)},${(50 + r * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(" ");
}
function polyPoints(n, r, rot = -90) {
  return Array.from({ length: n }, (_, i) => {
    const a = ((rot + (i * 360) / n) * Math.PI) / 180;
    return `${(50 + r * Math.cos(a)).toFixed(1)},${(50 + r * Math.sin(a)).toFixed(1)}`;
  }).join(" ");
}
const round = (w) => `stroke="currentColor" stroke-width="${w}" stroke-linejoin="round"`;
const ring = (n, dist, r) => Array.from({ length: n }, (_, i) => {
  const a = (i * 2 * Math.PI) / n;
  return `<circle cx="${(50 + dist * Math.cos(a)).toFixed(1)}" cy="${(50 + dist * Math.sin(a)).toFixed(1)}" r="${r}"/>`;
}).join("");

/** eye：两只眼睛中心点偏移 */
const BOT_SHAPES = [
  { id: "circle", body: `<circle cx="50" cy="50" r="44"/>` },
  { id: "cloud", body: `<circle cx="36" cy="56" r="26"/><circle cx="64" cy="54" r="26"/><circle cx="52" cy="36" r="24"/><circle cx="30" cy="40" r="16"/>`, eye: [2, 2] },
  { id: "square", body: `<rect x="20" y="20" width="60" height="60" rx="10" transform="rotate(14 50 50)" ${round(8)}/>` },
  { id: "sparkle", body: `<polygon points="${starPoints(4, 46, 20, -80)}" ${round(12)}/>` },
  { id: "clover", body: `${ring(4, 22, 22)}<circle cx="50" cy="50" r="24"/>`, rot: 20 },
  { id: "heart", body: `<path d="M50 84 C22 66 10 48 16 32 C22 18 42 16 50 30 C58 16 78 18 84 32 C90 48 78 66 50 84Z" ${round(8)}/>`, eye: [0, 4] },
  { id: "flower", body: `${ring(8, 30, 15)}<circle cx="50" cy="50" r="32"/>` },
  { id: "egg", body: `<ellipse cx="50" cy="52" rx="34" ry="42" transform="rotate(-14 50 50)"/>` },
  { id: "bean", body: `<ellipse cx="50" cy="52" rx="45" ry="31" transform="rotate(-8 50 50)"/>` },
  { id: "triangle", body: `<polygon points="24,20 84,50 26,82" ${round(20)}/>`, eye: [-6, 0] },
  { id: "pentagon", body: `<polygon points="${polyPoints(5, 40, -60)}" ${round(16)}/>` },
  { id: "splat", body: `<polygon points="${starPoints(8, 47, 30)}" ${round(10)}/>` },
  { id: "hexagon", body: `<polygon points="${polyPoints(6, 40, 10)}" ${round(16)}/>` },
  { id: "orange", color: ORANGE, body: `<circle cx="50" cy="56" r="40"/><path d="M50 18 Q52 10 58 6" stroke="#3b2a1a" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M52 16 Q66 4 78 12 Q66 22 52 16Z" fill="#3dba6a"/>`, eye: [0, 6] },
];
const SHAPE_BY_ID = Object.fromEntries(BOT_SHAPES.map((s) => [s.id, s]));

function validAvatar(a) {
  return !!a && !!SHAPE_BY_ID[a.shape] && /^#[0-9a-f]{6}$/i.test(a.color || "");
}

/** 形状头像的 SVG；外层容器加 .busy 时身体跳动、眼睛左右看 */
function blobAvatarSvg(avatar, seed = "") {
  const shape = SHAPE_BY_ID[avatar?.shape] ?? BOT_SHAPES[0];
  const color = shape.color ?? (/^#[0-9a-f]{6}$/i.test(avatar?.color || "") ? avatar.color : BOT_COLORS[9]);
  const [dx, dy] = shape.eye ?? [0, 0];
  let h = 0;
  for (const c of String(seed)) h = (h * 31 + c.charCodeAt(0)) % 997;
  const body = shape.rot ? `<g transform="rotate(${shape.rot} 50 50)">${shape.body}</g>` : shape.body;
  return `<svg class="blob-av" viewBox="-4 -4 108 108" style="color:${color};--blink-delay:-${(h % 50) / 10}s" aria-hidden="true">`
    + `<g class="blob-body" fill="currentColor">${body}</g>`
    + `<g class="blob-eyes" fill="#fff"><rect x="${34 + dx}" y="${44 + dy}" width="10" height="20" rx="5"/><rect x="${56 + dx}" y="${44 + dy}" width="10" height="20" rx="5"/></g>`
    + `</svg>`;
}
