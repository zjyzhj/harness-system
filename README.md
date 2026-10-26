# Harness Bot — macOS 桌面端 AI 智能体指挥中心

像 Grok Bot 一样一句话创建 bot、一句话生成形象，bot 作为桌面宠物活跃在桌面上；主控面板统一指挥，多 bot 可通信，统一接入主流 CLI 与模型 API。

## 快速开始

```bash
bun install        # 安装依赖（Electron 首次下载较慢）
bun test           # 运行核心模块测试（16 项）
bun start          # 构建 + 启动 Electron（菜单栏 + 主控面板）
bun run dev        # 仅构建 shell（不启动，便于调试）
```

## 功能

- **Bot 底层运行时**（对标 CowAgent / DeepSeek-Harness / OpenClaw）：
  - **真工具执行** `core/tool-executor.ts`：bash 白名单执行、文件读写、网页抓取、通知、记忆读写（安全：命令/目录白名单 + 超时 + 危险命令禁止）
  - **MCP 接入** `core/mcp-client.ts`：连接外部 MCP server（HTTP/stdio），工具自动注册给 bot
  - **持久记忆** `core/memory-system.ts`：每 bot 记忆空间（fact/summary/note/event 分层），关键词检索注入上下文，自动会话摘要，重启不丢
  - **技能** `core/skill-registry.ts`：`skills/<key>/SKILL.md` + YAML frontmatter 规范，渐进披露（默认只注入 description，调用时加载 body），一句话创建技能
  - **定时任务** `core/scheduler.ts`：cron 5 段调度，到期唤醒 bot 执行，持久化 + 手动触发
  - **工具循环** `core/bot-runtime.ts`：记忆注入 → 技能清单 → 模型生成 → `\`\`\`tool\`\`\`` 块调用技能/内置工具 → 回填结果 → 最终回复；自动抽取记忆事件
- **主控面板**：Grok-Bot 风格暗色界面，左侧 bot 列表、中间对话流、底部输入框
- **一句话创建 bot**：输入 `创建 bot：翻译助手，用 claude 模型，风格活泼` 自动解析名称/角色/模型
- **一句话生成形象**：输入 `生成形象：一只蓝色狐狸，可爱` → 本地头像 + 角色卡（无图像 API 时自动降级为程序化头像）
- **桌面宠物**：启用后 bot 以无边框透明窗口出现在桌面，可拖动、点击弹出对话气泡；带呼吸/弹跳动画、状态点、回复/任务完成/失败事件气泡、离线人格主动搭话
- **多 bot 通信**：`@bot名 消息` 让两个 bot 互发消息；未注册的远程 bot 可走 Transport（Local/HTTP）转发
- **统一模型配置**：设置页管理 OpenAI 兼容 API（url/key/model）+ codex/cursor/claude CLI 检测与降级
- **系统能力**：通知、剪贴板、白名单文件读写
- **迁移**：一键导出/导入 JSON（含 bots、provider、形象文件）

## 数据

- 数据默认存 `~/Library/Application Support/harness-bot/`（或 `HARNESS_HOME` 指定）
- 存储为纯 JSON 文件（providers/bots/sessions/messages/pets/memory/tasks），无原生依赖，迁移 = 复制文件
- 迁移 v2 全量：bots + providers + 记忆 + 技能 + 定时任务 + 形象
- 导出文件为 `harness-bot-migration/v1` 格式

## 文档

- [GOAL.md](docs/GOAL.md) — 目标与验收标准
- [SPEC.md](docs/SPEC.md) — 功能规格
- [DESIGN.md](docs/DESIGN.md) — 架构设计
- [TASKS.md](docs/TASKS.md) — 任务拆解与进度

## 架构

```
Electron 壳 (app/) ──IPC──▶ core/ (纯 TS)
                              ├─ AgentRegistry     一句话创建 bot
                              ├─ BotRuntime        智能体循环（记忆+技能+工具）
                              ├─ MemorySystem      持久记忆（fact/summary/note/event）
                              ├─ SkillRegistry     SKILL.md 技能（渐进披露）
                              ├─ Scheduler         cron 定时任务
                              ├─ MessageBus        多 bot 通信
                              ├─ ProviderCenter    url/key 配置 + CLI 适配
                              ├─ PersonaGenerator  形象 + 角色卡
                              ├─ SystemKit         通知/剪贴板/文件
                              └─ Migration         导出/导入
```

核心层不依赖 Electron/Bun 专属 API，测试 `bun test` 全绿（16 项）。
