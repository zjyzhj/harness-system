# DESIGN — Harness Bot 管理系统 架构设计

> 阶段：Design · 状态：✅ 已定稿 · 日期：2026-10-26
> 上游：[SPEC.md](./SPEC.md) · 下游：[TASKS.md](./TASKS.md)

## 1. 选型结论

| 维度 | 结论 | 理由 |
|------|------|------|
| 运行时 | **Bun (TypeScript)** | 本机已装 bun 1.3.13；启动快、单命令、内置 test runner |
| 桌面壳 | **Electron**（薄壳） | Grok Bot（本机 /Applications/Grok Bot.app 0.75.0）就是 Electron；无边框透明窗口实现桌面宠物最简单；菜单栏/Tray 支持成熟 |
| 核心逻辑 | 独立 `core/` 包（不依赖 Electron） | 可单测、可被 CLI 复用、将来可换壳 |
| 对话/数据 | SQLite（`bun:sqlite`） | 零依赖、本地文件、支持并发会话 |
| 改造来源 | **不整套 fork 单一项目**；借鉴 DeepSeek-Harness 插件化思想 + CowAgent 多智能体模型 + GaleHarnessCLI 的本地命令习惯 | 需求组合独特（桌面宠物+形象+CLI适配+迁移），整套改造反而不如「薄壳+核心自建」快，且避免把无关复杂度带进来 |
| 形象生成 | 接口抽象 `ImageGenProvider`：默认 OpenAI 兼容图像 API；降级程序化头像 | 符合 SPEC F3 |
| 模型调用 | `ProviderAdapter` 统一接口；OpenAI 兼容(HTTP) + CLI(codex/cursor/claude) | SPEC F6/F7 |

> 说明：MVP 采用「薄壳自建核心」而非整包改造 ruflo/deer-flow，因为它们是后端长程编排框架（swarm/流水线），与「桌面宠物 + 主控面板 + 一句话建 bot」的交互型形态错位，改造成本高于自建薄核心。DeepSeek-Harness（Everything is a Plugin）的插件注册思想被吸收到 core 的 provider/adapter 插件接口中。

## 2. 顶层架构

```
┌──────────────────────────────────────────────────┐
│  Electron 壳 (app/)                               │
│  ├─ Main: Tray(菜单栏) · 主控窗口 · 宠物窗口(无边框) │
│  ├─ Preload: 桥接 contextBridge                  │
│  └─ Renderer: 主控面板 UI (Grok-Bot 风格暗色)      │
└───────────────┬──────────────────────────────────┘
                │ IPC (typed)
┌───────────────▼──────────────────────────────────┐
│  core/  (纯 TS，可单测)                           │
│  ├─ AgentRegistry      bot 注册/一句话创建/CRUD    │
│  ├─ MessageBus         进程内多 bot 通信路由       │
│  ├─ ProviderCenter     统一 url/key/model 配置    │
│  ├─ adapters/          openai-compat · codex ·    │
│  │                     cursor · claude            │
│  ├─ PersonaGenerator   一句话形象 + 角色卡        │
│  ├─ SystemKit          通知/剪贴板/文件(授权)      │
│  └─ Migration          导出/导入 JSON             │
└───────────────┬──────────────────────────────────┘
                │ FS
┌───────────────▼──────────────────────────────────┐
│  存储：~/.harness-bot/                            │
│  ├─ config.json   (providers/默认/开关,0600)      │
│  ├─ db.sqlite     (bots/sessions/messages)        │
│  └─ assets/avatars/ (头像图+角色卡)               │
└──────────────────────────────────────────────────┘
```

## 3. 核心模块设计

### 3.1 AgentRegistry（bot 注册与一句话创建）
- 数据模型：`Bot { id, name, role, persona, modelRef, providerId, petEnabled, avatarPath, personaCard, systemPrompt, createdAt }`
- 一句话创建流程：`自然语言 → LLM 解析(JSON schema) → 校验 → 落库 → 返回 Bot`
- 解析失败降级：规则抽取（name/role/provider 关键词）+ 填默认值。

### 3.2 MessageBus（多 bot 通信）
- 接口：`send(from: BotId, to: BotId|'all', text, ctx)` → 路由到目标 bot 的 `handleMessage`。
- 目标 bot 的回复再投递回主控会话流。
- `@botB` 语法在输入层解析为显式路由。

### 3.3 ProviderCenter + Adapters
- 统一接口：
  ```ts
  interface ProviderAdapter {
    id: string; kind: 'openai-compat'|'cli';
    test(): Promise<{ok:boolean; detail?:string}>;
    complete(req: {model?:string; system?:string; user?:string; history?:Msg[]}): Promise<{text:string; raw?:unknown}>;
    capabilities(): { chat:boolean; image:boolean; tools:boolean };
  }
  ```
- `openai-compat`：base url + key + model，POST `/v1/chat/completions`（也可 `/v1/responses` 探测）。
- `codex|cursor|claude`：spawn 子进程，CLI 特有参数封装；`which` 探测 → capability 报告；失败自动降级到同 provider 的 API 适配器。

### 3.4 PersonaGenerator（一句话形象 + 角色卡）
- 输入：「生成形象：一只蓝色狐狸」→ 并行产出：
  - `avatarPrompt` → ImageGenProvider 生成头像图存 `assets/avatars/<id>.png`
  - `personaCard`（JSON：name/性格/口头禅/背景/互动偏好）落库
- ImageGenProvider 接口与降级（程序化：纯色+emoji+名字缩写）。

### 3.5 桌面宠物（Electron 无边框窗口）
- 每只宠物 = 一个 `BrowserWindow`：`transparent:true, frame:false, alwaysOnTop:true, resizable:false, skipTaskbar:true, hasShadow:false`。
- 拖动：`-webkit-app-region: drag` + 位置持久化到 `~/.harness-bot/pets.json`。
- 点击 → 气泡窗（对话小窗）：复用 core 的 MessageBus。
- 推送「想说话」→ 气泡 + 系统通知。

### 3.6 SystemKit（系统能力）
- 通知：Electron `Notification`（bot 侧触发）。
- 剪贴板：`navigator.clipboard` / electron `clipboard`（core 通过宿主注入）。
- 文件：IPC 白名单读/写指定路径；首用授权（`dialog.showOpenDialog` 或权限持久化）。

### 3.7 Migration
- 导出：`{ format:'harness-bot-migration/v1', exportedAt, providers(可选脱敏), bots[], sessions摘要, assets: {botId: avatarPath|dataURL} }`
- 导入：校验 format → 还原 providers/bots → assets 复制到本地 → 冲突加后缀。

## 4. 数据模型（SQLite）

```sql
providers(id TEXT PRIMARY KEY, kind TEXT, name TEXT, baseUrl TEXT, apiKeyEnc TEXT, model TEXT, isDefault INTEGER)
bots(id TEXT PRIMARY KEY, name TEXT, role TEXT, persona TEXT, providerId TEXT, model TEXT,
     systemPrompt TEXT, petEnabled INTEGER, avatarPath TEXT, personaCardJson TEXT, createdAt INTEGER)
sessions(id TEXT PRIMARY KEY, botId TEXT, title TEXT, createdAt INTEGER, updatedAt INTEGER)
messages(id INTEGER PRIMARY KEY AUTOINCREMENT, sessionId TEXT, from TEXT, to TEXT, role TEXT,
         content TEXT, kind TEXT, createdAt INTEGER)
pets(id TEXT PRIMARY KEY, botId TEXT, x REAL, y REAL, visible INTEGER)
```

## 5. 目录结构

```
harness-system/
├─ docs/            GOAL/SPEC/DESIGN/TASKS
├─ app/             Electron 壳
│  ├─ main.ts       Tray/窗口/宠物管理
│  ├─ preload.ts    contextBridge
│  └─ renderer/     主控面板 UI（HTML/TS，暗色 Grok-Bot 风格）
├─ core/            纯 TS 核心（可单测）
│  ├─ agent-registry.ts
│  ├─ message-bus.ts
│  ├─ provider-center.ts
│  ├─ adapters/ (openai-compat.ts codex.ts cursor.ts claude.ts)
│  ├─ persona.ts
│  ├─ system-kit.ts
│  ├─ migration.ts
│  └─ store.ts      (bun:sqlite)
├─ assets/avatars/
├─ package.json
├─ tsconfig.json
└─ tests/           bun test
```

## 6. 关键技术决策

1. **薄 Electron 壳 + core 自建**：Grok Bot 证明 Electron 足够做「对话面板+宠物」形态；core 不依赖 Electron 保证可测性。
2. **bun:sqlite**：避免引入 ORM 依赖。
3. **CLI 适配降级**：CLI 是运行时探索（`which`+`--version`），失败回退 API，保证 B 测体验稳定。
4. **宠物窗口池化**：单窗口模板 + 每 bot 复用，控制内存。
5. **形象降级**：无图片 API 时程序化头像，桌面宠物不阻塞。

## 7. 风险复核

| 风险 | 缓解 |
|------|------|
| Electron 透明窗口在 macOS 26 兼容 | 先验证最小宠物窗口 demo（M1 出口条件） |
| CLI 输出解析不稳定 | 适配器独立 + 降级路径 + 测试覆盖 codex/claude 本机实测 |
| 一句话解析不准 | LLM 解析 + 规则降级 + 模板兜底 |
| key 泄露 | config 0600、日志脱敏、导出可选脱敏 |
