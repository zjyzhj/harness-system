import { describe, expect, test } from "bun:test";
import { resolveTemplateInput } from "../core/share-bridge";

describe("share-bridge resolveTemplateInput", () => {
  test("非 URL 原样返回", async () => {
    expect(await resolveTemplateInput("  harnessbot://bot/abc  ")).toBe("harnessbot://bot/abc");
    expect(await resolveTemplateInput('{"v":2,"name":"x","role":"","persona":"","skills":[]}')).toContain('"v":2');
  });

  test("任意 HTTPS 不拉（防 SSRF）", async () => {
    await expect(resolveTemplateInput("https://example.com/b/abc")).rejects.toThrow(/短链桥/);
    await expect(resolveTemplateInput("https://127.0.0.1/b/x")).rejects.toThrow(/短链桥/);
  });
});
