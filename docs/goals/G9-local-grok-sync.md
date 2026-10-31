# G9 — 本地部分同步 Grok 能力（无云电脑）

> Goal：G9 · 状态：Phase 1–4 ✅ · 日期：2026-10-29  
> 约束：**不做**持久云电脑、合上电脑继续跑、跨端同步、Shop Pay、OAuth 应用市场、X `@bot`、远程并行屏幕。

## 1. 动机

Grok Bot 的体验里，有几块能增强 Harness，但不依赖云端资源即可落地：

1. 演示一遍 → 技能 → 定时重跑  
2. 本机 Vault + 连接器目录（非应用市场）  
3. 任务交接产品化（无云屏）  
4. 体验抛光（大附件路径、语音重连、忙时发送队列）

## 2. 四期边界

| Phase | 做 | 明确不做 |
|-------|----|----------|
| **1 演示→技能** | 录制本机工具轨迹 → `SKILL.md`；可选挂 `Scheduler` | 屏幕跟看 / Computer Use 演示 / 云端重放 |
| **2 Vault·连接** | SecretStore + EnvStore + contacts 统一舱；MCP/Webhook/CLI 目录页 | OAuth 应用市场、支付、邮件身份 `name+tag@` |
| **3 交接** | Orchestrator 阶段所有权移交；`ui.form`；流程模板（日报/分诊等） | 合上电脑继续、云并行屏幕、购物/物流卡 |
| **4 抛光** | 附件约 100MB 路径引用；语音断线重连；忙时发送队列 | 模型「看完」1GB 视频、云睡醒语义 |

## 3. Phase 1（已落地）

- [`core/demo-skill.ts`](../../core/demo-skill.ts)、`demo.*` 工具、`executeTool` 录制钩子  
- `demo.finish` → Skill + 可选 Scheduler；测试 [`tests/demo-skill.test.ts`](../../tests/demo-skill.test.ts)

## 4. Phase 2（已落地）

- [`core/contacts.ts`](../../core/contacts.ts)、[`core/connectors.ts`](../../core/connectors.ts)、[`core/vault.ts`](../../core/vault.ts)  
- 工具：`vault.list` / `vault.search` / `vault.contact`（只读）  
- 设置页「保险库 / 连接」：`vaultFlow()`；`app:settings/vault`  
- 添加仍走 mcp / env / secret；不接 OAuth

## 5. Phase 3（已落地）

- `Orchestrator.handOff` + 阶段 `ownerBotId`；工具 `plan.handOff`；编排 UI 显示「当前负责人」  
- `ui.form` 多字段卡（[`chat-blocks.js`](../../app/renderer/chat-blocks.js) `formCard`）  
- 预置技能模板：`daily-report` / `triage` / `research-write`

## 6. Phase 4（已落地）

- [`core/attachments.ts`](../../core/attachments.ts)：`MAX_ATTACH_COPY_BYTES` ≈ 100MB；视频/大文件仅路径引用  
- 连续语音转写失败后自动 `listenTurn` 重连（同会话）  
- 忙时发送入队，文案「处理完上一条后发送」

## 7. 测试

- [`tests/demo-skill.test.ts`](../../tests/demo-skill.test.ts)  
- [`tests/vault-handoff.test.ts`](../../tests/vault-handoff.test.ts)
