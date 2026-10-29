import type { ChatMessage, ContentBlock, Provider } from "../types";
import type { ProviderCenter } from "../provider-center";
import type { Store } from "../store";
import { resolveCloneMode, synthesizeSpeech, uploadVoiceClone, type SpeakInput } from "../adapters/tts";
import { buildPresenceSystemPrompt } from "./prompt";
import type { RealmStore } from "./store";
import {
  PRESENCE_CONSENT_STATEMENT,
  presenceSessionOwner,
  type Presence,
  type PresenceConsentRole,
  type TtsConfig,
} from "./types";

export interface CreatePresenceInput {
  name: string;
  relation?: string;
  bio?: string;
  styleNotes?: string;
  corpus?: string;
  providerId: string;
  consentRole: PresenceConsentRole;
  /** 必须为 true，且声明与内置文案一致 */
  consentAffirmed: boolean;
}

export interface RealmTurnResult {
  sessionId: string;
  userMsg: ChatMessage;
  replyMsg: ChatMessage;
  text: string;
  audioPath?: string;
  audioError?: string;
}

function id(): string {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export class RealmRuntime {
  constructor(
    private realm: RealmStore,
    private store: Store,
    private providers: ProviderCenter,
    private getTts: () => TtsConfig | null,
    private openKey: (v: unknown) => string,
  ) {}

  create(input: CreatePresenceInput): Presence {
    const name = input.name.trim();
    if (!name) throw new Error("请填写称呼");
    if (!input.consentAffirmed) throw new Error("须确认授权声明后才能创建");
    if (!input.providerId) throw new Error("请选择对话模型");
    const now = Date.now();
    const p: Presence = {
      id: id(),
      name,
      relation: input.relation?.trim() || undefined,
      bio: input.bio?.trim() || undefined,
      styleNotes: input.styleNotes?.trim() || undefined,
      corpus: input.corpus?.trim() || undefined,
      providerId: input.providerId,
      consent: {
        affirmedAt: now,
        role: input.consentRole,
        statement: PRESENCE_CONSENT_STATEMENT,
      },
      voice: { status: "none" },
      createdAt: now,
      updatedAt: now,
    };
    this.realm.save(p);
    this.realm.dirOf(p.id);
    return p;
  }

  private ttsCfg(): TtsConfig {
    const raw = this.getTts();
    if (!raw?.baseUrl || !raw?.model) throw new Error("未配置语音合成：灵境 → 音色设置，填任意兼容供应商的 Base URL / 模型 / Key");
    return { ...raw, apiKey: this.openKey(raw.apiKey) };
  }

  private speakOpts(p: Presence, text: string): SpeakInput {
    return {
      text,
      voice: p.voice.remoteVoiceId,
      refPath: p.voice.refPath,
      refText: p.voice.refText,
    };
  }

  private assertVoiceReady(p: Presence) {
    const mode = resolveCloneMode(this.ttsCfg());
    if (mode === "inline" && p.voice.refPath) return;
    if (p.voice.remoteVoiceId) return;
    throw new Error("请先绑定音色（上传参考音，或填写预设 voice 名）");
  }

  /**
   * 绑定音色：
   * - upload → 上传注册 remoteVoiceId
   * - inline → 只存本机参考音
   * - none → 把 refText 当作 voice 名（或 opts.voiceName）
   */
  async bindVoice(presenceId: string, opts: { refPath?: string; refText: string; voiceName?: string }): Promise<Presence> {
    const p = this.realm.get(presenceId);
    if (!p) throw new Error("找不到该 Presence");
    try {
      const cfg = this.ttsCfg();
      const mode = resolveCloneMode(cfg);
      const now = Date.now();
      if (mode === "none") {
        const voice = (opts.voiceName || opts.refText || cfg.defaultVoice || "").trim();
        if (!voice) throw new Error("当前为「预设音色」模式，请填写 voice 名（如 alloy）");
        return this.realm.update(presenceId, {
          voice: { status: "ready", remoteVoiceId: voice, refText: voice, clonedAt: now, error: undefined },
        });
      }
      if (!opts.refPath) throw new Error("请提供参考音频");
      if (mode === "inline") {
        return this.realm.update(presenceId, {
          voice: {
            status: "ready",
            refPath: opts.refPath,
            refText: opts.refText.trim(),
            remoteVoiceId: undefined,
            clonedAt: now,
            error: undefined,
          },
        });
      }
      // upload
      const remoteVoiceId = await uploadVoiceClone(cfg, {
        refPath: opts.refPath,
        refText: opts.refText,
        customName: `lingjing-${p.id.slice(0, 12)}`,
      });
      return this.realm.update(presenceId, {
        voice: {
          status: "ready",
          remoteVoiceId,
          refPath: opts.refPath,
          refText: opts.refText.trim(),
          clonedAt: now,
          error: undefined,
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.realm.update(presenceId, {
        voice: { status: "error", refPath: opts.refPath, refText: opts.refText, error: msg },
      });
      throw e;
    }
  }

  /** 试听：固定短句，用已绑定音色 */
  async previewVoice(presenceId: string, text?: string): Promise<string> {
    const p = this.realm.get(presenceId);
    if (!p || p.voice.status !== "ready") throw new Error("请先绑定音色");
    this.assertVoiceReady(p);
    const say = (text || `你好，我是${p.name}。这是灵境里的声音试听。`).slice(0, 120);
    const { buf, format } = await synthesizeSpeech(this.ttsCfg(), this.speakOpts(p, say));
    return this.realm.saveSpeechAudio(presenceId, buf, format);
  }

  private history(sessionId: string): ChatMessage[] {
    return this.store.listMessages(sessionId).filter((m) => m.kind === "chat");
  }

  async turn(presenceId: string, text: string, sessionId?: string): Promise<RealmTurnResult> {
    const p = this.realm.get(presenceId);
    if (!p || p.archived) throw new Error("找不到该 Presence，或已封存");
    const userText = text.trim();
    if (!userText) throw new Error("请输入内容");

    const owner = presenceSessionOwner(presenceId);
    const sid = sessionId || `rs-${presenceId}-${Date.now().toString(36)}`;
    this.store.ensureSession(sid, owner, p.name);

    const userDraft: ChatMessage = {
      sessionId: sid,
      from: "user",
      to: owner,
      role: "user",
      content: userText,
      kind: "chat",
      createdAt: Date.now(),
      meta: { realm: true },
    };
    this.store.addMessage(userDraft);
    const userMsg = this.history(sid).at(-1)!;

    const provider = this.providers.get(p.providerId) as Provider | undefined;
    if (!provider) throw new Error("对话模型不可用，请在 Presence 设置里换一个");

    const hist = this.history(sid).filter((m) => m.id !== userMsg.id).slice(-20);
    const result = await this.providers.complete(provider, {
      system: buildPresenceSystemPrompt(p),
      user: userText,
      history: hist,
      stream: false,
      temperature: 0.7,
    });
    const replyText = (result.text || "").trim() || "……";

    let audioPath: string | undefined;
    let audioError: string | undefined;
    const blocks: ContentBlock[] = [{ type: "text", text: replyText }];

    if (p.voice.status === "ready") {
      try {
        this.assertVoiceReady(p);
        const { buf, format } = await synthesizeSpeech(this.ttsCfg(), this.speakOpts(p, replyText));
        audioPath = this.realm.saveSpeechAudio(presenceId, buf, format);
        blocks.push({ type: "audio", path: audioPath, mime: format === "wav" ? "audio/wav" : "audio/mpeg" });
      } catch (e) {
        audioError = e instanceof Error ? e.message : String(e);
      }
    }

    this.store.addMessage({
      sessionId: sid,
      from: owner,
      to: "user",
      role: "assistant",
      content: blocks,
      kind: "chat",
      createdAt: Date.now(),
      meta: {
        realm: true,
        audioPath,
        providerId: p.providerId,
        model: provider.model,
        usage: result.usage
          ? { input: result.usage.inputTokens ?? 0, output: result.usage.outputTokens ?? 0, calls: 1, cached: result.usage.cachedTokens }
          : undefined,
      },
    });
    const replyMsg = this.history(sid).at(-1)!;

    this.realm.update(presenceId, {});
    return { sessionId: sid, userMsg, replyMsg, text: replyText, audioPath, audioError };
  }
}
