# G11-SPEC — Grok 本地对齐（无云电脑）

> Goal：G11 · 状态：✅ 已实现 · 日期：2026-11-10  
> 上游：[G9-local-grok-sync](./G9-local-grok-sync.md) · 下游：[G11-design](./G11-grok-parity-design.md)  
> 参考：[Skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations) · [Approvals](https://docs.x.ai/grok-bot/approvals-security-and-privacy) · [Vault](https://docs.x.ai/grok-bot/vault) · [Designing Grok Bot](https://x.ai/news/designing-grok-bot)

## 1. 问题陈述

G9 已落地演示→技能、Vault 账号级、例行边界、内部浏览器与技能六段。相对 Grok 仍缺：自然语言级 Ask first / Allow 规则、Login 型保险库、浏览器密钥直填与正式接管、主控晨间简报、例行完整历史与失败策略、工作日志、Library 分组、技能缺段提示等。

## 2. 用户故事

- 作为用户，我可以说「发外部消息前先问我」，规则长期生效。
- 作为用户，我保存网站登录项，bot 填密码时看不见明文。
- 作为用户，验证码出现时点「接管浏览器」，做完点「我做完了」。
- 作为主控 bot，我能按例行汇总其他 bot 的失败与待批准。
- 作为用户，我能在例行详情看到最近 20 次运行成败。

## 3. 功能需求

| # | 需求 | 验收 |
|---|------|------|
| A1 | Custom Rules（Ask first / Allow，各 ≤20） | 关键词匹配；Ask first 优先；设置页可增删；风险卡可「总是允许」写入 Allow（对齐 Grok Always allow） |
| A2 | Vault Login + Contact Hints（无 Card） | 密码只进 SecretStore；列表不回显 |
| A3 | 浏览器密码框 snapshot 脱敏 + fillLogin | 模型不见密码明文 |
| A4 | Take over / I'm done 卡 | 聚焦浏览器面板；交还可继续 |
| B1 | Primary Bot 晨间简报模板 + 协调提示 | 主控技能/例行可装 |
| B2 | 例行 Run history 完整 20 条 UI | Succeeded/Failed + 错误 |
| B3 | 例行失败策略（无数据不凑） | prompt + 结果卡 |
| B4 | 带日期工作日志 event | 可检索「上周做了什么」 |
| B5 | 复制 Bot（技能开关，无记忆会话） | 侧栏入口可用 |
| C1 | Library Today/本周/更早 + Pin | 侧栏产出分组 |
| C2 | 结果可审阅五段约定 | prompt |
| C3 | Reset 会话文案 | 清会话保留记忆/例行 |
| C4 | 技能缺段黄条 | skillEditor |
| C5 | demo 录 browser.* | finish/playbook |

## 4. 边界

- **不做**：G6 打包/公证/Keychain、Vault Card/支付、云电脑、OAuth 市场、团队 Publish、Pages。
- Custom Rules v1 为关键词匹配，不每步调 LLM。

## 5. 验收清单

- [x] A1–A4 有单测或集成测（`tests/action-rules.test.ts` · `tests/login-vault.test.ts`）
- [x] B1–B5 / C1–C5 行为可手工或测例验证
- [x] `bun test` 相关套件通过
