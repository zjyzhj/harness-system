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
| **3 交接** | 群聊 @ / `bot.ask` 交接；`ui.form`；流程模板（日报/分诊等）。~~Orchestrator / plan.handOff~~ 已退役 | 合上电脑继续、云并行屏幕、购物/物流卡 |
| **4 抛光** | 附件约 100MB 路径引用；语音断线重连；忙时发送队列 | 模型「看完」1GB 视频、云睡醒语义 |

## 3. Phase 1（已落地）

- [`core/demo-skill.ts`](../../core/demo-skill.ts)、`demo.*` 工具、`executeTool` 录制钩子  
- `demo.finish` → Skill + 可选 Scheduler；测试 [`tests/demo-skill.test.ts`](../../tests/demo-skill.test.ts)

## 4. Phase 2（已落地）

- [`core/contacts.ts`](../../core/contacts.ts)、[`core/connectors.ts`](../../core/connectors.ts)、[`core/vault.ts`](../../core/vault.ts)  
- 工具：`vault.list` / `vault.search` / `vault.contact`（只读）  
- 设置页「保险库 / 连接」：`vaultFlow()`；`app:settings/vault`  
- 添加仍走 mcp / env / secret；不接 OAuth  

### 4.1 对齐 Grok Vault（2026-11）

Grok 文档要点：[Vault](https://docs.x.ai/grok-bot/vault) — *covers your whole account；everything available to every Bot；can't limit an item to one Bot*；能力账号级共享、记忆按角色隔离（[Designing Grok Bot](https://x.ai/news/designing-grok-bot)）。

Harness 落地：

- [`core/secret-store.ts`](../../core/secret-store.ts)：账号级保险库；旧「仅某 bot」ACL 启动时清掉；`fill` / `list` / `get` 不再按 bot 过滤  
- `ui.secret` / 保存路径一律全员可用；`env.set` 默认共用（`scope:"bot"` 才私有覆盖）  
- `env.delete` 默认只删私有覆盖；删共用必须 `scope:"all"`  
- `bot.ask` 允许被问方再转问一层（`depth < 2`，与假转问护栏一致）；软失败不进短时复用缓存  
- 分享 needs 按 `savedBy` 归因收录密钥；`secret.delete` 与设置页对等  
- `secret.share` 保留为兼容确认；真值仍不进对话  

### 4.2 对齐 Grok 规范 / 记忆 / 交互（2026-11）

Grok 要点：[What a Bot remembers](https://docs.x.ai/grok-bot/bots) · [Skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations) · [Designing Grok Bot](https://x.ai/news/designing-grok-bot)

| 边界 | Grok | Harness |
|------|------|---------|
| 能力 | Tools / Skills 账号级 | 工具 + 共享技能 + 账号级 Vault |
| 情境 | Memory / Routines 跟 Bot | `bot:` 记忆 + `task.*` 例行；`global` 仅少量共享用户事实 |
| 记忆内容 | 稳定偏好、角色规则、工作摘要 | fact / rule + MEMORY.md 蒸馏；相关才注入 |
| 管理 | 对话为主（记得什么 / 忘掉） | `memory.list` / `update` / `forget`；面板可选 |
| 真相源 | 记忆 ≠ 权威数据源 | 提示词要求过期事实去源头查 |
| Skill vs Routine | how vs when | `skill.*` vs `task.create` |
| Routines in transcript | 例行结果出现在该 Bot 对话 | `onRun` 结果写入钉死/注视/最近单聊；UI 标「⏰ 例行」；`task.create` 内联例行卡 |
| Presence | 头像表达 idle/work/wait | `AgentStatus.waiting` + 侧栏 wait 态 |
| Skills per Bot | 账号级技能按角色开关 | `Bot.disabledSkills` |
| Roster | pin / hide / sections | `Bot.pinned` / `hidden` / `section` |
| Memory import | 从其它助手导入 | `memory:import` + 记忆面板 |
| Gateway HMAC | 可强制签名 | Connect「要求 HMAC」↔ `requireHmac` |

落地：`prompt.ts` 交互节补边界与「一次性 vs 长期」；无人值守默认只起草；`memoryFromText` / `memoryWithAI` 用户事实默认 `scope:all`；登录/密钥仍进 Vault 不进记忆。例行：[`core/routine-session.ts`](../../core/routine-session.ts) + 时区 + 内联卡。 


## 5. Phase 3（已落地；编排部分已退役）

- 多步交接：群聊 `@` / `bot.ask`（编排引擎与 `plan.*` 已全删）  
- `ui.form` 多字段卡（[`chat-blocks.js`](../../app/renderer/chat-blocks.js) `formCard`）  
- 预置技能模板：`daily-report` / `triage` / `research-write`

## 6. Phase 4（已落地）

- [`core/attachments.ts`](../../core/attachments.ts)：`MAX_ATTACH_COPY_BYTES` ≈ 100MB；视频/大文件仅路径引用  
- 连续语音转写失败后自动 `listenTurn` 重连（同会话）  
- 忙时发送入队，文案「处理完上一条后发送」

## 7. 测试

- [`tests/demo-skill.test.ts`](../../tests/demo-skill.test.ts)  
- [`tests/vault-handoff.test.ts`](../../tests/vault-handoff.test.ts)
