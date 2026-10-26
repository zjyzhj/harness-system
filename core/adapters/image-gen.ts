import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "../types";
import type { ImageGenResult, ImageGenProvider } from "../persona";

/**
 * 图像生成适配器 — 用 OpenAI 兼容的 /images/generations 接口。
 * 复用 ProviderCenter 里的 openai-compat provider（baseUrl/apiKey/model）。
 */
export class OpenAICompatImageGen implements ImageGenProvider {
  constructor(private provider: Provider) {}

  async generate(prompt: string, destPath: string): Promise<ImageGenResult> {
    if (!this.provider.baseUrl) throw new Error("图像 provider 缺少 baseUrl");
    const url = this.provider.baseUrl.replace(/\/+$/, "") + "/images/generations";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.provider.apiKey ? { Authorization: `Bearer ${this.provider.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.provider.model ?? "dall-e-3",
        prompt,
        n: 1,
        size: "1024x1024",
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`图像 API ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as any;
    const item = data?.data?.[0];
    if (!item) throw new Error("图像 API 返回为空");
    let b64 = item.b64_json as string | undefined;
    if (!b64 && item.url) {
      // 下载返回的 URL
      const imgRes = await fetch(item.url);
      if (!imgRes.ok) throw new Error(`下载图像失败 HTTP ${imgRes.status}`);
      const buf = Buffer.from(await imgRes.arrayBuffer());
      mkdirSync(join(destPath, ".."), { recursive: true });
      writeFileSync(destPath, buf);
      return { path: destPath, degraded: false };
    }
    if (b64) {
      mkdirSync(join(destPath, ".."), { recursive: true });
      writeFileSync(destPath, Buffer.from(b64, "base64"));
      return { path: destPath, degraded: false };
    }
    throw new Error("图像 API 返回既无 b64 也无 url");
  }
}
