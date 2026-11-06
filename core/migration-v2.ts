import { existsSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { MigrationPayload, SkinExport } from "./types";
import type { PetSkin } from "./pet-skin";
import type { Store } from "./store";
import type { MemorySystem } from "./memory-system";
import type { SkillRegistry } from "./skill-registry";
import type { Scheduler } from "./scheduler";
import type { GroupRegistry } from "./group-registry";
import type { EnvStore } from "./env-store";
import type { SecretStore } from "./secret-store";
import type { ProjectRegistry, GlobalInstructions } from "./projects";
import type { ConsentCenter } from "./consent-center";

export interface MigrationExtras {
  env?: EnvStore;
  secrets?: SecretStore;
  projects?: ProjectRegistry;
  consent?: ConsentCenter;
}

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
    private groups?: GroupRegistry,
    /** G5.5：社区宠物皮肤目录（assets/skins），导出/导入 spritesheet + index */
    private skinsDir = "",
  ) {
    if (!this.skinsDir) this.skinsDir = join(assetsDir, "skins");
  }

  private extras: MigrationExtras = {};
  /** 配置、项目、命令规则、密钥名单这些在 main 里后创建的存储，创建好后挂上 */
  attachExtras(extras: MigrationExtras) {
    this.extras = { ...this.extras, ...extras };
  }

  /** G5.5：皮肤导出负载 —— 读 index.json + 扫描 spritesheet 文件 */
  private exportSkins(): Record<string, SkinExport> {
    const out: Record<string, SkinExport> = {};
    const indexPath = join(this.skinsDir, "index.json");
    let meta: PetSkin[] = [];
    try {
      if (existsSync(indexPath)) meta = JSON.parse(readFileSync(indexPath, "utf8")) as PetSkin[];
    } catch { meta = []; }
    for (const sk of meta) {
      if (!sk.sprite?.path) continue;
      const p = sk.sprite.path;
      if (!existsSync(p)) continue;
      out[sk.id] = {
        name: sk.name, color: sk.color, desc: sk.desc, fps: sk.fps,
        url: sk.sprite.url, rows: sk.sprite.rows, cols: sk.sprite.cols,
        cellW: sk.sprite.cellW, cellH: sk.sprite.cellH, path: p,
      };
    }
    // 兼容：未注册进 index 但有 spritesheet 文件的皮肤也导出
    if (!existsSync(indexPath) || !Object.keys(out).length) {
      try {
        for (const dir of readdirSync(this.skinsDir, { withFileTypes: true })) {
          if (!dir.isDirectory()) continue;
          const f = join(this.skinsDir, dir.name, "spritesheet.webp");
          if (out[dir.name] || !existsSync(f)) continue;
          out[dir.name] = { name: dir.name, fps: 8, rows: 9, cols: 8, path: f };
        }
      } catch { /* 目录不存在则跳过 */ }
    }
    return out;
  }

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
      groups: this.groups?.list() ?? [],
      skins: this.exportSkins(),
      env: this.extras.env?.list(),
      projects: this.extras.projects?.list(),
      instructions: this.store.readConfig().instructions as GlobalInstructions | undefined,
      commandRules: this.extras.consent?.listCommandRules(),
      secretNames: this.extras.secrets?.list().map(({ name, label, note, botId, savedBy }) => ({ name, label, note, botId, savedBy })),
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

  importFromPayload(payload: MigrationPayload): { importedProviders: number; importedBots: number; importedPets: number; importedMemories: number; importedSkills: number; importedTasks: number; importedGroups: number; importedPlans: number; skippedPlans: number; importedSkins: number; importedEnv: number; importedProjects: number; importedRules: number; secretsToReenter: { name: string; label?: string; bot?: string }[] } {
    if (!payload.format?.startsWith("harness-bot-migration/v")) throw new Error(`不支持的迁移格式：${payload.format}`);
    const usedNames = new Set(this.store.listBots().map((b) => b.name.toLowerCase()));
    let importedBots = 0, importedPets = 0, importedMemories = 0, importedSkills = 0, importedTasks = 0, importedGroups = 0;

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
    // groups（映射新 bot id）
    for (const g of payload.groups ?? []) {
      const newMembers = g.members.map((m) => idMap.get(m) ?? m).filter((m) => this.store.getBot(m));
      const newAdmin = idMap.get(g.admin) ?? g.admin;
      this.groups?.create(g.name, this.store.getBot(newAdmin) ? newAdmin : "user", newMembers);
      importedGroups++;
    }
    // 编排已下线：旧包里的 plans 字段忽略，不落盘、不重建
    const skippedPlans = Array.isArray(payload.plans) ? payload.plans.length : 0;
    // skins（复制 spritesheet + 写 index.json；重名 id 生成新 id 并改写 bot.skinId）
    const skinIdMap = new Map<string, string>();
    const existingSkinIds = new Set<string>();
    try {
      const idx = join(this.skinsDir, "index.json");
      if (existsSync(idx)) {
        const cur = JSON.parse(readFileSync(idx, "utf8")) as PetSkin[];
        for (const sk of cur) if (sk.sprite?.path) existingSkinIds.add(sk.id);
      }
    } catch { /* 忽略损坏索引 */ }
    let importedSkins = 0;
    for (const [id, sk] of Object.entries(payload.skins ?? {})) {
      if (!existsSync(sk.path)) continue;
      let newId = id;
      if (existingSkinIds.has(newId)) {
        let i = 2;
        while (existingSkinIds.has(`${id}-${i}`)) i++;
        newId = `${id}-${i}`;
      }
      existingSkinIds.add(newId);
      skinIdMap.set(id, newId);
      const dir = join(this.skinsDir, newId);
      mkdirSync(dir, { recursive: true });
      const dest = join(dir, "spritesheet.webp");
      copyFileSync(sk.path, dest);
      // 与现有 index 合并写回
      let index: PetSkin[] = [];
      try { index = JSON.parse(readFileSync(join(this.skinsDir, "index.json"), "utf8")) as PetSkin[]; } catch { index = []; }
      index.push({
        id: newId, name: sk.name, color: sk.color, desc: sk.desc, fps: sk.fps,
        frames: { idle: [], walk: [], jump: [], sleep: [], celebrate: [], work: [], think: [] },
        sprite: { url: sk.url ?? "", path: dest, rows: sk.rows, cols: sk.cols, cellW: sk.cellW, cellH: sk.cellH },
      });
      writeFileSync(join(this.skinsDir, "index.json"), JSON.stringify(index, null, 2), "utf8");
      importedSkins++;
    }
    // 改写 bot.skinId（旧 id -> 新 id）
    if (skinIdMap.size) {
      for (const b of this.store.listBots()) {
        if (b.skinId && skinIdMap.has(b.skinId)) {
          this.store.saveBot({ ...b, skinId: skinIdMap.get(b.skinId) });
        }
      }
    }
    const mapBot = (id?: string) => (id ? idMap.get(id) ?? (this.store.getBot(id) ? id : null) : undefined);
    // 普通配置：本机已有同名同范围的不覆盖
    let importedEnv = 0;
    const env = this.extras.env;
    if (env) {
      for (const e of payload.env ?? []) {
        const botId = mapBot(e.botId);
        if (botId === null) continue;
        if (env.list().some((x) => x.key === e.key && x.botId === botId)) continue;
        env.set({ key: e.key, value: e.value, label: e.label, note: e.note, botId, updatedBy: "migrated" });
        importedEnv++;
      }
    }
    let importedProjects = 0;
    const projects = this.extras.projects;
    if (projects) {
      const names = new Set(projects.list().map((p) => p.name));
      for (const p of payload.projects ?? []) {
        if (names.has(p.name)) continue;
        projects.importProject(p);
        importedProjects++;
      }
    }
    const cur = this.store.readConfig().instructions as GlobalInstructions | undefined;
    if (payload.instructions && !cur?.about?.trim() && !cur?.style?.trim()) this.store.writeConfig({ ...this.store.readConfig(), instructions: payload.instructions });
    let importedRules = 0;
    for (const r of payload.commandRules ?? []) {
      const botId = r.botId === "*" ? "*" : mapBot(r.botId);
      if (!botId || !this.extras.consent || this.extras.consent.commandRule(botId, r.command) !== null) continue;
      try { this.extras.consent.setCommandRule(botId, r.command, r.decision); importedRules++; } catch {}
    }
    const secretsToReenter = (payload.secretNames ?? [])
      .filter((x) => !this.extras.secrets?.has(x.name))
      .map((x) => {
        const who = (x as { savedBy?: string }).savedBy || x.botId;
        return { name: x.name, label: x.label, bot: who ? this.store.getBot(mapBot(who) ?? "")?.name : undefined };
      });
    return { importedProviders: payload.providers?.length ?? 0, importedBots, importedPets, importedMemories, importedSkills, importedTasks, importedGroups, importedPlans: 0, skippedPlans, importedSkins, importedEnv, importedProjects, importedRules, secretsToReenter };
  }

  importFromFile(filePath: string) {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as MigrationPayload;
    return this.importFromPayload(raw);
  }
}
