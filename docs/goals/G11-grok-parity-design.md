# G11-DESIGN — Grok 本地对齐

> Goal：G11 · 上游：[G11-spec](./G11-grok-parity-spec.md) · 下游：[G11-tasks](./G11-grok-parity-tasks.md)

## 1. ActionRule（Custom Rules）

```ts
interface ActionRule {
  id: string;
  text: string;                 // 用户写的短语，如「发外部邮件」
  decision: "ask_first" | "allow";
  createdAt: number;
}
```

- 持久化：`~/.harness-bot/action-rules.json`（或 home 目录下同名）
- 上限：ask_first ≤20，allow ≤20；超限时卡片 Always allow 挤掉最旧 Allow（对齐 Grok）
- 匹配：`normalize(tool + " " + description + " " + argHints).includes(normalize(rule.text))`
- 优先级：内置 deny / 强确认 → Ask first 命中强制弹卡 → Allow 命中可跳过 Ask 常规询问（含白名单外路径风险）→ 原 Consent 逻辑
- 挂钩：`ConsentCenter.matchActionRule(summary)`；`request` / `requestCommand` / `requestBrowserOpen` 入口先查
- **卡片 Always allow → Custom Rules（2026-11-10）**：`ConsentRequest.suggestAllowRule`；bash 白名单外路径 onceOnly 卡仍提供「总是允许（写入规则）」，写入账号级 Allow，避免「信任模式开了却永远只能允许一次」

## 2. LoginStore

```ts
interface LoginEntry {
  id: string;
  website: string;
  username: string;
  secretName: string;  // SecretStore 里的密码名
  hint?: string;
  note?: string;
  updatedAt: number;
}
```

- 密码只 `secrets.set(secretName, password)`；list/get 永不返回明文
- Vault 聚合 `kind: "login"`
- Contact 增补 `phone?` `address?` `hint?`

## 3. Browser

- Snapshot：`input[type=password]` 的 value 恒为空或 `[redacted]`
- `browser.fillLogin({ loginId, userRef?, passRef? })`：主机取 username + secret.fill，type 两次
- `browser.takeover`：返回交互块；UI 聚焦面板；「我做完了」回写继续

## 4. Primary / Routines / Memory

- 内置技能 `morning-briefing`；主控 prompt 一段协调说明
- 例行 UI 展示 `history` 全量（≤20）
- 无人值守前缀强化「无数据失败」
- 回合结束 event：`YYYY-MM-DD 工作：…`（截断、去重）

## 5. Library / Skill editor / Demo

- Library 按消息时间分 Today / 本周 / 更早；localStorage pin
- skillEditor 调 `missingSkillSections`
- Demo SKIP 不含 `browser.`
