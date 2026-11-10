/**
 * Grok Custom Rules（Ask first / Allow）— 账号级，关键词匹配。
 * Ask first 优先于 Allow；各最多 20 条。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./atomic-fs";

export type ActionRuleDecision = "ask_first" | "allow";

export interface ActionRule {
  id: string;
  text: string;
  decision: ActionRuleDecision;
  createdAt: number;
}

export const ACTION_RULE_CAP = 20;

function norm(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** 把工具调用收成可匹配摘要 */
export function actionSummary(tool: string, description?: string, args?: Record<string, unknown>): string {
  const bits = [tool, description || ""];
  if (args) {
    for (const [k, v] of Object.entries(args)) {
      if (v == null) continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        bits.push(`${k}=${v}`);
      }
    }
  }
  return norm(bits.join(" "));
}

export class ActionRuleStore {
  private file: string;
  private rules: ActionRule[] = [];

  constructor(home: string) {
    this.file = join(home, "action-rules.json");
    const raw = readJsonSafe<{ rules?: ActionRule[] } | ActionRule[]>(this.file, { rules: [] });
    const list = Array.isArray(raw) ? raw : Array.isArray(raw.rules) ? raw.rules : [];
    this.rules = list.filter((r) => r?.id && r?.text && (r.decision === "ask_first" || r.decision === "allow"));
  }

  private persist() {
    writeJsonAtomic(this.file, { rules: this.rules }, { mode: 0o600 });
  }

  list(decision?: ActionRuleDecision): ActionRule[] {
    const all = [...this.rules].sort((a, b) => a.createdAt - b.createdAt);
    return decision ? all.filter((r) => r.decision === decision) : all;
  }

  get(id: string): ActionRule | undefined {
    return this.rules.find((r) => r.id === id);
  }

  add(text: string, decision: ActionRuleDecision): ActionRule {
    const t = text.trim().slice(0, 1000);
    if (t.length < 2) throw new Error("规则至少两个字");
    const kind = this.rules.filter((r) => r.decision === decision);
    if (kind.length >= ACTION_RULE_CAP) {
      throw new Error(`${decision === "ask_first" ? "Ask first" : "Allow"} 规则最多 ${ACTION_RULE_CAP} 条`);
    }
    // 同文同决策去重
    const dup = this.rules.find((r) => r.decision === decision && norm(r.text) === norm(t));
    if (dup) return dup;
    const rule: ActionRule = { id: `ar-${randomUUID().slice(0, 8)}`, text: t, decision, createdAt: Date.now() };
    this.rules.push(rule);
    this.persist();
    return rule;
  }

  update(id: string, patch: { text?: string; decision?: ActionRuleDecision }): ActionRule {
    const i = this.rules.findIndex((r) => r.id === id);
    if (i < 0) throw new Error("找不到这条规则");
    const cur = this.rules[i]!;
    const nextDec = patch.decision ?? cur.decision;
    if (patch.decision && patch.decision !== cur.decision) {
      const kind = this.rules.filter((r) => r.decision === nextDec && r.id !== id);
      if (kind.length >= ACTION_RULE_CAP) throw new Error(`该类规则最多 ${ACTION_RULE_CAP} 条`);
    }
    const text = patch.text != null ? patch.text.trim().slice(0, 1000) : cur.text;
    if (text.length < 2) throw new Error("规则至少两个字");
    const next: ActionRule = { ...cur, text, decision: nextDec };
    this.rules[i] = next;
    this.persist();
    return next;
  }

  remove(id: string): boolean {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.id !== id);
    if (this.rules.length === before) return false;
    this.persist();
    return true;
  }

  /**
   * 匹配摘要：Ask first 优先于 Allow。
   * 返回命中的规则（若有）。
   */
  match(summary: string): ActionRule | null {
    const hay = norm(summary);
    if (!hay) return null;
    for (const r of this.rules.filter((x) => x.decision === "ask_first")) {
      if (hay.includes(norm(r.text))) return r;
    }
    for (const r of this.rules.filter((x) => x.decision === "allow")) {
      if (hay.includes(norm(r.text))) return r;
    }
    return null;
  }
}
