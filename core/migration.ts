import { existsSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { MigrationPayload } from "./types";
type AnyPayload = MigrationPayload & { format: string };
import type { Store } from "./store";

export class Migration {
  constructor(private store: Store, private assetsDir: string) {}

  exportPayload(opts?: { maskKeys?: boolean }): AnyPayload {
    const payload: MigrationPayload = {
      format: "harness-bot-migration/v2",
      exportedAt: new Date().toISOString(),
      providers: this.store.listProviders().map((p) =>
        opts?.maskKeys && p.apiKey
          ? { ...p, apiKey: p.apiKey.slice(0, 4) + "****" + p.apiKey.slice(-4) }
          : p,
      ),
      bots: this.store.listBots(),
      pets: this.store.listPets(),
      assets: {},
    };
    for (const b of payload.bots) {
      if (b.avatarPath && existsSync(b.avatarPath)) {
        payload.assets![b.id] = b.avatarPath;
      }
    }
    return payload;
  }

  exportToFile(filePath: string, opts?: { maskKeys?: boolean }): void {
    writeFileSync(filePath, JSON.stringify(this.exportPayload(opts), null, 2), "utf8");
  }

  importFromPayload(payload: MigrationPayload): { importedProviders: number; importedBots: number; importedPets: number } {
    if (!payload.format?.startsWith("harness-bot-migration/v")) {
      throw new Error(`不支持的迁移格式：${payload.format}`);
    }
    const usedNames = new Set(this.store.listBots().map((b) => b.name.toLowerCase()));
    let importedBots = 0, importedPets = 0;
    for (const p of payload.providers ?? []) {
      const existing = this.store.listProviders().find((e) => e.id === p.id);
      if (existing) {
        // 同 id 保留现有（避免覆盖本地 key）
        continue;
      }
      this.store.saveProvider({ ...p, apiKey: p.apiKey, isDefault: false });
    }
    const providerIds = new Set(this.store.listProviders().map((p) => p.id));
    for (const b of payload.bots ?? []) {
      let name = b.name;
      if (usedNames.has(name.toLowerCase())) {
        let i = 2;
        while (usedNames.has(`${name} (${i})`.toLowerCase())) i++;
        name = `${name} (${i})`;
      }
      usedNames.add(name.toLowerCase());
      const bot = { ...b, id: crypto.randomUUID(), name, providerId: providerIds.has(b.providerId) ? b.providerId : this.store.getDefaultProvider()?.id ?? b.providerId };
      // 复制形象文件
      const assetSrc = payload.assets?.[b.id];
      if (assetSrc && existsSync(assetSrc)) {
        mkdirSync(this.assetsDir, { recursive: true });
        const dest = join(this.assetsDir, `${bot.id}.${assetSrc.split(".").pop() || "png"}`);
        copyFileSync(assetSrc, dest);
        bot.avatarPath = dest;
      }
      this.store.saveBot(bot);
      importedBots++;
    }
    const botIds = new Set(this.store.listBots().map((b) => b.id));
    for (const pet of payload.pets ?? []) {
      if (!botIds.has(pet.botId)) continue;
      this.store.savePet(pet);
      importedPets++;
    }
    // 保证 assets 目录存在
    if (!existsSync(this.assetsDir)) mkdirSync(this.assetsDir, { recursive: true });
    return { importedProviders: payload.providers?.length ?? 0, importedBots, importedPets };
  }

  importFromFile(filePath: string) {
    const raw = JSON.parse(require("node:fs").readFileSync(filePath, "utf8")) as AnyPayload;
    return this.importFromPayload(raw);
  }

  static assetFileNameFor(id: string, srcPath: string): string {
    return `${id}.${basename(srcPath).split(".").pop() || "png"}`;
  }
}
