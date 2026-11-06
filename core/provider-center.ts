import { randomUUID } from "node:crypto";
import { contentText, type Provider } from "./types";
import type { Store } from "./store";
import { completeOpenAICompat, testOpenAICompat, type CompletionRequest, type CompletionResult } from "./adapters/openai-compat";
import { completeCli, detectCli, type CliName } from "./adapters/cli";

/**
 * 统一 Provider 中心：管理 openai-compat 与 cli 两类 provider，
 * 提供 complete() 统一入口（cli 失败自动降级到同 provider 的 api 配置）。
 */
export class ProviderCenter {
  constructor(private store: Store) {}

  addProvider(input: {
    kind: "openai-compat" | "cli";
    name: string;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    cliName?: CliName;
    wireApi?: "chat" | "responses";
    toolMode?: "native" | "text";
    isDefault?: boolean;
  }): Provider {
    const p: Provider = {
      id: input.kind === "cli" ? `cli-${input.cliName ?? "x"}` : randomUUID(),
      kind: input.kind,
      name: input.name,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      model: input.model,
      cliName: input.cliName,
      wireApi: input.wireApi,
      ...(input.toolMode ? { toolMode: input.toolMode } : {}),
      isDefault: input.isDefault ?? false,
      createdAt: Date.now(),
    };
    this.store.saveProvider(p);
    return p;
  }

  list(): Provider[] {
    return this.store.listProviders();
  }

  get(id: string): Provider | null {
    return this.store.getProvider(id);
  }

  getDefault(): Provider | null {
    return this.store.getDefaultProvider();
  }

  delete(id: string) {
    this.store.deleteProvider(id);
  }

  /** 改已有 provider；apiKey 传空表示不改 */
  update(id: string, patch: Partial<Omit<Provider, "id" | "createdAt">>): Provider {
    const p = this.store.getProvider(id);
    if (!p) throw new Error("provider 不存在");
    const next: Provider = { ...p, ...patch, id, createdAt: p.createdAt };
    if (!patch.apiKey) next.apiKey = p.apiKey;
    this.store.saveProvider(next);
    return next;
  }

  async test(id: string): Promise<{ ok: boolean; detail?: string }> {
    const p = this.store.getProvider(id);
    if (!p) return { ok: false, detail: "provider 不存在" };
    return this.testConfig(p);
  }

  /** 测一份还没保存的配置（不落盘） */
  async testConfig(input: Partial<Provider> & Pick<Provider, "kind">): Promise<{ ok: boolean; detail?: string }> {
    const p: Provider = { id: "__test__", name: "test", isDefault: false, createdAt: 0, ...input };
    if (p.kind === "openai-compat") return testOpenAICompat(p);
    // CLI provider：若配了 base url + key，真测 API 连通性（模拟 codex 会用的端点）
    if (p.baseUrl && p.apiKey) {
      return testOpenAICompat(p);
    }
    const cap = await detectCli(p.cliName ?? "claude");
    return { ok: cap.installed, detail: cap.installed ? `已安装 ${cap.version}` : `${p.cliName} 未安装` };
  }

  async streamComplete(p: Provider, req: CompletionRequest & { _onChunk: (b: import("./types").ContentBlock) => void }): Promise<CompletionResult> {
    if (p.kind === "cli" && !p.baseUrl) {
      const r = await completeCli(
        p,
        contentText(req.user ?? ""),
        req.system,
        req.history,
        (t) => req._onChunk({ type: "text", text: t }),
        req.signal,
        (t) => req._onChunk({ type: "thinking", text: t }),
      );
      return { text: r, content: [{ type: "text", text: r }] };
    }
    if (p.kind === "openai-compat") {
      return completeOpenAICompat(p, { ...req, stream: true });
    }
    try {
      return await completeOpenAICompat({ ...p, kind: "openai-compat" }, { ...req, stream: true });
    } catch (e) {
      if (req.signal?.aborted) throw e;
      const r = await completeCli(p, contentText(req.user ?? ""), req.system, req.history, undefined, req.signal);
      req._onChunk({ type: "text", text: r });
      return { text: r, content: [{ type: "text", text: r }] };
    }
  }

  async complete(p: Provider, req: CompletionRequest): Promise<CompletionResult> {
    if (p.kind === "openai-compat") {
      return completeOpenAICompat(p, req);
    }
    // CLI 适配；失败则降级到同 provider 的 API 配置（若有 baseUrl/apiKey）
    try {
      const text = await completeCli(p, contentText(req.user ?? ""), req.system, req.history, undefined, req.signal);
      return { text };
    } catch (e) {
      if (p.baseUrl && p.apiKey && !req.signal?.aborted) {
        const fallback: Provider = { ...p, kind: "openai-compat" };
        return completeOpenAICompat(fallback, req);
      }
      throw e;
    }
  }

  async capabilities(force = false): Promise<Record<string, { installed: boolean; version?: string; chat: boolean; agent?: boolean; ready?: boolean; bin?: string; label?: string; account?: string }>> {
    const { probeCodingAgents } = await import("./coding-agents");
    const items = await probeCodingAgents(force ? { force: true } : undefined);
    const out: Record<string, { installed: boolean; version?: string; chat: boolean; agent?: boolean; ready?: boolean; bin?: string; label?: string; account?: string }> = {};
    for (const x of items) {
      out[x.id] = {
        installed: x.installed,
        version: x.version,
        chat: x.chat,
        agent: x.agent,
        ready: x.ready,
        bin: x.bin,
        label: x.label,
        account: x.account,
      };
    }
    // 兼容旧 UI：保证三家键始终存在
    for (const name of ["codex", "cursor", "claude"] as CliName[]) {
      if (!out[name]) out[name] = { installed: false, chat: false, agent: false, ready: false };
    }
    return out;
  }
}



