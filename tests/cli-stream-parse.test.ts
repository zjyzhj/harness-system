import { describe, expect, test } from "bun:test";
import { parseStreamLine } from "../core/adapters/cli";

describe("cursor stream-json 解析", () => {
  test("stream-partial-output 碎片增量要逐片追加，不能丢掉", () => {
    const frags = ["春天", "是", "万物", "复苏", "的", "季节", "。"];
    let acc = "";
    const deltas: string[] = [];
    for (const f of frags) {
      const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: f }] } });
      const r = parseStreamLine("cursor", line, acc);
      expect(r.delta).toBe(f);
      acc += r.delta!;
      deltas.push(r.delta!);
    }
    expect(acc).toBe("春天是万物复苏的季节。");
    expect(deltas).toEqual(frags);
  });

  test("全文快照只取相对 acc 的后缀", () => {
    let acc = "春天";
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "春天是万物复苏的季节。" }] } });
    const r = parseStreamLine("cursor", line, acc);
    expect(r.delta).toBe("是万物复苏的季节。");
  });

  test("完整重发与更短回退快照要跳过", () => {
    const acc = "春天是万物复苏的季节。";
    expect(parseStreamLine("cursor", JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: acc }] } }), acc)).toEqual({});
    expect(parseStreamLine("cursor", JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "春天" }] } }), acc)).toEqual({});
  });

  test("thinking delta 单独返回", () => {
    const r = parseStreamLine("cursor", JSON.stringify({ type: "thinking", subtype: "delta", text: "正在构思" }), "");
    expect(r).toEqual({ thinking: "正在构思" });
  });
});
