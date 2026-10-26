# TASKS — Harness Bot 管理系统 任务拆解

> 阶段：Task · 状态：🔨 进行中 · 日期：2026-10-26
> 上游：[DESIGN.md](./DESIGN.md) · 目标：实现 MVP（GOAL G1–G9）

## 0. 任务总览

| 任务 | 内容 | 出口条件 | 状态 |
|------|------|----------|------|
| T0 | docs 全套（GOAL/SPEC/DESIGN/TASKS） | 4 文件存在 | ✅ |
| T1 | 工程骨架（Bun + 目录 + tsconfig + package.json） | `bun dev` 起壳 | ⬜ |
| T2 | core/store（SQLite + config） | `bun test` 过 store 测试 | ⬜ |
| T3 | AgentRegistry + 一句话创建 | 创建 bot 测试过 | ⬜ |
| T4 | MessageBus 多 bot 通信 | 两 bot 互发测试过 | ⬜ |
| T5 | ProviderCenter + openai-compat 适配器 | 测试连接/对话测试过 | ⬜ |
| T6 | CLI 适配器（codex/cursor/claude）+ 降级 | capability 探测测试过 | ⬜ |
| T7 | PersonaGenerator 形象+角色卡（含降级） | 生成头像文件+角色卡测试过 | ⬜ |
| T8 | SystemKit（通知/剪贴板/文件） | 三能力最小测试过 | ⬜ |
| T9 | Migration 导出/导入 | 往返测试过 | ⬜ |
| T10 | Electron 壳：Tray + 主控面板窗口 + 宠物窗口 | 面板打开+宠物出现 | ⬜ |
| T11 | 主控面板 UI（Grok-Bot 风格暗色） | 可建 bot/可对话/可见宠物 | ⬜ |
| T12 | 集成验收（G1–G9） | 验收清单全勾 | ⬜ |

## 1. 实现顺序与依赖

```
T0 ✅ → T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9
                                        ↘ T10 → T11 → T12（集成验收）
```

- 核心（T2–T9）与壳（T10/T11）可部分并行：壳只需 store/registry 接口即可开发。
- 每完成 T2–T9 的核心模块，立即补 `bun test` 最小测试（T12 汇总结论）。

## 2. T1 骨架细节

- `package.json`：`name: harness-bot`，`type: module`，scripts：
  - `dev`: `bun run app/main.ts`（先起 Electron 壳；若 Electron 依赖拉取受限则先 `dev:core`）
  - `dev:core`: `bun --watch tests/` 或直接跑 core CLI demo
  - `test`: `bun test`
- 依赖（尽量少）：`electron`（壳）；核心零依赖（用 bun:sqlite / fetch / node:child_process）。
- `tsconfig.json`：`moduleResolution: bundler`，`target: esnext`，`strict: true`。

## 3. 核心模块验收口径（T2–T9）

| 模块 | 最小可测行为 |
|------|--------------|
| store | 可建库、写/读 providers/bots/messages；config 0600 |
| agent-registry | `createBotFromText("创建 bot：翻译助手，用 claude，风格活泼")` 返回含 name/role/model 的 Bot；失败降级有默认值 |
| message-bus | 注册 A、B；`send(A→B)` 后 B 收到且 A 收到回复回执 |
| provider-center | 添加 openai-compat provider；`test()` 返回 ok/fail；default 生效 |
| adapters | `which codex/claude/cursor` 探测返回 capability；无 CLI 时降级路径存在 |
| persona | `generatePersona(botId,"蓝色狐狸")` 产出头像文件 + 角色卡 JSON；无网络走降级 |
| system-kit | 通知/剪贴板/文件三接口可调用（文件路径白名单） |
| migration | 导出含 providers/bots/assets；导入还原；重名加后缀 |

## 4. T10/T11 壳验收口径

- T10：`bun dev` 启动后出现菜单栏图标；点击打开主控面板窗口；`创建宠物模式` 后出现无边框透明宠物窗口，可拖动、置顶。
- T11：主控面板渲染 bot 列表 + 会话流 + 输入框；「一句话创建」和「生成形象」按钮调通 core；暗色 Grok-Bot 风格（深底 #0d0d0d、圆角、左侧列表、消息气泡）。

## 5. T12 集成验收

按 [SPEC §4 验收清单](./SPEC.md#4-验收清单对应-goal-g1g9) 逐项执行：

1. `bun test` 全绿
2. `bun dev` 起壳
3. 手动：一句话建 bot → 生成形象 → 宠物出现 → 两 bot 互发 → 配置 provider → 导出/导入

## 6. 超出 MVP 的后续（记录不实现）

- 分布式多进程 agent 编排（ruflo/deer-flow 级）
- 云同步/多人协作
- 移动端/Windows/Linux
- Grok Computer Use 级屏幕操控
- 群聊、bot 商店、插件市场
