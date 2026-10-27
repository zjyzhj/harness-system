# G2-TASKS — 记忆升级

> Goal：G2 · 状态：✅ 已完成 · 日期：2026-10-27 · 上游：[G2-design](./G2-design.md)

## 0. 总览

| 任务 | 内容 | 出口 | 状态 |
|------|------|------|------|
| T2.0 | HashVectorEmbedder + cosine（双通道含 BM25） | 单测：同义改写召回 | ✅ |
| T2.1 | MemorySystem namespace（bot/group/global）+ 迁移 | 旧数据映射到 bot:<id> | ✅ |
| T2.2 | retriev cascade（bot→group→global）+ score | 级联合并排序测试 | ✅ |
| T2.3 | MEMORY.md 生成/重写 + 常驻注入 | 重写触发 & 注入断言 | ✅ |
| T2.4 | OpenAIEmbedder 可选接入 | 有 key 时用真嵌入，缺省降级 | ✅ |
| T2.5 | mergeDuplicate / evict 维护策略 | 超限自动合并/淘汰测试 | ✅ |
| T2.6 | 面板记忆页（namespace/来源/MEMORY.md 编辑/重写按钮） | UI 操作可用 | ✅ |
| T2.7 | 集成验收（F1–F7） | 全绿 | ✅ |

## 1. 顺序

```
T2.0 → T2.1 → T2.2 → T2.3 → T2.5 → T2.6
                     ↘ T2.4（可选增强）
T2.1 → T2.7
```

## 2. 关键验收口径

- T2.0：存「我喜欢吃辣」，查「我的口味偏好」→ 命中 top3；纯词表无关。
- T2.1：旧 `memory/<botId>.json` 自动映射到 `bot:<botId>`；无 namespace 读旧路径兼容。
- T2.3：新增 5 条事实后 `rewriteMemo` 触发一次；MEMORY.md 长度 ≤ 上限；buildContext 含 memo。
- T2.5：构造 100 重复条目 → merge 后 <10；构造 2500 条 → evict 后 ≤2000 且保留高分。
- T2.6：面板能切换 namespace、显示来源、编辑 MEMORY.md 并保存。

## 3. 实施记录（2026-10-27）

- T2.0：`core/embedders.ts` 新增 `HashVectorEmbedder`（char unigram+bigram 哈希→384 维 + 余弦）+ `OpenAIEmbedder`（可选 /embeddings）+ `keywordScore`（中文 BM25-lite 双通道）。
- T2.1：`core/memory-system.ts` 重构——namespace（bot:<id>/group:<name>/global），旧 `memory/<botId>.json` 自动迁移到 `bot:<botId>`（原文件删除 + 新文件）；`MemorySystem` 全接口保持旧签名兼容。
- T2.2：`retrieve`（向量+关键词双通道评分）与 `retrieveCascade`（bot→group→global 级联合并去重）；BotRuntime 的 `recall` 工具升级为语义级联检索。
- T2.3：MEMORY.md 权威总结——`memoOf/setMemo/rewriteMemo/shouldRewriteMemo`（≥5 新 fact 或 24h 触发）；`buildContext` 注入 memo 常驻 + facts + summaries + 检索命中。
- T2.5：`mergeDuplicate`（内容/余弦>0.9 合并）+ `evict`（容量淘汰，fact/高分优先保留）。
- T2.6：记忆面板升级——namespace 标签切换、来源显示、MEMORY.md 编辑/LLM 重写/合并按钮；IPC `memory:retrieve/namespaces/memo/setMemo/rewriteMemo/merge/evict`。
- 验证：`tsc` 0 错；`bun test` 82 过（新增 g2-memory 8）；Electron 冒烟 bridge-ok。
