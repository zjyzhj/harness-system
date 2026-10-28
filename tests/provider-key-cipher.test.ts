import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";

const cipher = {
  encrypt: (v: string) => `enc:${Buffer.from(v).reverse().toString("base64")}`,
  decrypt: (c: string) => Buffer.from(c.slice(4), "base64").reverse().toString(),
};
const provider = (id: string, apiKey?: string) => ({ id, kind: "openai-compat" as const, name: id, baseUrl: "https://x/v1", apiKey, model: "m", isDefault: false, createdAt: Date.now() });

describe("模型 apiKey 加密落盘", () => {
  test("旧的明文 key 启动时改写成密文，内存里照常可用，文件只有本人可读", () => {
    const home = mkdtempSync(join(tmpdir(), "harness-keycipher-"));
    writeFileSync(join(home, "providers.json"), JSON.stringify({ p: provider("p", "sk-plain-123") }));
    const store = new Store(home);
    store.setKeyCipher(cipher);
    const disk = readFileSync(join(home, "providers.json"), "utf8");
    expect(disk).not.toContain("sk-plain-123");
    expect(disk).toContain('"apiKey": "enc:');
    expect(statSync(join(home, "providers.json")).mode & 0o777).toBe(0o600);
    expect(store.getProvider("p")!.apiKey).toBe("sk-plain-123");

    store.saveProvider(provider("q", "sk-new-456"));
    expect(readFileSync(join(home, "providers.json"), "utf8")).not.toContain("sk-new-456");
    const again = new Store(home);
    again.setKeyCipher(cipher);
    expect(again.getProvider("q")!.apiKey).toBe("sk-new-456");
  });

  test("解不开的密文不会在下次写盘时被抹掉", () => {
    const home = mkdtempSync(join(tmpdir(), "harness-keycipher-"));
    writeFileSync(join(home, "providers.json"), JSON.stringify({ p: provider("p", "enc:坏的") }));
    const store = new Store(home);
    store.setKeyCipher({ ...cipher, decrypt: () => { throw new Error("钥匙串拒绝"); } });
    expect(store.getProvider("p")!.apiKey).toBeUndefined();
    store.saveProvider({ ...store.getProvider("p")!, name: "改名" });
    expect(readFileSync(join(home, "providers.json"), "utf8")).toContain("enc:坏的");
  });
});
