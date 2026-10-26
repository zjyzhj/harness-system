import { randomUUID } from "node:crypto";
import type { Provider } from "./types";
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

  async test(id: string): Promise<{ ok: boolean; detail?: string }> {
    const p = this.store.getProvider(id);
    if (!p) return { ok: false, detail: "provider 不存在" };
    if (p.kind === "openai-compat") return testOpenAICompat(p);
    const cap = await detectCli(p.cliName ?? "claude");
    return { ok: cap.installed, detail: cap.installed ? `已安装 ${cap.version}` : `${p.cliName} 未安装` };
  }

  async complete(p: Provider, req: CompletionRequest): Promise<CompletionResult> {
    if (p.kind === "openai-compat") {
      return completeOpenAICompat(p, req);
    }
    // CLI 适配；失败则降级到同 provider 的 API 配置（若有 baseUrl/apiKey）
    try {
      const text = await completeCli(p, req.user ?? "", req.system);
      return { text };
    } catch (e) {
      if (p.baseUrl && p.apiKey) {
        const fallback: Provider = { ...p, kind: "openai-compat" };
        return completeOpenAICompat(fallback, req);
      }
      throw e;
    }
  }

  async capabilities(): Promise<Record<string, { installed: boolean; version?: string; chat: boolean }>> {
    const out: Record<string, { installed: boolean; version?: string; chat: boolean }> = {};
    for (const name of ["codex", "cursor", "claude"] as CliName[]) {
      out[name] = await detectCli(name);
    }
    return out;
  }
}
