# Harness Bot

macOS 本地优先的 AI 智能体指挥中心：一句话创建 bot、主控统一对话，bot 还能变成桌面上的 Live2D / 精灵宠物；多 bot 可组队协作，统一接入 OpenAI 兼容 API 与主流 CLI。

## 它是什么

日常工具（Codex / Claude Code / Cursor / 各类 API 中转）配置分散、彼此不通。Harness Bot 把它们收进一个菜单栏应用：

- **一句话建 bot** — 名称、角色、模型、性格一次成型
- **主控面板** — Grok Bot 风格暗色对话台，统一指挥所有智能体
- **桌面宠物** — Live2D / 精灵换装、主动搭话、进化与一句话导演
- **多 bot 协作** — 群聊 @ / 接力、bot.ask 交接、消息总线与本机网关
- **系统能力** — 经同意的通知、剪贴板、文件、截屏与电脑操控
- **灵境（实验）** — 私密 Presence：文本对话 + 参考音频音色还原

数据默认只落本机，可整包导入导出。

## 快速开始

```bash
bun install   # Electron 首次下载可能较慢
bun test      # 核心测试
bun start     # 构建并启动（菜单栏 + 主控面板）
bun run dist  # 打 macOS arm64 包（dmg）
```

要求：macOS（arm64 优先）、[Bun](https://bun.sh)、本机已配置可用的模型 API 或 CLI。

## 能力概览

| 方向 | 内容 |
|------|------|
| 运行时 | 工具循环、MCP、记忆、技能（SKILL.md）、演示→技能、定时任务、上下文预算 |
| 宠物 | Live2D 样本模型、换装、XP/进化、主动搭话、互访、一句话导演 |
| 协作 | 群聊 @ / bot.ask、HTTP Gateway、富内容互通 |
| 安全 | 同意中心、审计日志、密钥安全存储、命令白名单 |
| 分发 | electron-builder 打包（见 `package.json` → `build`） |

## 架构

```
Electron 壳 (app/) ──IPC──▶ core/（纯 TypeScript）
                              ├─ BotRuntime                  ← Bot 完整设计（不含桌宠）
                              ├─ Memory / Skills / Scheduler / MCP
                              ├─ Realm（灵境 Presence + TTS）
                              ├─ Store / Migration / SecretStore
                              └─ pet/sidecar（可选娱乐侧车：pet.* 工具 + 桌宠提示）
                                   ↑ app 启动时 attachPetEntertainment 挂载
```

桌宠是**娱乐侧车**，不进入 Bot 完整设计：未挂载时 Runtime 无 `pet.*`、无桌宠提示词；`app.createBot` 也不自动上台。

## 文档

- [GOAL](docs/GOAL.md) · [SPEC](docs/SPEC.md) · [DESIGN](docs/DESIGN.md)
- Goals：`docs/goals/`（G1–G8，含宠物智能与灵境设计）
- 打包调研：[RESEARCH-G6-DELIVERY](docs/RESEARCH-G6-DELIVERY.md)

## 参与

欢迎 Fork / PR / Issue。提交前请跑通 `bun test`；大功能建议先对照 `docs/goals/` 里对应 Goal 的边界说明。

## License

项目代码见仓库内声明；Live2D 样本资源见 `app/renderer/live2d/LICENSE-samples.md`。
