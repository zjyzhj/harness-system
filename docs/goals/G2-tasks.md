# G2-TASKS — 记忆升级

> Goal：G2 · 状态：⏳ 待实现 · 上游：[G2-design](./G2-design.md)

## 0. 总览

| 任务 | 内容 | 出口 | 状态 |
|------|------|------|------|
| T2.0 | HashVectorEmbedder + cosine（双通道含 BM25） | 单测：同义改写召回 | ⬜ |
| T2.1 | MemorySystem namespace（bot/group/global）+ 迁移 | 旧数据映射到 bot:<id> | ⬜ |
| T2.2 | retriev cascade（bot→group→global）+ score | 级联合并排序测试 | ⬜ |
| T2.3 | MEMORY.md 生成/重写 + 常驻注入 | 重写触发 & 注入断言 | ⬜ |
| T2.4 | OpenAIEmbedder 可选接入 | 有 key 时用真嵌入，缺省降级 | ⬜ |
| T2.5 | mergeDuplicate / evict 维护策略 | 超限自动合并/淘汰测试 | ⬜ |
| T2.6 | 面板记忆页（namespace/来源/MEMORY.md 编辑/重写按钮） | UI 操作可用 | ⬜ |
| T2.7 | 集成验收（F1–F7） | 全绿 | ⬜ |

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
