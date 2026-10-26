# G1-DESIGN — 会话与上下文工程

> Goal：G1 · 状态：⏳ 待实现 · 上游：[G1-spec](./G1-spec.md) · 下游：[G1-tasks](./G1-tasks.md)

## 1. 现状与选型

| 维度 | 现状 | 方案 |
|------|------|------|
| 消息存储 | `messages.json` 一文件全量 | **按会话分片**：`sessions/<sid>.jsonl`（每行一条，append 原子写）；元数据仍 `sessions.json` |
| 会话列表 | 全量数组 | 内存索引 + 按 `updatedAt` 倒序分页 |
| 搜索 | 无 | **标题/消息关键词线性扫描**（≤万级消息足够）+ bot/时间过滤；不引 SQLite |
| 上下文 | `slice(-10)` | **TokenBudget 估算器**（~4 chars/token）+ 分层压缩（旧→summary） |
| 摘要 | 一次性 | 增量压缩水位线：超过预算 60% 时压缩最旧 30%，记录已压缩边界 |

## 2. 数据模型

```ts
// jsonl 每行
{ id, sessionId, from, to, role, content, kind, createdAt, meta }

interface SessionIndex {
  id: string; botId: string; title: string;
  createdAt: number; updatedAt: number;
  archived?: boolean;
  messageCount: number;
  lastSeq: number;            // 已压缩的边界 seq
  tokenEstimate: number;
}

// store 新增
listSessions({ botId?, archived?, offset?, limit? }): { sessions: Session[]; total: number }
listMessages(sid, { before?, limit?, older? }): { msgs: ChatMessage[]; hasMore: boolean }
searchMessages({ q?, botId?, from?, to?, limit? }): SearchHit[]  // hit: {sid, msg, snippet}
appendMessage(m): void       // append jsonl + update SessionIndex（原子）
archiveSession(sid, archived: boolean)
```

## 3. 上下文预算裁剪（BotRuntime）

```
输入：history[] + 预算 B（默认 8000 token 用户侧 + system 独立）
流程：
  while 估算Total > B:
      取未压缩的最旧 30% 段 → 调 LLM 压成 summary
      标记该段 seq 边界 → 用 summary 占位（保留 1 条摘要消息）
  system 注入最终上下文 = system + 摘要占位 + 近窗(≤B*60%)
```

- `estimateTokens(blocks)`：text/code 按 length/4，image 记 1 token 卡片，工具卡片小常数。
- 摘要生成走 `MemorySystem.summarizeConversation`（已有）+ `SessionIndex.lastSeq` 去重。
- 压缩失败（无 provider）保留旧文本窗口（退化为现状）。

## 4. 迁移

- Store 构造时探测：`messages.json` 存在且 `sessions/` 为空 → 一次性转 jsonl（按 session 拆分 + 建 SessionIndex），完成后在 `messages.json` 写 `"migrated": true` 标记（保留原文件做回滚，删除由用户确认）。

## 5. 面板改动

- 会话列表：滚动到底加载更多（IPC 分页参数）。
- 消息窗口：顶部「加载更早消息」按钮 + 底部自动滚到最新。
- 搜索框：主面板顶部（当前会话内 / 全局两档），命中高亮 + 点击跳会话。
- 归档：会话列表右键「归档/取消归档/删除」。

## 6. 风险

- jsonl 追加并发：单进程 Electron 主进程串行写，用 `appendFileSync` + 队列；文件名含 sid 保证安全。
- 迁移大文件：10k 消息拆分 < 1s，可接受；失败用原文件回滚。
- 搜索性能：线性扫描 + 命中截断 50 条；超阈值给「缩小范围」提示。

## 7. 改动文件清单

- `core/store.ts`（分片/分页/搜索/归档）
- `core/context-budget.ts`（新：估算 + 裁剪策略）
- `core/bot-runtime.ts`（接预算裁剪）
- `core/migration.ts` / `migration-v2.ts`（v3 迁移）
- `app/main.ts` + `preload.ts` + `renderer.js`（IPC + UI）
- `tests/`（store 分片/搜索/归档/压缩/迁移）
