# DESIGN-V2 — Harness Bot 完备版设计（对标成熟项目）

> 状态：✅ 已定稿 · 日期：2026-10-26
> 上游：[RESEARCH-BOT-RUNTIME.md](./RESEARCH-BOT-RUNTIME.md)（5 个成熟项目调研）
> 原则：**每项能力都做到「能真实干活」而非「演示」**。

## 0. 设计目标

把 MVP 升级为完备产品。对照成熟项目逐项补齐，核心判据：
- 记忆 = 可检索、可管理、可跨会话
- 技能 = 模型真能执行（不只返回指令文本）
- 工具 = 支持 MCP，可扩展
- 定时 = 有 UI、有日志、有失败重试
- 形象 = 真出图（API）+ 降级
- 监控 = bot 状态可见
- 迁移 = 全量（bot+记忆+技能+任务+形象）

## 1. 架构分层（V2）

```
┌─ UI 层（renderer）
│  主控面板：会话流 / bot 详情页 / 记忆管理 / 技能管理 / 定时任务 / Provider / 迁移
│  宠物窗：形象 + 气泡对话
├─ 壳层（main.ts）
│  Tray / 窗口 / 宠物 / IPC 路由 / 系统能力注入 / MCP 宿主
├─ 运行时层（core/）
│  BotRuntime      agent 循环（记忆+技能+工具+任务）
│  MemorySystem    记忆（分层 + 检索 + 摘要 + 管理）
│  SkillRegistry   技能（SKILL.md + 渐进披露 + 执行器）
│  Scheduler       cron 任务（UI/日志/重试）
│  ToolExecutor    真工具执行（内置 + 技能脚本 + MCP）
│  AgentRegistry   bot 生命周期
│  ProviderCenter  模型/CLI 适配
│  PersonaGenerator 形象（API + 降级）
│  MessageBus      多 bot 通信（进程内 + 远程 transport 契约）
│  Migration       全量迁移
└─ 存储层
   ~/.harness-bot/
   ├─ config.json / providers.json / bots.json / sessions.json / messages.json
   ├─ memory/<botId>.json       记忆
   ├─ skills/<key>/SKILL.md     技能
   ├─ tasks.json                定时任务
   ├─ assets/avatars/           形象
   └─ logs/                     运行日志
```

## 2. 逐项完备设计

### 2.1 ToolExecutor（新）— 让技能「真执行」
- 内置工具：`fs.read` / `fs.write` / `fs.list` / `bash.run` / `web.fetch` / `notify` / `clipboard` / `memory.add/search`
- 技能执行：SKILL.md body 中的指令（如 curl 命令）由 ToolExecutor 真跑，结果回填模型
- 安全：命令白名单 + 目录白名单 + 超时 + 大小上限；高危命令需授权
- 对齐：DeepSeek-Harness 的 `tool` 系统 + CowAgent `agent/tools/`

### 2.2 MCP 接入（新）
- `McpClient`：连 MCP server（stdio 或 HTTP），`tools/list` → 注册为 bot 可用工具
- 与 ToolExecutor 统一暴露给模型（工具名带前缀 `mcp:<server>/<tool>`）
- 对齐：CowAgent `agent/tools/mcp/mcp_tool.py`、各家 MCP 标配

### 2.3 记忆增强
- 向量检索接口预留（`MemoryRetriever` 抽象，默认关键词，可换 embedding）
- 记忆管理：增删改查 UI 完备 + 搜索框 + 按 kind 过滤
- 自动摘要：会话 > 阈值自动压缩（已有雏形，补强）
- 对齐：CowAgent `agent/memory/`（chunker/embedding/reranker 分级）

### 2.4 技能执行增强
- 技能元数据扩展：`requires` 校验（缺依赖提示）、`timeout`、`permission`（危险技能需授权）
- 技能可包含脚本文件（`scripts/*.sh|.ts`），body 引用之
- 对齐：Cline/Roo 的 skills 目录规范

### 2.5 定时任务增强
- 任务列表显示 `nextRunAt`（人类可读）、最近执行结果
- 失败重试（最多 N 次，指数退避）
- 执行日志落盘（`logs/tasks/<id>.log`）
- 对齐：CowAgent `scheduler_service.py` + OpenClaw cron

### 2.6 形象生成增强
- 真接入图像 API（OpenAI Images / 任意兼容 `/images/generations`）
- 角色卡扩展：性格/口头禅/背景/互动偏好（已有）+ 动态标签
- 宠物：多形态（静态/简单动画）、说话气泡

### 2.7 状态监控
- `AgentStatus`：idle / running / error / offline，运行时更新
- 面板 bot 列表显示状态点
- 对齐：多智能体系统的 roster/health

### 2.8 多 bot 通信（远程契约）
- `Transport` 接口（对标 CowAgent `multiagent/transport.py`）：`send(peerId, msg)` / `onMessage`
- 默认进程内总线；可选 HTTP/WebSocket 实现（预留，MVP 不启用）

### 2.9 全量迁移
- 导出含：bots / providers / memory / skills / tasks / pets / assets
- 导入冲突：重名加后缀、provider 引用映射

### 2.10 面板完备
- bot 详情页：角色卡 / 记忆 / 技能 / 定时任务 / 形象聚合
- 各管理页（记忆/技能/任务）提升为完整 CRUD + 搜索 + 状态展示

## 3. 实现顺序（依赖驱动）

| 阶段 | 内容 | 出口 |
|------|------|------|
| V2-A | ToolExecutor + 真技能执行 + 测试 | `bash.run`/`fs`/`web.fetch` 可跑，测试过 | ✅ |
| V2-B | 记忆增强（管理 API + 检索接口 + 摘要强化） | 记忆 CRUD 测试过 | ✅ |
| V2-C | MCP 客户端 + 工具暴露 | 可连一个测试 MCP server | ✅（坏 server 降级测试过）|
| V2-D | 定时任务增强（next/日志/重试） | UI 显示下次运行 + 失败重试测试过 | ✅（重试+日志+UI）|
| V2-E | 形象真出图（API 接入） | 有 key 时出图、无 key 降级 | ✅（适配器已接）|
| V2-F | 状态监控 + 面板详情页 | bot 状态可见 | ✅（状态点）|
| V2-G | 全量迁移 + 面板各页 CRUD 完备 | 迁移含记忆/技能/任务 | ✅（v2 测试过）|
| V2-H | 集成验收 + 文档更新 | 全部测试绿 + Electron 冒烟 | ✅（39 测试 + 冒烟通过）|

## 4. 风险与决策

- **技能真执行的安全**：命令/目录白名单 + 危险命令授权，宁可保守
- **MCP 依赖外部 server**：客户端只做接入，无 server 时静默降级
- **图像 API key**：无 key 时保持降级路径
- **不引入重依赖**：MCP 走 HTTP/stdio 原生实现（TS），不引 SDK
