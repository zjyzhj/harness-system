# G1-TASKS — 会话与上下文工程

> Goal：G1 · 状态：✅ 已完成 · 日期：2026-10-27 · 上游：[G1-design](./G1-design.md)

## 0. 总览

| 任务 | 内容 | 出口 | 状态 |
|------|------|------|------|
| T1.0 | jsonl 会话分片存储 + SessionIndex | `bun test` 分片读写/追加/重启恢复 | ✅ |
| T1.1 | 会话/消息分页 IPC + 面板加载更多 | 10k 构造会话秒开 | ✅ |
| T1.2 | 会话/消息搜索（IPC + UI 命中跳转） | 关键词命中定位 | ✅ |
| T1.3 | 归档/清理（软归档+恢复+删除） | UI 操作 + 数据不回列表 | ✅ |
| T1.4 | TokenBudget 估算器 + 裁剪策略 | 单测边界用例 | ✅ |
| T1.5 | 增量摘要水位线（lastSeq 去重） | 长会话自动压缩仅一次/段 | ✅ |
| T1.6 | 旧数据迁移（messages.json → jsonl） | 迁移测试往返 + 回滚 | ✅ |
| T1.7 | 集成验收（F1–F8 + 性能） | 10k 消息 < 1s，全绿 | ✅ |

## 1. 顺序

```
T1.0 → T1.1 → T1.2 → T1.3
     ↘ T1.4 → T1.5
T1.0 → T1.6（迁移） → T1.7
```

## 2. 关键验收口径

- T1.0：`appendMessage` 后 `listMessages` 一致；`sessions/<sid>.jsonl` 文件存在；重启后 `nextMsgId`/`messageCount` 正确。
- T1.1：`listSessions({offset:0,limit:20})` 返回 20 + total；`listMessages(sid,{older:true})` 增量正确。
- T1.2：`searchMessages("关键词")` 返回 `{sid, snippet}`；非法/空词返回空。
- T1.4：`estimateTokens` 对 text/code/image 估测合理；`trimToBudget` 只压最旧段且保留近窗。
- T1.5：连续两次 `handle()` 同一超预算会话，摘要消息只产生 1 条（用 lastSeq 断言）。
- T1.6：构造 5k 消息旧格式 → `Store` 启动迁移 → jsonl 数据一致；原文件保留 + `migrated:true`。

## 3. 实施记录（2026-10-27）

- T1.0–T1.3、T1.6、T1.7：`core/store.ts` 重写——消息按会话分片为 `sessions/<sid>.jsonl`（append-only），新增 `listSessionsPage` / `listMessagesPage`（beforeId 窗口）/ `searchMessages`（线性扫描+命中截断）/ `archiveSession` / `deleteSession` / `markCompacted`；旧 `messages.json` 自动迁移（原文件保留 + `migrated:true`）。
- T1.4–T1.5：`core/context-budget.ts` 新增 `trimHistoryToBudget`（token 估算 `estimateTokens` ~4 chars/token + 超预算压缩最旧 30% 段为 summary + lastSeq 去重）；`BotRuntime.handleStream` 接入预算裁剪（`budgetTokens` 可调，默认 8000）。
- UI：面板搜索框（命中跳会话）、消息「加载更早」分页、会话右键归档/取消归档/删除；IPC：`sessions:page/archive/delete`、`messages:page/search`。
- 性能实测：10k 消息打开 5ms、搜索 1ms（远超 <1s/<500ms 目标）；追加单条 ~0.18ms。
- 验证：`tsc` 0 错；`bun test` 74 过（新增 g1-store 7 + g1-budget 4）；Electron 冒烟 bridge-ok。
