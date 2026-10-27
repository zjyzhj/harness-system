import { existsSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MigrationPayload } from "./types";
import type { Store } from "./store";
import type { MemorySystem } from "./memory-system";
import type { SkillRegistry } from "./skill-registry";
import type { Scheduler } from "./scheduler";

/**
 * V2 全量迁移：bots / providers / memory / skills / tasks / pets / assets
 * 对标成熟项目的「完整可移植性」。
 */
export class MigrationV2 {
  constructor(
    private store: Store,
    private assetsDir: string,
    private memory: MemorySystem,
    private skills: SkillRegistry,
    private scheduler: Scheduler,
  ) {}

  /** 导出：附带 memory/skills/tasks 快照 */
  exportPayload(opts?: { maskKeys?: boolean }): MigrationPayload {
    const payload: MigrationPayload = {
      format: "harness-bot-migration/v2",
      exportedAt: new Date().toISOString(),
      providers: this.store.listProviders().map((p) =>
        opts?.maskKeys && p.apiKey ? { ...p, apiKey: p.apiKey.slice(0, 4) + "****" + p.apiKey.slice(-4) } : p,
      ),
      bots: this.store.listBots(),
      pets: this.store.listPets(),
      assets: {},
      memory: {},
      skills: {},
      tasks: this.scheduler.list(),
    };
    // 每个 bot 的记忆
    for (const b of payload.bots) {
      const mem = this.memory.list(b.id);
      if (mem.length) payload.memory![b.id] = mem;
      if (b.avatarPath && existsSync(b.avatarPath)) payload.assets![b.id] = b.avatarPath;
    }
    // 技能 SKILL.md 原文
    for (const sk of this.skills.list()) {
      const body = this.skills.loadBody(sk.key);
      if (body) payload.skills![sk.key] = `---\nname: ${sk.name}\ndescription: ${sk.description}${sk.requires?.length ? `\nrequires: [${sk.requires.join(", ")}]` : ""}\n---\n${body}`;
    }
    return payload;
  }

  exportToFile(filePath: string, opts?: { maskKeys?: boolean }) {
    writeFileSync(filePath, JSON.stringify(this.exportPayload(opts), null, 2), "utf8");
  }

  importFromPayload(payload: MigrationPayload): { importedProviders: number; importedBots: number; importedPets: number; importedMemories: number; importedSkills: number; importedTasks: number } {
    if (!payload.format?.startsWith("harness-bot-migration/v")) throw new Error(`不支持的迁移格式：${payload.format}`);
    const usedNames = new Set(this.store.listBots().map((b) => b.name.toLowerCase()));
    let importedBots = 0, importedPets = 0, importedMemories = 0, importedSkills = 0, importedTasks = 0;

    // providers
    for (const p of payload.providers ?? []) {
      if (this.store.listProviders().some((e) => e.id === p.id)) continue;
      this.store.saveProvider({ ...p, apiKey: p.apiKey, isDefault: false });
    }
    const providerIds = new Set(this.store.listProviders().map((p) => p.id));

    // bots + assets + memory
    const idMap = new Map<string, string>();
    for (const b of payload.bots ?? []) {
      let name = b.name;
      if (usedNames.has(name.toLowerCase())) {
        let i = 2;
        while (usedNames.has(`${name} (${i})`.toLowerCase())) i++;
        name = `${name} (${i})`;
      }
      usedNames.add(name.toLowerCase());
      const newId = crypto.randomUUID();
      idMap.set(b.id, newId);
      const bot = { ...b, id: newId, name, providerId: providerIds.has(b.providerId) ? b.providerId : this.store.getDefaultProvider()?.id ?? b.providerId };
      const assetSrc = payload.assets?.[b.id];
      if (assetSrc && existsSync(assetSrc)) {
        mkdirSync(this.assetsDir, { recursive: true });
        const dest = join(this.assetsDir, `${newId}.${assetSrc.split(".").pop() || "png"}`);
        copyFileSync(assetSrc, dest);
        bot.avatarPath = dest;
      }
      this.store.saveBot(bot);
      importedBots++;
      // 记忆
      const mem = payload.memory?.[b.id];
      if (mem?.length) {
        for (const e of mem) {
          this.memory.add(newId, { kind: e.kind, content: e.content, tags: e.tags, source: "migrated" });
          importedMemories++;
        }
      }
    }

    // skills
    for (const [key, md] of Object.entries(payload.skills ?? {})) {
      try { this.skills.create(key, md); importedSkills++; } catch {}
    }

    // tasks（映射新 bot id）
    for (const t of payload.tasks ?? []) {
      const newBotId = idMap.get(t.botId) ?? t.botId;
      if (!this.store.getBot(newBotId)) continue;
      try {
        this.scheduler.create({ botId: newBotId, name: t.name, cron: t.cron, prompt: t.prompt, kind: t.kind, alarmAt: t.alarmAt, notifyPet: t.notifyPet });
        importedTasks++;
      } catch {}
    }

    // pets
    const botIds = new Set(this.store.listBots().map((b) => b.id));
    for (const pet of payload.pets ?? []) {
      const botId = idMap.get(pet.botId) ?? pet.botId;
      if (!botIds.has(botId)) continue;
      this.store.savePet({ ...pet, botId });
      importedPets++;
    }
    return { importedProviders: payload.providers?.length ?? 0, importedBots, importedPets, importedMemories, importedSkills, importedTasks };
  }

  importFromFile(filePath: string) {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as MigrationPayload;
    return this.importFromPayload(raw);
  }
}
