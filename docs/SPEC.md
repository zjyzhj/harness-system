# SPEC — Harness Bot 管理系统 功能规格

> 阶段：Spec · 状态：✅ 已定稿 · 日期：2026-10-26
> 上游：[GOAL.md](./GOAL.md) · 下游：[DESIGN.md](./DESIGN.md) · [TASKS.md](./TASKS.md)

## 1. 用户故事（按优先级）

### P0 — 必须
- 我是用户，打开 App 看到主控面板（左侧 bot 列表 + 中间对话 + 底部输入），像 Grok Bot 一样。
- 我在输入框输入「创建 bot：翻译助手，用 claude 模型，风格活泼」，几秒内得到一个可用 bot，出现在列表里，头像可点。
- 我输入「生成形象：一只蓝色狐狸」→ bot 头像变成蓝狐形象，生成角色卡描述。
- 我点 bot 头像 → 它变成桌面宠物出现在桌面（可拖动、置顶、点击弹出对话气泡）。
- 我向任意 bot 发消息，它回复；bot 之间可互相 @ 通信。
- 我在设置里配置模型 url / key / 模型名，多个 provider（OpenAI 兼容 / codex / cursor / claude CLI）。

### P1 — 应有
- 我把全部 bot + 配置导出为一个 JSON 文件，换机器导入还原。
- bot 可主动推送通知（如任务完成）。
- bot 可读写剪贴板、读写指定文件（需授权）。

### P2 — 可选
- bot 会话历史、记忆持久化。
- 多 bot 群聊。

## 2. 功能规格

### F1 主控面板
- 布局：左侧会话/bot 列表（头像+名称+最近消息），中间对话流，底部输入框（支持 / 命令）。
- 新建 bot 按钮与「一句话创建」输入均可用。
- 面板窗口可最小化到菜单栏。

### F2 一句话创建 bot（快速）
- 输入自然语言（如「创建 bot：…」），LLM 解析出：name、role、persona、model、provider、system prompt。
- 未指定 model/provider 时使用默认 provider。
- 创建结果立即出现在列表并可对话。
- 模板：提供几个快速模板（翻译/代码/写作/客服）。

### F3 一句话生成形象 + 角色卡
- 输入「生成形象：…」→ 生成：头像图片（本地文件 `assets/avatars/<botId>.png`）+ 角色卡（`assets/avatars/<botId>.json`：名称/性格/口头禅/背景故事）。
- 无网络时降级：程序化生成占位头像（颜色+emoji），不阻塞。
- 形象可重生成、可手换图片。

### F4 桌面宠物
- 每个启用了「宠物模式」的 bot 在桌面上显示为宠物（无边框窗口、透明背景、置顶、可拖动）。
- 宠物外观 = 形象头像（支持 gif/静态图），可显示名字。
- 点击宠物 → 弹出对话气泡（小窗），可打字对话。
- 宠物可收到 bot 推送的「想说话」事件 → 气泡提示 + 系统通知。
- 菜单栏可一键召唤/隐藏所有宠物。

### F5 多 bot 通信
- 进程内消息总线：任意 bot 可向另一 bot 发消息（`@botB ...`），消息进入会话流并路由。
- 主控面板可见通信记录。
- MVP 不跨进程、不分布式。

### F6 统一模型配置中心
- Provider 管理：OpenAI 兼容 API（base url / api key / model 列表）、codex CLI、cursor CLI、claude CLI。
- 默认 provider 设置；bot 可覆盖。
- 测试连接按钮（发一个最小请求验证 url/key）。
- 密钥存储：`~/.harness-bot/config.json`（0600），导出时可选脱敏。

### F7 CLI 适配器
- `codex` / `cursor` / `claude` 三 CLI：探测是否安装 → capability 报告 → 调用封装（spawn 子进程）。
- CLI 不可用时自动降级到 OpenAI 兼容 API（同一 provider 配置了 API 时）。
- 输出解析：提取回复文本；失败给出可读错误。

### F8 系统能力（需授权）
- 通知：OS 通知（bot 触发或任务完成）。
- 剪贴板：读写文本。
- 文件：bot 可读写用户指定的文件/目录（首用弹窗授权）。
- 权限失败给出明确提示。

### F9 迁移
- 导出：`~/.harness-bot/export-<date>.json` 包含 bots（含形象引用/角色卡）、providers、默认设置、会话摘要。
- 导入：选择 JSON → 还原 bots + providers；形象文件一并复制到本地 assets。
- 导入冲突处理：重名 bot 追加后缀。

### F10 设置页
- Provider 增删改、默认 provider、宠物全局开关、通知开关、数据目录展示、导出/导入按钮。

## 3. 非功能需求

| 项 | 要求 |
|----|------|
| 性能 | 面板启动 < 3s；一句话建 bot < 10s（含 LLM 解析）；宠物动画流畅（>=30fps） |
| 安全 | key 不落日志；config 0600；CLI 调用白名单命令 |
| 平台 | macOS 13+（Apple Silicon 优先，x86 兼容） |
| 数据 | 全部本地，路径 `~/.harness-bot/`；可整体迁移 |
| 许可证 | 上游 MIT 合规，保留声明 |
| 测试 | 核心模块 `bun test` 覆盖：bot 注册、消息路由、provider 配置、CLI 适配、形象生成接口 |

## 4. 验收清单（对应 GOAL G1–G9）

- [ ] G1 docs 全套存在
- [ ] G2 `bun dev` 启动菜单栏+面板
- [ ] G3 一句话建 bot ≤10s 可用
- [ ] G4 一句话形象 + 宠物出现在桌面
- [ ] G5 两 bot 互发消息成功
- [ ] G6 设置页配置 url/key/model + 测试连接
- [ ] G7 宠物常驻 + 通知/剪贴板/文件可用
- [ ] G8 导出→导入还原成功
- [ ] G9 `bun test` 通过，核心模块有代码与测试

## 5. 风险与依赖

- CLI 适配依赖本机已装 CLI（codex ✓ / cursor ✓ / claude ✓ 均存在）。
- 形象生成需外部图像 API；降级为程序化头像。
- Electron 窗口置顶宠物与 macOS 全屏/多屏兼容需实测。
