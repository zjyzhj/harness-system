import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContactStore } from "../core/contacts";
import { ConnectorStore } from "../core/connectors";
import { Vault } from "../core/vault";
import { SecretStore } from "../core/secret-store";
import { EnvStore } from "../core/env-store";
import { Orchestrator } from "../core/orchestrator";
import { Store } from "../core/store";
import { uiTool } from "../core/runtime/tool-helpers";
import { BUILTIN_SKILL_TEMPLATES } from "../core/skill-registry";
import { MAX_ATTACH_COPY_BYTES } from "../core/attachments";

const cipher = {
  encrypt: (s: string) => `b64:${Buffer.from(s).toString("base64")}`,
  decrypt: (c: string) => Buffer.from(c.slice(4), "base64").toString("utf8"),
};

describe("Vault + contacts + connectors", () => {
  test("聚合 list/search；联系人与 webhook", () => {
    const home = mkdtempSync(join(tmpdir(), "harness-vault-"));
    const secrets = new SecretStore(home, cipher);
    const env = new EnvStore(home);
    const contacts = new ContactStore(home);
    const connectors = new ConnectorStore(home);
    secrets.set("API_KEY", "secret-value", "接口密钥");
    env.set({ key: "BASE_URL", value: "https://example.com", updatedBy: "user" });
    contacts.upsert({ name: "小周", email: "a@b.com", note: "同事" });
    connectors.upsertWebhook({ name: "钩子", url: "https://hooks.example/x", note: "{{secret:API_KEY}}" });

    const vault = new Vault({
      secrets,
      env,
      contacts,
      connectors,
      mcp: () => [{ id: "m1", name: "demo-mcp", tools: 2 }],
      cli: () => [{ id: "bash", name: "Shell", ready: true }],
    });
    const all = vault.list();
    expect(all.some((x) => x.kind === "secret" && x.id === "API_KEY")).toBe(true);
    expect(JSON.stringify(all)).not.toContain("secret-value");
    expect(vault.search("小周").some((x) => x.kind === "contact")).toBe(true);
    expect(vault.contact("小周")?.email).toBe("a@b.com");
    expect(vault.catalog().webhooks).toBe(1);
    expect(vault.catalog().mcp[0].name).toBe("demo-mcp");
  });
});

describe("Orchestrator handOff", () => {
  test("移交阶段负责人", () => {
    const home = mkdtempSync(join(tmpdir(), "harness-hand-"));
    const store = new Store(home);
    store.saveBot({ id: "a", name: "甲", role: "r", persona: "", providerId: "", petEnabled: false, createdAt: 1 });
    store.saveBot({ id: "b", name: "乙", role: "r", persona: "", providerId: "", petEnabled: false, createdAt: 1 });
    const orch = new Orchestrator({ store }, home);
    const plan = orch.create({
      ownerBotId: "user",
      title: "接力",
      stages: [{ botId: "a", prompt: "第一步调研" }],
    });
    const r = orch.handOff({ planId: plan.id, toBotId: "b", note: "乙接着做" });
    expect(r.stage.ownerBotId).toBe("b");
    expect(r.stage.handOffNote).toBe("乙接着做");
    expect(orch.currentOwner(r.plan)).toBe("b");
  });
});

describe("ui.form + 流程模板", () => {
  test("ui.form 产出 form 块", () => {
    const out = uiTool("ui.form", {
      title: "日报",
      fields: [
        { key: "done", label: "今日完成", required: true },
        { key: "next", label: "明日", type: "textarea" },
      ],
    });
    expect(out.halt).toBe(true);
    const block = out.blocks?.[0];
    expect(block?.type).toBe("form");
    if (block?.type === "form") {
      expect(block.fields.length).toBe(2);
      expect(block.title).toBe("日报");
    }
  });

  test("内置日报/分诊/调研写作模板", () => {
    expect(BUILTIN_SKILL_TEMPLATES["daily-report"]).toContain("日报");
    expect(BUILTIN_SKILL_TEMPLATES["triage"]).toContain("分诊");
    expect(BUILTIN_SKILL_TEMPLATES["research-write"]).toContain("调研");
  });

  test("附件上限常量约 100MB", () => {
    expect(MAX_ATTACH_COPY_BYTES).toBe(100 * 1024 * 1024);
  });
});
