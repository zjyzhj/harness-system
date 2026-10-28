import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import type { ContentBlock } from "../core/types";

const png = `data:image/png;base64,${Buffer.from("fake-png-bytes").toString("base64")}`;

describe("会话里的图片存成文件", () => {
  test("新消息里的内嵌图片落盘，jsonl 只留路径，同一张图只存一份", () => {
    const home = mkdtempSync(join(tmpdir(), "harness-img-"));
    const store = new Store(home);
    for (const sid of ["s1", "s1", "s2"]) {
      store.addMessage({ sessionId: sid, from: "user", to: "a", role: "user", kind: "chat", createdAt: Date.now(), content: [{ type: "text", text: "看图" }, { type: "image", dataUrl: png, alt: "粘贴图片" }] });
    }
    expect(readFileSync(join(home, "sessions", "s1.jsonl"), "utf8")).not.toContain("base64");
    const img = (store.listMessages("s1")[0].content as ContentBlock[])[1] as Extract<ContentBlock, { type: "image" }>;
    expect(img.alt).toBe("粘贴图片");
    expect(readFileSync(img.path!, "utf8")).toBe("fake-png-bytes");
    const img2 = (store.listMessages("s2")[0].content as ContentBlock[])[1] as Extract<ContentBlock, { type: "image" }>;
    expect(img2.path).toBe(img.path);
  });

  test("旧会话一次性整理：内嵌图片挪成文件，其它内容不变", () => {
    const home = mkdtempSync(join(tmpdir(), "harness-img-"));
    mkdirSync(join(home, "sessions"));
    const old = { id: 1, sessionId: "old", from: "a", to: "user", role: "assistant", kind: "chat", createdAt: 1, content: [{ type: "text", text: "📸 截图" }, { type: "image", dataUrl: png }] };
    appendFileSync(join(home, "sessions", "old.jsonl"), JSON.stringify(old) + "\n");
    const store = new Store(home);
    expect(store.offloadInlineImages()).toBe(1);
    const raw = readFileSync(join(home, "sessions", "old.jsonl"), "utf8");
    expect(raw).not.toContain("base64");
    const blocks = store.listMessages("old")[0].content as ContentBlock[];
    expect((blocks[0] as any).text).toBe("📸 截图");
    expect(existsSync((blocks[1] as any).path)).toBe(true);
    expect(store.offloadInlineImages()).toBe(0);
  });
});
