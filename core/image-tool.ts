/**
 * 图片生成 / 编辑：OpenAI 兼容的 /images/generations 与 /images/edits。
 * 兼容 OpenAI（gpt-image-1 / dall-e-3，返回 data[].b64_json|url）
 * 和 SiliconFlow 等（Kolors / Qwen-Image，返回 images[].url，编辑时把原图放在 image 字段）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

export interface ImageGenConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** 改图用的模型（不填则用 model） */
  editModel?: string;
  size?: string;
}

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

/** 连不上时说清楚是哪个地址、可能为什么，而不是一句 fetch failed */
export async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    const host = (() => { try { return new URL(url).host; } catch { return url; } })();
    const cause = e instanceof Error ? String((e as Error & { cause?: { code?: string; message?: string } }).cause?.code ?? (e as any).cause?.message ?? e.message) : String(e);
    if (/timeout|abort/i.test(cause)) throw new Error(`${host} 响应超时`);
    throw new Error(`连不上 ${host}（${cause}）。开着代理的话，检查这个域名是不是被规则设成了直连；SiliconFlow 国际站（.com）不接受国内 IP，国内网络请用 .cn 站的 key`);
  }
}

export function fileToDataUrl(path: string): string {
  return `data:${MIME[extname(path).toLowerCase()] ?? "image/png"};base64,${readFileSync(path).toString("base64")}`;
}

async function saveImages(data: any, outDir: string, prefix: string): Promise<string[]> {
  const items: any[] = data?.data ?? data?.images ?? [];
  if (!items.length) throw new Error(`接口没有返回图片：${JSON.stringify(data).slice(0, 200)}`);
  mkdirSync(outDir, { recursive: true });
  const paths: string[] = [];
  for (const [i, it] of items.entries()) {
    let buf: Buffer;
    if (it.b64_json) buf = Buffer.from(it.b64_json, "base64");
    else if (it.url) {
      const r = await apiFetch(it.url, { signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`下载生成的图片失败 HTTP ${r.status}`);
      buf = Buffer.from(await r.arrayBuffer());
    } else continue;
    const p = join(outDir, `${prefix}-${Date.now().toString(36)}-${i + 1}.png`);
    writeFileSync(p, buf);
    paths.push(p);
  }
  if (!paths.length) throw new Error("接口返回的图片既没有 url 也没有 b64_json");
  return paths;
}

async function imageApiError(kind: string, res: Response): Promise<string> {
  const body = (await res.text()).slice(0, 300);
  if (res.status === 402 || /insufficient|balance|余额/i.test(body)) {
    return `${kind}失败：账号额度不足。国内站去 https://cloud.siliconflow.cn/account/ak 充值，国际站去 https://cloud.siliconflow.com/me/account/ak`;
  }
  return `${kind}接口 ${res.status}：${body}`;
}

const authHeaders = (cfg: ImageGenConfig): Record<string, string> => (cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {});
const endpoint = (cfg: ImageGenConfig, path: string) => `${cfg.baseUrl.replace(/\/+$/, "")}${path}`;
/** OpenAI 系模型用 multipart /images/edits；其他（SiliconFlow 等）在 generations 里带 image */
const usesEditsEndpoint = (cfg: ImageGenConfig, model: string) => /^(gpt-image|dall-e)/i.test(model) || /api\.openai\.com/.test(cfg.baseUrl);

export async function generateImages(cfg: ImageGenConfig, prompt: string, outDir: string, opts: { n?: number; size?: string } = {}): Promise<string[]> {
  if (!cfg?.baseUrl || !cfg.model) throw new Error("还没配置图片生成接口");
  const n = Math.max(1, Math.min(4, Number(opts.n ?? 1)));
  const size = opts.size || cfg.size || "1024x1024";
  const sf = !usesEditsEndpoint(cfg, cfg.model);
  const body: Record<string, unknown> = { model: cfg.model, prompt, n, size };
  if (sf) { body.image_size = size; body.batch_size = n; }
  const res = await apiFetch(endpoint(cfg, "/images/generations"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(cfg) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(await imageApiError("图片", res));
  return saveImages(await res.json(), outDir, "gen");
}

export async function editImage(cfg: ImageGenConfig, imagePath: string, prompt: string, outDir: string, opts: { size?: string } = {}): Promise<string[]> {
  if (!cfg?.baseUrl || !cfg.model) throw new Error("还没配置图片生成接口");
  const model = cfg.editModel || cfg.model;
  let res: Response;
  if (usesEditsEndpoint(cfg, model)) {
    const form = new FormData();
    const buf = readFileSync(imagePath);
    form.append("image", new Blob([buf], { type: MIME[extname(imagePath).toLowerCase()] ?? "image/png" }), `image${extname(imagePath) || ".png"}`);
    form.append("prompt", prompt);
    form.append("model", model);
    if (opts.size || cfg.size) form.append("size", opts.size || cfg.size!);
    res = await apiFetch(endpoint(cfg, "/images/edits"), { method: "POST", headers: authHeaders(cfg), body: form, signal: AbortSignal.timeout(180_000) });
  } else {
    res = await apiFetch(endpoint(cfg, "/images/generations"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(cfg) },
      body: JSON.stringify({ model, prompt, image: fileToDataUrl(imagePath), ...(opts.size || cfg.size ? { image_size: opts.size || cfg.size } : {}) }),
      signal: AbortSignal.timeout(180_000),
    });
  }
  if (!res.ok) throw new Error(await imageApiError("改图", res));
  return saveImages(await res.json(), outDir, "edit");
}
