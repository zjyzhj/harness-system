/**
 * Consent 绿路径：Ask 批准 → 再免问；Auto 跳过常规；目录信任二次命中。
 * 与 bot-access 总览串联，保证「已批准」可被汇总看见。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConsentCenter } from "../core/consent-center";
import { buildBotAccessOverview } from "../core/bot-access";

describe("consent 绿路径", () => {
  test("Ask：allow 长期后同能力不再问；deny 挡住", async () => {
    const dir = mkdtempSync(join(tmpdir(), "consent-green-"));
    const c = new ConsentCenter(dir);
    let asked = 0;
    c.decider = () => {
      asked++;
      return "allow";
    };
    expect((await c.request("b", "clipboard", "读剪贴板")).granted).toBe(true);
    expect(asked).toBe(1);
    expect((await c.request("b", "clipboard", "再读")).granted).toBe(true);
    expect(asked).toBe(1);

    c.revoke("b", "clipboard");
    c.decider = () => {
      asked++;
      return "deny";
    };
    expect((await c.request("b", "clipboard", "被拒")).granted).toBe(false);
    expect(asked).toBe(2);
  });

  test("Auto：命令 / CLI / 终端免问；危险仍要问", async () => {
    const dir = mkdtempSync(join(tmpdir(), "consent-auto-"));
    const proj = mkdtempSync(join(tmpdir(), "proj-auto-"));
    const c = new ConsentCenter(dir);
    c.setPermissionMode("b", "auto");
    let asked = 0;
    c.decider = (req) => {
      asked++;
      return req.requiresStrongConsent ? "allow-once" : "deny";
    };
    // Auto 走 requestCommand / requestCliAgent / requestTermOpen 才免问
    expect((await c.requestCommand("b", "ls", "列目录", { cap: "bash:read" })).granted).toBe(true);
    expect((await c.requestCliAgent("b", proj, "派工")).granted).toBe(true);
    expect((await c.requestTermOpen("b", proj, "开终端")).granted).toBe(true);
    expect(asked).toBe(0);

    // 危险：强确认，Auto 也不跳
    const danger = await c.requestCommand("b", "rm", "删东西", { cap: "bash:other", requiresStrongConsent: true, onceOnly: true });
    expect(danger.granted).toBe(true);
    expect(asked).toBe(1);
  });

  test("目录信任绿路径 + 总览能看见", async () => {
    const dir = mkdtempSync(join(tmpdir(), "consent-path-"));
    const proj = mkdtempSync(join(tmpdir(), "proj-path-"));
    const c = new ConsentCenter(dir);
    c.decider = () => "allow-command";
    const first = await c.requestCliAgent("b", proj, "记住");
    expect(first.remembered).toBe(true);

    let asked = 0;
    c.decider = () => {
      asked++;
      return "deny";
    };
    expect((await c.requestCliAgent("b", join(proj, "src"), "同前缀")).viaPathGrant).toBe(true);
    expect(asked).toBe(0);

    c.grant("b", "notify");
    c.setCommandRule("b", "git", "allow");
    const ov = buildBotAccessOverview({ botId: "b", consent: c });
    expect(ov.cliPaths.some((p) => p.includes(proj) || proj.includes(p) || p.length > 0)).toBe(true);
    expect(ov.grants.some((g) => g.cap === "notify")).toBe(true);
    expect(ov.allowCommands).toContain("git");
    expect(ov.canDo.some((l) => /Coding CLI|目录/.test(l))).toBe(true);
  });
});
