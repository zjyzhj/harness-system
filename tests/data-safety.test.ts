import { describe, test, expect } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLinesSafe, parseJsonl, readJsonSafe, writeJsonAtomic } from "../core/atomic-fs";
import { Store } from "../core/store";
import { MemorySystem } from "../core/memory-system";
import { SecretStore } from "../core/secret-store";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe("原子写入与坏文件", () => {
  test("写入后没有残留临时文件", () => {
    const d = tmp("harness-atomic-");
    writeJsonAtomic(join(d, "a.json"), { x: 1 });
    expect(readdirSync(d)).toEqual(["a.json"]);
    expect(readJsonSafe<unknown>(join(d, "a.json"), null)).toEqual({ x: 1 });
  });

  test("坏 JSON 先备份再用默认值", () => {
    const d = tmp("harness-corrupt-");
    const f = join(d, "bots.json");
    writeFileSync(f, '{"a": {"name": "半截');
    expect(readJsonSafe(f, { ok: true })).toEqual({ ok: true });
    const backups = readdirSync(d).filter((n) => n.startsWith("bots.json.corrupt-"));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(d, backups[0]), "utf8")).toContain("半截");
  });

  test("Store：bots.json 损坏时不会被新数据直接覆盖掉", () => {
    const d = tmp("harness-store-");
    writeFileSync(join(d, "bots.json"), "{broken");
    const s = new Store(d);
    s.saveBot({ id: "b1", name: "新", createdAt: 1 } as never);
    expect(readdirSync(d).some((n) => n.startsWith("bots.json.corrupt-"))).toBe(true);
  });

  test("Store：config.json 损坏不再让 readConfig 抛错", () => {
    const d = tmp("harness-cfg-");
    writeFileSync(join(d, "config.json"), "{oops");
    expect(new Store(d).readConfig()).toEqual({});
  });

  test("密钥文件损坏：先备份，不会在下次保存时把旧密钥全丢掉", () => {
    const d = tmp("harness-secret-");
    writeFileSync(join(d, "secrets.json"), '{"A": {"value": "x"');
    const s = new SecretStore(d, { encrypt: (x) => x, decrypt: (x) => x });
    s.set("B", "2");
    expect(readdirSync(d).some((n) => n.startsWith("secrets.json.corrupt-"))).toBe(true);
  });

  test("记忆文件损坏：备份并跳过", () => {
    const d = tmp("harness-mem-");
    mkdirSync(join(d, "memory"), { recursive: true });
    writeFileSync(join(d, "memory", "bot:x.json"), "[{");
    const m = new MemorySystem(d);
    expect(m.list("x")).toEqual([]);
    expect(readdirSync(join(d, "memory")).some((n) => n.includes(".corrupt-"))).toBe(true);
  });
});

describe("jsonl 逐行容错", () => {
  test("坏行跳过，其它记录保留", () => {
    expect(parseJsonl('{"a":1}\n{"b":\n{"c":3}\n')).toEqual([{ a: 1 }, { c: 3 }]);
  });

  test("上次写了半行：追加时补换行，新记录完好", () => {
    const d = tmp("harness-jsonl-");
    const f = join(d, "s.jsonl");
    appendFileSync(f, '{"id":1}\n{"id":2,"half');
    appendLinesSafe(f, ['{"id":3}']);
    expect(parseJsonl<{ id: number }>(readFileSync(f, "utf8")).map((x) => x.id)).toEqual([1, 3]);
  });

  test("Store 会话里有坏行也能读出其它消息", () => {
    const d = tmp("harness-sess-");
    mkdirSync(join(d, "sessions"));
    writeFileSync(join(d, "sessions", "s1.jsonl"), '{"id":1,"sessionId":"s1","content":"a"}\n{bad\n{"id":2,"sessionId":"s1","content":"b"}\n');
    expect(new Store(d).listMessages("s1").length).toBe(2);
    expect(existsSync(join(d, "sessions", "s1.jsonl"))).toBe(true);
  });
});
