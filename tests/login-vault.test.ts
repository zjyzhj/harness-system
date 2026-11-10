import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretStore } from "../core/secret-store";
import { LoginStore } from "../core/login-store";
import { ContactStore } from "../core/contacts";
import { Vault } from "../core/vault";
import { EnvStore } from "../core/env-store";
import { ConnectorStore } from "../core/connectors";
import { formatBrowserSnapshot, BROWSER_SNAPSHOT_SCRIPT } from "../core/browser-presence";

const cipher = {
  encrypt: (v: string) => `b64:${Buffer.from(v).toString("base64")}`,
  decrypt: (c: string) => Buffer.from(c.slice(4), "base64").toString("utf8"),
};

describe("LoginStore + Vault", () => {
  test("密码进 SecretStore，list 不回显", () => {
    const home = mkdtempSync(join(tmpdir(), "harness-login-"));
    const secrets = new SecretStore(home, cipher);
    const logins = new LoginStore(home, secrets);
    const e = logins.upsert({ website: "https://example.com", username: "u@x.com", password: "s3cret!", hint: "工作" });
    expect(e.secretName).toBeTruthy();
    expect(JSON.stringify(logins.list())).not.toContain("s3cret!");
    expect(logins.passwordOf(e.id)).toBe("s3cret!");
    const vault = new Vault({
      secrets, env: new EnvStore(home), contacts: new ContactStore(home),
      connectors: new ConnectorStore(home), logins,
    });
    expect(vault.catalog().logins).toBe(1);
    expect(vault.list().some((x) => x.kind === "login" && x.title.includes("example.com"))).toBe(true);
  });

  test("Contact 支持 phone / address / hint", () => {
    const home = mkdtempSync(join(tmpdir(), "harness-ct-"));
    const c = new ContactStore(home);
    const row = c.upsert({ name: "Ada", phone: "1", address: "SF", hint: "寄送" });
    expect(row.hint).toBe("寄送");
    expect(c.search("寄送")[0]?.name).toBe("Ada");
  });
});

describe("browser snapshot 密码脱敏", () => {
  test("脚本含 password redacted", () => {
    expect(BROWSER_SNAPSHOT_SCRIPT).toContain("[redacted]");
    expect(BROWSER_SNAPSHOT_SCRIPT).toContain("password");
  });

  test("formatBrowserSnapshot 保留元素", () => {
    const snap = formatBrowserSnapshot({
      url: "https://x.test/login",
      title: "Login",
      elements: [
        { selector: "#u", role: "textbox", name: "email", tag: "input", value: "a@b.c" },
        { selector: "#p", role: "textbox", name: "password", tag: "input", value: "[redacted]", password: true },
      ],
    } as any);
    expect(snap.text).toContain("e1");
    expect(snap.text).toContain("e2");
  });
});
