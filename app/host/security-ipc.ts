/* 授权、审计、密钥、环境配置的管理接口（设置页和对话里的密钥卡片用） */
import { ipcMain } from "electron";
import { writeFileSync } from "node:fs";
import { CAP_LABELS, type ConsentCenter } from "../../core/consent-center";
import { buildBotAccessOverview, gatewayBindAllowed, isLoopbackHost, type GatewayAccessInfo } from "../../core/bot-access";
import { looksSecret, type EnvStore } from "../../core/env-store";
import type { AuditLog } from "../../core/audit-log";
import type { SecretStore } from "../../core/secret-store";
import type { Store } from "../../core/store";
import type { Scheduler } from "../../core/scheduler";
import { shareBridgeCreds } from "../../core/share-bridge";

export function registerSecurityIpc(deps: {
  store: Store;
  consent: ConsentCenter;
  audit: AuditLog;
  secrets: SecretStore;
  env: EnvStore;
  scheduler?: Scheduler;
  gatewayInfo?: () => GatewayAccessInfo;
}) {
  const { store, consent, audit, secrets, env, scheduler, gatewayInfo } = deps;
  ipcMain.handle("consent:list", (_e, botId?: string) => consent.list(botId));
  ipcMain.handle("consent:grant", (_e, botId: string, cap: string, opts?: { once?: boolean; ttlMs?: number }) => consent.grant(botId, cap as any, opts));
  ipcMain.handle("consent:revoke", (_e, botId: string, cap?: string) => consent.revoke(botId, cap as any));
  ipcMain.handle("consent:caps", () => Object.entries(CAP_LABELS).map(([id, label]) => ({ id, label })));
  ipcMain.handle("consent:rules", () => ({
    rules: consent.listCommandRules(),
    trusted: consent.trustedBots(),
    modes: consent.permissionModes(),
  }));
  ipcMain.handle("consent:setRule", (_e, botId: string, command: string, decision: "allow" | "deny") => consent.setCommandRule(botId, command, decision));
  ipcMain.handle("consent:removeRule", (_e, botId: string, command: string) => consent.removeCommandRule(botId, command));
  ipcMain.handle("consent:actionRules", () => consent.actionRules.list());
  ipcMain.handle("consent:addActionRule", (_e, text: string, decision: "ask_first" | "allow") => consent.actionRules.add(text, decision));
  ipcMain.handle("consent:updateActionRule", (_e, id: string, patch: { text?: string; decision?: "ask_first" | "allow" }) => consent.actionRules.update(id, patch));
  ipcMain.handle("consent:removeActionRule", (_e, id: string) => consent.actionRules.remove(id));
  ipcMain.handle("consent:setTrusted", (_e, botId: string, on: boolean) => consent.setTrusted(botId, on));
  ipcMain.handle("consent:setMode", (_e, botId: string, mode: "ask" | "auto" | "always") => consent.setPermissionMode(botId, mode));
  ipcMain.handle("consent:mode", (_e, botId: string) => consent.permissionMode(botId));
  ipcMain.handle("consent:cliPaths", (_e, botId?: string) => consent.listCliAgentPaths(botId));
  ipcMain.handle("consent:revokeCliPath", (_e, botId: string, cwd?: string) => {
    consent.revokeCliAgentPath(botId, cwd);
    return consent.listCliAgentPaths(botId);
  });
  ipcMain.handle("consent:termPaths", (_e, botId?: string) => consent.listTermOpenPaths(botId));
  ipcMain.handle("consent:revokeTermPath", (_e, botId: string, cwd?: string) => {
    consent.revokeTermOpenPath(botId, cwd);
    return consent.listTermOpenPaths(botId);
  });
  /** 这个 bot 还能干什么：模式 / 能力 / 命令 / 目录 / 例行 URL / 网关 */
  ipcMain.handle("consent:overview", (_e, botId: string) => {
    if (!store.getBot(botId)) throw new Error("bot 不存在");
    const routines = (scheduler?.listForBot(botId) ?? []).map((t) => ({
      id: t.id, name: t.name, enabled: !!t.enabled, webhookToken: t.webhookToken,
    }));
    const gw = gatewayInfo?.() ?? { enabled: false };
    const auditRows = audit.query({ botId, limit: 20 }).map((ev) => ({
      at: ev.at, botId: ev.botId, cap: ev.cap, action: ev.action, ok: !!ev.ok, detail: ev.detail,
    }));
    const shareBridgeBase = shareBridgeCreds()?.base;
    return buildBotAccessOverview({ botId, consent, routines, gateway: gw, shareBridgeBase, audit: auditRows });
  });
  ipcMain.handle("audit:list", (_e, opts?: any) => audit.query(opts));
  ipcMain.handle("audit:export", (_e, filePath: string) => {
    const events = audit.exportAll();
    writeFileSync(filePath, JSON.stringify(events, null, 2), "utf8");
    return events.length;
  });

  /** 密钥卡片：值加密存本机，账号级共用（对齐 Grok Vault）；卡片只记「已保存」 */
  ipcMain.handle("secrets:save", (_e, sessionId: string, id: number, name: string, value: string, label?: string) => {
    if (!value) throw new Error("内容为空");
    const msg = store.listMessages(sessionId).find((m) => m.id === id);
    const card = Array.isArray(msg?.content) ? msg!.content.find((b) => b.type === "secret" && b.name === name) : undefined;
    const c = card && card.type === "secret" ? card : undefined;
    const isNew = !secrets.has(name);
    secrets.set(name, value, label, { note: c?.note, savedBy: msg?.from, botId: null });
    audit.append({ botId: msg?.from ?? "user", cap: "config", action: isNew ? "secret.save" : "secret.update", args: name, granted: true, ok: true, detail: "账号级共用" });
    return store.updateMessage(sessionId, id, (m) => ({
      ...m,
      content: Array.isArray(m.content) ? m.content.map((b) => (b.type === "secret" && b.name === name ? { ...b, saved: true, scope: "all" as const } : b)) : m.content,
    }));
  });
  ipcMain.handle("secrets:list", () => secrets.list().map((x) => ({
    ...x,
    botName: x.savedBy ? store.getBot(x.savedBy)?.name : undefined,
  })));
  ipcMain.handle("secrets:remove", (_e, name: string) => {
    secrets.remove(name);
    audit.append({ botId: "user", cap: "config", action: "secret.delete", args: name, granted: true, ok: true });
  });
  ipcMain.handle("secrets:scope", (_e, name: string, _botId: string | null) => {
    const ok = secrets.setScope(name, null);
    if (ok) audit.append({ botId: "user", cap: "config", action: "secret.scope", args: name, granted: true, ok: true, detail: "账号级共用" });
    return ok;
  });
  ipcMain.handle("env:list", () => env.list().map((e) => ({ ...e, botName: e.botId ? store.getBot(e.botId)?.name : undefined })));
  ipcMain.handle("env:set", (_e, input: { key: string; value: string; label?: string; note?: string; botId?: string }) => {
    if (looksSecret(input.key, input.value)) throw new Error("这项看起来是密码 / Token，请让 bot 用加密输入框保存");
    const e = env.set({ ...input, updatedBy: "user" });
    audit.append({ botId: "user", cap: "config", action: "env.set", args: `${e.key}=${e.value}`, granted: true, ok: true, detail: e.botId ? "私有" : "共用" });
    return e;
  });
  ipcMain.handle("env:remove", (_e, key: string, botId?: string) => {
    const ok = env.remove(key, botId);
    if (ok) audit.append({ botId: "user", cap: "config", action: "env.delete", args: key, granted: true, ok: true });
    return ok;
  });
}
