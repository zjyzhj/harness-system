import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import { MemorySystem } from "../core/memory-system";
import { SkillRegistry } from "../core/skill-registry";
import { SecretStore } from "../core/secret-store";
import { EnvStore, looksSecret } from "../core/env-store";
import { BotRuntime } from "../core/bot-runtime";
import { ProviderCenter } from "../core/provider-center";
import { runShell } from "../core/tool-executor";
import { MigrationV2 } from "../core/migration-v2";
import { Scheduler } from "../core/scheduler";
import { ProjectRegistry } from "../core/projects";
import { ConsentCenter } from "../core/consent-center";
import { AuditLog } from "../core/audit-log";
import { McpClient } from "../core/mcp-client";
import { readFileSync, writeFileSync } from "node:fs";
import type { Bot, ContentBlock } from "../core/types";

const home = mkdtempSync(join(tmpdir(), "harness-env-"));
const store = new Store(home);
afterAll(() => store.close());
const identity = { encrypt: (v: string) => `x:${v}`, decrypt: (c: string) => c.slice(2) };
const mk = (id: string, name: string): Bot => ({ id, name, role: "助手", persona: "", providerId: "", petEnabled: false, createdAt: Date.now() });
store.saveBot(mk("a", "运维"));
store.saveBot(mk("b", "提审"));
const tool = (name: string, args: object) => "```tool\n" + JSON.stringify({ tool: name, args }) + "\n```";

class Scripted extends ProviderCenter {
  calls = 0;
  scripts: string[] = [];
  systems: string[] = [];
  override async streamComplete(_p: any, req: any): Promise<any> {
    this.systems.push(String(req.system ?? ""));
    const text = this.scripts[this.calls++] ?? "完成";
    req._onChunk({ type: "text", text });
    return { text, content: [{ type: "text", text }] };
  }
}

const env = new EnvStore(home);
const secrets = new SecretStore(home, identity);
const providers = new Scripted(store);
providers.addProvider({ kind: "openai-compat", name: "DeepSeek", baseUrl: "https://fake/v1", apiKey: "x", model: "deepseek-chat", isDefault: true });
const audit = new AuditLog(home);
const rt = new BotRuntime({ store, providers, memory: new MemorySystem(home), skills: new SkillRegistry(join(home, "skills")), secrets, env, audit, workspaceRoot: join(home, "ws") });
const run = async (scripts: string[], bot = store.getBot("a")!) => {
  providers.calls = 0;
  providers.scripts = scripts;
  providers.systems = [];
  const sid = `s-${Math.random()}`;
  await rt.handleStream({ bot, from: "user", text: "开始", sessionId: sid }, { onBlock: () => {} });
  return store.listMessages(sid).at(-1)!.content as ContentBlock[];
};
const resultOf = (saved: ContentBlock[]) => (saved.find((b) => b.type === "tool_call") as any).result as string;

describe("EnvStore", () => {
  test("自己的覆盖共用的，别的 bot 看不到；文件只有本人可读", () => {
    const e = new EnvStore(mkdtempSync(join(tmpdir(), "harness-env-s-")));
    e.set({ key: "region", value: "cn" });
    e.set({ key: "REGION", value: "us", botId: "a" });
    expect(e.envFor("a")).toEqual({ REGION: "us" });
    expect(e.envFor("b")).toEqual({ REGION: "cn" });
    expect(e.remove("REGION", "a")).toBe(true);
    expect(e.envFor("a")).toEqual({ REGION: "cn" });
  });

  test("识别像密钥的配置", () => {
    expect(looksSecret("DB_PASSWORD", "x")).toBe(true);
    expect(looksSecret("GITHUB", "ghp_abcdefghijklmnopqrstuvwxyz")).toBe(true);
    expect(looksSecret("FEISHU_APP_ID", "cli_a1b2")).toBe(false);
  });
});

describe("bot 记得自己配置过什么", () => {
  test("env.set 保存，密码类拒绝并引导 ui.secret", async () => {
    const ok = await run([tool("env.set", { key: "feishu_app_id", value: "cli_123", label: "飞书应用 ID", note: "提审通知用" }), "好了"]);
    expect(resultOf(ok)).toContain("FEISHU_APP_ID=cli_123");
    expect(env.envFor("a").FEISHU_APP_ID).toBe("cli_123");
    expect(env.envFor("b").FEISHU_APP_ID).toBeUndefined();
    const bad = await run([tool("env.set", { key: "FEISHU_APP_SECRET", value: "abc" }), "好"]);
    expect(resultOf(bad)).toContain("ui.secret");
    expect(env.envFor("a").FEISHU_APP_SECRET).toBeUndefined();
    expect(statSync(join(home, "env.json")).mode & 0o077).toBe(0);
  });

  test("下一轮系统提示里列出配置和密钥名，不含密钥值", async () => {
    secrets.set("FEISHU_APP_SECRET", "s3cr3t-value", "飞书 App Secret", { note: "发提审通知", savedBy: "a" });
    await run(["你好"]);
    const sys = providers.systems[0];
    expect(sys).toContain("【已配置的环境】");
    expect(sys).toContain("FEISHU_APP_ID=cli_123（飞书应用 ID）：提审通知用");
    expect(sys).toContain("FEISHU_APP_SECRET（飞书 App Secret）：发提审通知 [所有 bot 共用] · 你在");
    expect(sys).not.toContain("s3cr3t-value");
    expect(sys).toContain("共有 2 个 bot");
    expect(sys.indexOf("【团队】")).toBeLessThan(sys.indexOf("【交互】"));
  });

  test("runShell 注入环境变量", async () => {
    const out = await runShell('echo "$FEISHU_APP_ID"', { timeoutMs: 5000, maxBytes: 4096, env: { FEISHU_APP_ID: "cli_123" } });
    expect(out).toContain("cli_123");
  }, 15_000);
});

describe("密钥分 bot", () => {
  test("私有密钥只有主人能看到和使用，共用的大家都能用", async () => {
    secrets.set("A_ONLY", "aaaa-secret", "A 的", { savedBy: "a", botId: "a" });
    secrets.set("SHARED_TOKEN", "shared-secret", "共用");
    expect(secrets.list("b").map((x) => x.name)).not.toContain("A_ONLY");
    expect(secrets.list("b").map((x) => x.name)).toContain("SHARED_TOKEN");
    expect(secrets.get("A_ONLY", "b")).toBeUndefined();
    expect(secrets.get("A_ONLY", "a")).toBe("aaaa-secret");
    expect(secrets.referencedIn("curl -H $A_ONLY $SHARED_TOKEN", "b")).toEqual(["SHARED_TOKEN"]);
    expect(secrets.fill({ h: "{{secret:A_ONLY}}" }, "b").missing).toEqual(["A_ONLY"]);
    await run(["你好"], store.getBot("b")!);
    expect(providers.systems[0]).not.toContain("A_ONLY");
    expect(providers.systems[0]).toContain("SHARED_TOKEN（共用） [所有 bot 共用]");
  });

  test("ui.secret 不能占用别人私有的名字；scope:all 生成共用卡片", async () => {
    const taken = await run([tool("ui.secret", { name: "A_ONLY", label: "x" }), "好"], store.getBot("b")!);
    expect(taken.some((b) => b.type === "secret")).toBe(false);
    expect(providers.calls).toBe(2);
    const card = await run([tool("ui.secret", { name: "TEAM_KEY", label: "团队 Key", scope: "all" })]);
    expect(card.at(-1)).toMatchObject({ type: "secret", name: "TEAM_KEY", scope: "all" });
  });

  test("用了密钥、改了配置都写审计", async () => {
    await run([tool("env.set", { key: "API_BASE", value: "https://api.example.com" }), "好"]);
    await run([tool("notify", { title: "t", body: "{{secret:SHARED_TOKEN}}" }), "好"]);
    const evs = audit.query({ limit: 50 }) as any[];
    expect(evs.some((e) => e.cap === "config" && e.action === "env.set" && e.args.startsWith("API_BASE="))).toBe(true);
    expect(evs.some((e) => e.cap === "secret" && e.action === "use:notify" && e.args === "SHARED_TOKEN")).toBe(true);
  });
});

describe("MCP 引用加密密钥", () => {
  test("启动 stdio server 时 {{secret:}} 才换成真值", async () => {
    const script = join(home, "echo-env.sh");
    const out = join(home, "mcp-env.txt");
    writeFileSync(script, `printf '%s' "$TOKEN" > '${out}'\n`);
    const mcp = new McpClient([{ id: "x", name: "x", command: "/bin/sh", args: [script], env: { TOKEN: "{{secret:SHARED_TOKEN}}" } }]);
    mcp.setSecretFiller((m) => secrets.fill(m).args as Record<string, string>);
    await mcp.init();
    await Bun.sleep(100);
    expect(readFileSync(out, "utf8")).toBe("shared-secret");
    mcp.close();
  });
});

describe("迁移补全", () => {
  test("配置、项目、命令规则、密钥名单随迁移往返", () => {
    const projects = new ProjectRegistry(home);
    const p = projects.create("提审", "按规范出文案");
    const consent = new ConsentCenter(home);
    consent.setCommandRule("a", "cursor", "allow");
    const src = new MigrationV2(store, join(home, "assets"), new MemorySystem(home), new SkillRegistry(join(home, "skills")), new Scheduler(home));
    src.attachExtras({ env, secrets, projects, consent });
    const payload = src.exportPayload();
    expect(payload.env?.some((e) => e.key === "FEISHU_APP_ID")).toBe(true);
    expect(payload.projects?.[0].name).toBe("提审");
    expect(JSON.stringify(payload)).not.toContain("aaaa-secret");

    const home2 = mkdtempSync(join(tmpdir(), "harness-env-dst-"));
    const store2 = new Store(home2);
    const env2 = new EnvStore(home2), projects2 = new ProjectRegistry(home2), consent2 = new ConsentCenter(home2);
    const dst = new MigrationV2(store2, join(home2, "assets"), new MemorySystem(home2), new SkillRegistry(join(home2, "skills")), new Scheduler(home2));
    dst.attachExtras({ env: env2, secrets: new SecretStore(home2, identity), projects: projects2, consent: consent2 });
    const r = dst.importFromPayload(payload);
    const newA = store2.listBots().find((b) => b.name === "运维")!;
    expect(env2.envFor(newA.id).FEISHU_APP_ID).toBe("cli_123");
    expect(projects2.list().map((x) => x.name)).toEqual(["提审"]);
    expect(consent2.commandRule(newA.id, "cursor")).toBe("allow");
    expect(r.secretsToReenter.find((x) => x.name === "A_ONLY")?.bot).toBe("运维");
    expect(r.importedProjects).toBe(1);
    store2.close();
    void p;
  });
});
