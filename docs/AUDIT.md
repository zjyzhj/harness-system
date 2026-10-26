# 软件审查报告 — Harness Bot（2026-10-27）

> 范围：全仓库（core/ + app/ + tests/，约 5000 行 TS/JS）· 结论依据：源码 + 测试 + 冒烟 + 真实端点 e2e

## 1. 能力现状矩阵

| 能力 | 实现 | 证据 | 成熟度 |
|------|------|------|--------|
| 一句话建 bot | 规则 + LLM 双解析 | `core/agent-registry.ts` `createBotFromText` | 🟢 可用 |
| 富会话显示 | ContentBlock + markdown 子集 + 工具卡片 + thinking + 图片 | `app/renderer/renderer.js` `renderBlocks` | 🟢 可用 |
| 真实模型接入 | chat/completions + responses 双实现、SSE 流式、结构化 tools、多模态 image | `core/adapters/openai-compat.ts` | 🟢 可用（真实端点 e2e 通过） |
| CLI 适配 | codex/cursor/claude spawn + url/key env 透传 + 降级 | `core/adapters/cli.ts` | 🟢 可用 |
| 记忆 | 分层（fact/summary/note/event）+ 关键词检索 + 会话摘要 | `core/memory-system.ts` | 🟡 关键词级，无向量 |
| 技能 | SKILL.md frontmatter + 渐进披露 + 一句话建技能 | `core/skill-registry.ts` | 🟢 可用 |
| 定时任务 | cron + 重试 + run log + next-run | `core/scheduler.ts` | 🟢 可用 |
| 工具执行 | fs/bash/web/notify/memory 白名单真执行 | `core/tool-executor.ts` | 🟡 命令白名单有限 |
| MCP | HTTP/stdio client + 工具注入 LLM 循环 | `core/mcp-client.ts` | 🟢 可用 |
| 多 bot 通信 | 进程内 MessageBus + Local/HTTP Transport | `core/message-bus.ts` `transport.ts` | 🟡 仅文本，HTTP 未启用 |
| 桌面宠物 | 情绪状态机 + 打字机气泡 + 右键菜单 + 事件推送 + 主动搭话 | `app/renderer/pet.js` | 🟡 动画单一、无会话入口 |
| 形象 | 图像 API 生成 + 程序化降级 + 角色卡 | `core/persona.ts` | 🟡 无本地多风格 |
| 系统能力 | 通知/剪贴板 parse 文本/文件白名单 | `core/system-kit.ts` | 🟡 无授权模型、无屏幕/键鼠 |
| 迁移 | V2 全量（bots/providers/memory/skills/tasks/pets/assets） | `core/migration-v2.ts` | 🟢 可用 |
| 离线人格 | 无 key 时角色卡+记忆回应 + 主动搭话 | `core/offline-persona.ts` | 🟢 可用 |
| 测试 | 63 项（core/adapters/runtime/e2e）· tsc 0 错 · 冒烟 bridge-ok | `tests/` | 🟢 稳定 |

## 2. 主要缺口（按用户价值排序）

1. **会话存储工程化**：`messages.json` 单文件全量读写；无分页、无会话搜索/归档/清理；会话积累后面板卡顿。
2. **上下文治理**：历史固定取 `slice(-10)`，无 token 预算裁剪；摘要只在首次 >8 条时生成一次，长会话上下文不可控。
3. **记忆增强**：检索仅关键词（`KeywordRetriever`）；无向量/语义检索、无 MEMORY.md 权威总结常驻、无跨 bot 共享知识。
4. **宠物深度**：动画仅 breathe/bounce/pop + 情绪徽章；宠物气泡是临时 DOM，无会话历史入口；定时任务结果不进宠物气泡。
5. **多 bot 协作**：只能文本互发；无群组/广播、无编排器（主控指挥多 bot 完成复杂任务）；HTTP Transport 预留但未启用，无法跨进程。
6. **系统深度接入**：无授权确认（bot 请求系统能力时无弹窗）；无 AppleScript/键盘/鼠标/屏幕截图；bash 命令白名单过窄（无 git/docker 等常用组）。
7. **打包与安全**：无 dmg/签名/公证/自动更新；apiKey 明文存 `config.json`；无审计日志。
8. **形象系统**：无本地多风格生成（依赖 API，离线只有纯色占位）；角色卡维度少；形象与宠物动画未打通（skin 帧）。

## 3. 技术债与风险

- `store.addMessage` 每次写整个 sessions+messages JSON（无增量），高频消息下有 IO 放大。
- 渲染器 markdown 子集每次流式块全量重渲染（`bubble.innerHTML = renderMarkdown(acc)`），超长回复有性能隐患。
- `HttpTransport` 无服务端实现，跨进程能力是「半成品」。
- key 的安全性依赖文件权限（0600），未用系统 Keychain。
- Electron 无自动更新、无打包产物验证（当前只能 `bun run start` 开发态）。

## 4. 结论

核心引擎扎实（模型接入/富会话/记忆-技能-定时三件套/迁移均可用且有测试），下一阶段应聚焦**让系统能长期积累（会话记忆）、更讨喜（宠物）、更强（协作/系统接入）、更成熟（打包安全）** 四个方向——即本仓库 ROADMAP 的 G1–G6。
