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

- **主控面板**：Grok-Bot 风格暗色界面，左侧 bot 列表、中间对话流、底部输入框
- **一句话创建 bot**：输入 `创建 bot：翻译助手，用 claude 模型，风格活泼` 自动解析名称/角色/模型
- **一句话生成形象**：输入 `生成形象：一只蓝色狐狸，可爱` → 本地头像 + 角色卡（无图像 API 时自动降级为程序化头像）
- **桌面宠物**：启用后 bot 以无边框透明窗口出现在桌面，可拖动、点击弹出对话气泡
- **多 bot 通信**：`@bot名 消息` 让两个 bot 互发消息
- **统一模型配置**：设置页管理 OpenAI 兼容 API（url/key/model）+ codex/cursor/claude CLI 检测与降级
- **系统能力**：通知、剪贴板、白名单文件读写
- **迁移**：一键导出/导入 JSON（含 bots、provider、形象文件）

## 数据

- 数据默认存 `~/Library/Application Support/harness-bot/`（或 `HARNESS_HOME` 指定）
- 存储为纯 JSON 文件（providers/bots/sessions/messages/pets），无原生依赖，迁移 = 复制文件
- 导出文件为 `harness-bot-migration/v1` 格式

## 文档

- [GOAL.md](docs/GOAL.md) — 目标与验收标准
- [SPEC.md](docs/SPEC.md) — 功能规格
- [DESIGN.md](docs/DESIGN.md) — 架构设计
- [TASKS.md](docs/TASKS.md) — 任务拆解与进度

## 架构

```
Electron 壳 (app/) ──IPC──▶ core/ (纯 TS)
                              ├─ AgentRegistry    一句话创建 bot
                              ├─ MessageBus       多 bot 通信
                              ├─ ProviderCenter   url/key 配置 + CLI 适配
                              ├─ PersonaGenerator 形象 + 角色卡
                              ├─ SystemKit        通知/剪贴板/文件
                              └─ Migration        导出/导入
```

核心层不依赖 Electron/Bun 专属 API，测试 `bun test` 全绿（16 项）。
