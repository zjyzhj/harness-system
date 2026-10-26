# G2-DESIGN — 记忆升级

> Goal：G2 · 状态：⏳ 待实现 · 上游：[G2-spec](./G2-spec.md) · 下游：[G2-tasks](./G2-tasks.md)

## 1. 选型

| 项 | 方案 | 理由 |
|----|------|------|
| 向量 | **本地 char-ngram 哈希向量 + 余弦**（默认，零依赖）；可选 `OpenAI embeddings` adapter（有 key 时升级） | 对齐 CowAgent vector_backend 双后端思想；纯 TS 可测 |
| 权威总结 | **MEMORY.md per-bot + group**，LLM 按「新增记忆数/每日」触发重写 | 对齐 CowAgent memory/YYYY-MM-DD + MEMORY.md 模型 |
| 共享 | `MemoryNamespace = bot:<id> | group:<name> | global` | 简单清晰，检索按 bot→group→global 级联 |
| 存储 | 保持 `memory/<ns>.json` + `memory/<ns>/MEMORY.md` | human-readable、可迁移 |

## 2. 模块设计

```ts
// core/memory-system.ts 扩展
interface MemoryEntry { ..., namespace?: string; source?: string; score?: number }

class MemorySystem {
  setEmbedder(e: Embedder)                 // 默认 HashVectorEmbedder
  add(ns, entry, opts?: { version?: number })
  retrieve(ns, query, { cascade?: boolean }) // bot→group→global 合并排序
  rewriteMemo(ns, summarize: (memo, recent) => Promise<string>)  // 重写 MEMORY.md
  memoOf(ns): string                        // 常驻 system 注入
  listByNamespace(ns): MemoryEntry[]
  mergeDuplicate(ns): number                // 按内容 sim>0.9 合并
  evict(ns, budget): number                 // 超预算淘汰低分+久远
}

interface Embedder { embed(text): number[]; dim: number }
class HashVectorEmbedder implements Embedder {
  // char bigram 哈希到 384 维稀疏向量 → 归一化
}
class OpenAIEmbedder implements Embedder {   // baseUrl+key/model 注入
}
```

## 3. 上下文注入（buildContext 升级）

```
buildContext(bot, query):
  1) memo 常驻：MEMORY.md 全文（裁剪到 ~800 token）总是注入
  2) 语义检索：retrieve(bot:id ∪ group ∪ global, query, 8) → 相关记忆
  3) 近窗事实：最近 6 条 fact
优先级：memo > 语义命中 > 近窗事实；命中带 source/时间，供追溯
```

## 4. 触发与维护

- 触发重写：新增 ≥5 条事实 或 距上次重写 ≥24h 且变更 >0 → 排队重写（后台，不阻塞回复）。
- 重写 prompt：`把 MEMORY.md + 最近记忆 压成 ≤40 条要点，去重、保留关键事实与偏好`。
- 清理：每写 20 条触发 `mergeDuplicate`；总量 > 2000 条触发 `evict`（保留最近 30 天 + 高分）。

## 5. 面板「记忆」页

- namespace 标签页（bot / group / global）；来源过滤；全文搜索。
- 「重写总结」手动按钮；显示 MEMORY.md 当前内容（可编辑）。
- 合并/删除/导出。

## 6. 风险

- 哈希向量对中文同义召回有限 → 双通道（哈希向量 + 关键词 BM25 简单加权）兜底；有 OpenAI 嵌入时最优。
- 重写 LLM 缺失时：跳过重写，退回「最近记忆拼接注入」，不阻塞。
- group/global 权限泄漏：默认 group/global 仅「显式加入」的 bot 可见。

## 7. 改动文件

- `core/memory-system.ts`（namespace/embedder/memo）
- `core/embedders.ts`（新：HashVector + OpenAI）
- `core/bot-runtime.ts`（buildContext 接 memo+级联检索）
- `app/main.ts` + `renderer.js`（记忆页 namespace/来源/MEMORY.md 编辑）
- `tests/`（语义召回/级联/memo 重写/合并/迁移）
