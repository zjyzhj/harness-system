import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store";
import { ProviderCenter } from "../core/provider-center";
import { RealmStore } from "../core/realm/store";
import { RealmRuntime } from "../core/realm/runtime";
import { buildPresenceSystemPrompt } from "../core/realm/prompt";
import { PRESENCE_CONSENT_STATEMENT, presenceSessionOwner, parsePresenceOwner } from "../core/realm/types";
import { resolveCloneMode } from "../core/adapters/tts";
import { contentText } from "../core/types";

let home: string;
let store: Store;
let realm: RealmStore;
let providers: ProviderCenter;
let runtime: RealmRuntime;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "harness-realm-"));
  store = new Store(home);
  store.saveProvider({
    id: "p1", kind: "openai-compat", name: "假模型",
    baseUrl: "https://fake.example/v1", apiKey: "x", model: "m", isDefault: true, createdAt: 1,
  });
  realm = new RealmStore(home);
  providers = new ProviderCenter(store);
  runtime = new RealmRuntime(realm, store, providers, () => null, (v) => String(v ?? ""));
});

afterAll(() => {
  store.close();
});

describe("灵境 Presence", () => {
  test("session owner 前缀与 bot 隔离", () => {
    expect(presenceSessionOwner("p-1")).toBe("presence:p-1");
    expect(parsePresenceOwner("presence:p-1")).toBe("p-1");
    expect(parsePresenceOwner("b1")).toBeNull();
  });

  test("创建必须确认授权", () => {
    expect(() => runtime.create({
      name: "外婆", providerId: "p1", consentRole: "kin", consentAffirmed: false,
    })).toThrow(/授权/);
  });

  test("创建 Presence 落盘且不进 bots", () => {
    const p = runtime.create({
      name: "外婆",
      relation: "外婆",
      bio: "爱做红烧肉",
      styleNotes: "叫我囡囡",
      corpus: "囡囡啊，吃饭了没",
      providerId: "p1",
      consentRole: "kin",
      consentAffirmed: true,
    });
    expect(p.id).toMatch(/^p-/);
    expect(p.consent.statement).toBe(PRESENCE_CONSENT_STATEMENT);
    expect(p.voice.status).toBe("none");
    expect(realm.get(p.id)?.name).toBe("外婆");
    expect(existsSync(join(home, "realm", p.id))).toBe(true);
    expect(store.listBots().find((b) => b.id === p.id)).toBeUndefined();
  });

  test("系统提示锚定痕迹且标明 AI 再现", () => {
    const p = realm.list()[0];
    const sys = buildPresenceSystemPrompt(p);
    expect(sys).toContain("外婆");
    expect(sys).toContain("AI 再现");
    expect(sys).toContain("红烧肉");
    expect(sys).toContain("囡囡");
  });

  test("cloneMode 解析不绑死供应商", () => {
    expect(resolveCloneMode({ baseUrl: "https://x/v1", model: "tts-1", cloneMode: "none" })).toBe("none");
    expect(resolveCloneMode({ baseUrl: "https://x/v1", model: "m", uploadPath: "/uploads/audio/voice" })).toBe("upload");
    expect(resolveCloneMode({ baseUrl: "https://x/v1", model: "Foo/CosyVoice2" })).toBe("inline");
    expect(resolveCloneMode({ baseUrl: "https://x/v1", model: "gpt-4o-mini-tts" })).toBe("none");
  });

  test("参考音保存 + 无 TTS 配置时 bindVoice 失败并记 error", async () => {
    const p = realm.list()[0];
    const ref = join(realm.voiceDir(p.id), "ref.wav");
    writeFileSync(ref, Buffer.from("RIFF....WAVEfmt ")); // stub
    await expect(runtime.bindVoice(p.id, { refPath: ref, refText: "囡囡吃饭了没" })).rejects.toThrow(/语音合成|未配置/);
    expect(realm.get(p.id)?.voice.status).toBe("error");
  });

  test("inline 模式只存本机参考音即可 ready", async () => {
    const rt = new RealmRuntime(realm, store, providers, () => ({
      baseUrl: "https://example.test/v1", model: "Any/CloneModel", cloneMode: "inline", apiKey: "x",
    }), (v) => String(v ?? ""));
    const p = rt.create({ name: "测", providerId: "p1", consentRole: "self", consentAffirmed: true });
    const ref = join(realm.voiceDir(p.id), "ref.wav");
    writeFileSync(ref, Buffer.from("RIFF"));
    const next = await rt.bindVoice(p.id, { refPath: ref, refText: "你好" });
    expect(next.voice.status).toBe("ready");
    expect(next.voice.refPath).toBe(ref);
    expect(next.voice.remoteVoiceId).toBeUndefined();
  });

  test("none 模式用 voice 名绑定", async () => {
    const rt = new RealmRuntime(realm, store, providers, () => ({
      baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-tts", cloneMode: "none", apiKey: "x",
    }), (v) => String(v ?? ""));
    const p = rt.create({ name: "测2", providerId: "p1", consentRole: "self", consentAffirmed: true });
    const next = await rt.bindVoice(p.id, { refText: "coral", voiceName: "coral" });
    expect(next.voice.status).toBe("ready");
    expect(next.voice.remoteVoiceId).toBe("coral");
  });

  test("audio 内容块不进入 contentText", () => {
    expect(contentText([
      { type: "text", text: "你好" },
      { type: "audio", path: "/tmp/a.mp3" },
    ])).toBe("你好");
  });

  test("封存与删除", () => {
    const p = runtime.create({
      name: "临时", providerId: "p1", consentRole: "self", consentAffirmed: true,
    });
    realm.archive(p.id);
    expect(realm.list().find((x) => x.id === p.id)).toBeUndefined();
    expect(realm.list(true).find((x) => x.id === p.id)?.archived).toBe(true);
    realm.remove(p.id);
    expect(realm.get(p.id)).toBeUndefined();
    expect(existsSync(join(home, "realm", p.id))).toBe(false);
  });
});
