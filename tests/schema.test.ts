import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, ensureSchema } from "../core/schema";

describe("schema.json", () => {
  test("首次启动创建；再次调用保持版本", () => {
    const home = mkdtempSync(join(tmpdir(), "harness-schema-"));
    const a = ensureSchema(home);
    expect(a.created).toBe(true);
    expect(a.to).toBe(SCHEMA_VERSION);
    expect(existsSync(join(home, "schema.json"))).toBe(true);
    const raw = JSON.parse(readFileSync(join(home, "schema.json"), "utf8"));
    expect(raw.version).toBe(SCHEMA_VERSION);

    const b = ensureSchema(home);
    expect(b.created).toBe(false);
    expect(b.from).toBe(SCHEMA_VERSION);
    expect(b.to).toBe(SCHEMA_VERSION);
  });
});
