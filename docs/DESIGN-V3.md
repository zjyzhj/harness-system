# DESIGN-V3 — 真实模型接入 + 富会话显示

> 状态：✅ V3 完成 · 日期：2026-10-27
> 上游：[DESIGN-V2](./DESIGN-V2.md) · 触发：为系统接入真实模型 AI 能力，并让会话信息像 Grok Bot 一样显示文本/富文本/图片等。

## 0. 现状差距（诚实审计）

| 维度 | 现状 | 问题 |
|------|------|------|
| 消息模型 | `ChatMessage.content: string` | 无法表达图片/代码/工具/富文本 |
| 渲染 | `esc()` 纯文本 | markdown、代码块、图片全显示为纯文本 |
| 适配器 | 仅 `chat/completions` 非流式 `text` | 无流式、无多模态、无结构化 tool call |
| 会话 UI | 简单气泡 | 无 markdown、无附件、无工具调用展示 |

## 1. 设计目标

1. **消息 = 内容块数组**（对齐 Claude/OpenAI content blocks）：
   - `text`（可含 markdown）
   - `code`（语言 + 代码，渲染为代码块）
   - `image`（本地/远程/数据图）
   - `tool_call` / `tool_result`（工具调用卡片）
   - `file`（附件）
   - `thinking`（思考过程，可折叠）
2. **流式输出**：适配器支持 SSE 流式，UI 增量渲染（Grok Bot 打字机效果）
3. **多模态**：用户可发图片（粘贴/拖入），模型可回图片
4. **Markdown 渲染**：文本块渲染为 markdown（代码高亮、表格、列表）
5. **兼容性**：旧的纯文本消息自动升级为单 text 块；迁移格式兼容 v2

## 2. 数据模型（V3）

```ts
// 消息内容块（对齐 Claude/OpenAI）
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "code"; lang?: string; code: string }
  | { type: "image"; path?: string; url?: string; dataUrl?: string; alt?: string }
  | { type: "tool_call"; tool: string; args: Record<string, unknown>; callId: string; result?: string; status?: "ok" | "error" | "running" }
  | { type: "file"; path: string; name: string; size?: number }
  | { type: "thinking"; text: string };

// 消息（升级）
interface ChatMessageV3 {
  id?: number;
  sessionId: string;
  from: string;
  to: string;
  role: "user" | "assistant" | "system";
  content: ContentBlock[];       // 内容块数组
  kind: "chat" | "bot-to-bot" | "event";
  createdAt: number;
  meta?: {                       // 扩展信息
    providerId?: string;
    model?: string;
    latencyMs?: number;
    tokensUsed?: number;
    streamed?: boolean;
  };
}
```

## 3. 适配器层（Provider 接入真实模型）

统一 `LLMAdapter` 接口（对齐 CowAgent LLMModel）：

```ts
interface LLMAdapter {
  complete(req: LLMRequest): Promise<LLMResponse>;           // 非流式（兼容旧）
  stream?(req: LLMRequest, onChunk: (c: ContentBlock) => void): Promise<LLMResponse>;  // 流式
}

interface LLMRequest {
  model?: string;
  system?: string;
  history?: ChatMessageV3[];
  user?: string | ContentBlock[];
  tools?: ToolDescription[];       // 工具/技能/MCP 描述
  temperature?: number;
  stream?: boolean;
}

interface LLMResponse {
  content: ContentBlock[];
  raw?: unknown;
  usage?: { inputTokens?: number; outputTokens?: number };
  model?: string;
}
```

实现：
- `openai-compat` 升级：支持 `chat/completions` + `responses`（探测 wire_api），SSE 流式，工具描述（OpenAI tools schema）→ 结构化 tool call → 映射为 `tool_call` 块
- `cli` 保持：spawn 输出作为 text 块；codex 支持 base url 透传（已实现）
- 工具调用兼容：现有 ` ```tool ``` ` 文本约定保留为「模型无 tools schema 时的降级」；有 tools schema 时用结构化 tool call

## 4. 渲染层

- 引入轻量 markdown 渲染（不引大依赖：自实现子集或 `marked` 迷你版）：
  - 标题/粗斜体/列表/链接/表格
  - 代码块（``` + 语言）+ 行内 code
- 内容块渲染器 `renderBlock(block)`：
  - text → markdown
  - code → `<pre><code class="lang-...">`
  - image → `<img>`（file:// 需过 CSP：放宽 img-src 到 file:）
  - tool_call → 卡片（工具名 + 参数 + 结果/状态）
  - file → 附件样式（文件名 + 大小 + 打开）
  - thinking → 折叠的「思考中…」
- 流式：`appendMsg` 支持增量（同 session + 同 from + 最后一条是 running → 追加块）

## 5. 会话 UI（对齐 Grok Bot）

- 气泡内多块渲染（一条消息多个块）
- 用户消息：可带图片（粘贴自动上传为本地文件 + image 块）
- 助手消息：流式打字 + markdown + 代码高亮 + 工具卡片 + 图片
- 消息 meta（模型/耗时/token）小字显示在气泡下
- 会话标题：自动取首条消息摘要（已有雏形）

## 6. 实现顺序

| 阶段 | 内容 | 出口 |
|------|------|------|
| V3-1 | ContentBlock 类型 + 消息模型升级（兼容旧数据） | tsc 过 |
| V3-2 | LLMAdapter 接口 + openai-compat 升级（responses/流式/结构化 tools） | 测试过 |
| V3-3 | 渲染器（markdown 子集 + 块渲染 + CSP 放宽） | UI 渲染文本/代码/图片/工具卡片 |
| V3-4 | 流式接入 BotRuntime + IPC | 打字机效果 |
| V3-5 | 真实模型端到端（用 CC Switch 15721 端点） | 面板真实对话含 markdown/图片/工具 |
| V3-6 | 会话 meta + 附件（图片粘贴）+ 兼容迁移 | ✅ 完成 |

## 7. 风险

- markdown 渲染器自实现子集有安全/覆盖风险 → 白名单标签 + 严格转义
- CSP 需要放行 file: 图片 → 只对 img-src 放行，不放开 script
- responses API 与 chat/completions 字段差异 → 双实现 + 探测
- 流式与现有 ` ```tool ``` ` 文本约定叠加 → 结构化 tools 优先，文本约定降级

## 8. 实施记录（2026-10-27）

- **V3-1** `core/types.ts`：`ContentBlock` / `MessageContent` / `MessageMeta` / `LLMRequest` / `LLMResponse` / `StreamChunk` / `ToolDescription`，`ChatMessage.content` 升级为 `string | ContentBlock[]`；`contentText()` 兼容旧文本。
- **V3-2** `core/adapters/openai-compat.ts`：`chat/completions` + `responses` 双实现（`detectWireApi` 探测 + `wireApi` 手动覆盖 + responses 失败自动降级 chat）；SSE 流式（增量 text/tool_call 块回调）；结构化 tools → `tool_call` 块；responses 的 `reasoning` 块 → `thinking` 块。`ProviderCenter.streamComplete()` 统一入口。
- **V3-3** `app/renderer/renderer.js` + `style.css`：`renderBlocks()`/`renderBlock()` 块渲染（text→markdown、code、image、tool_call 卡片、file、thinking 折叠）+ 轻量 markdown 子集（白名单转义）；CSP 已放行 `data:`/`file:` 图片。
- **V3-4** `core/bot-runtime.ts` `handleStream()`：工具循环 + 增量块实时回推 + 富消息落盘（含 meta）；`app/main.ts` `chat:sendStream` IPC + `chat:stream` 事件推送；渲染器打字机效果。
- **V3-5** 真实端到端：CC Switch `http://127.0.0.1:15721/v1`（wire_api=responses）验证 responses 非流式 + SSE 流式均通过（`tests/e2e-live.test.ts`，需 `HARNESS_LIVE_E2E=1`）。
- **V3-6** 会话 meta（model/latency/tokens/streamed）落盘并显示；图片粘贴/拖入 → dataUrl image 块 → 富消息 `sendRich`；`buildMessages` 图片块降级为 `[图片]` 占位（多模态 wire 升级后续做）。
- 验证：`bunx tsc --noEmit` 0 错；`bun test` 60 过（含 5 适配器 + 2 流式 + 2 真实端点）；Electron 冒烟 bridge-ok。
