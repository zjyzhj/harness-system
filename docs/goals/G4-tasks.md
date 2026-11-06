# G4-TASKS — 多 Bot 协作

> Goal：G4 · 状态：✅ 群聊保留 · ❌ T4.2–T4.4 / 编排 UI 已退役（2026-11） · 上游：[G4-design](./G4-design.md)

## 0. 总览

| 任务 | 内容 | 出口 | 状态 |
|------|------|------|------|
| T4.0 | TransportMessage 富消息体 + MessageBus 富互发 | 图片块互发测试 | ✅ |
| T4.1 | GroupRegistry（建组/成员/@组解析） | 广播到组员 | ✅ |
| T4.2 | Orchestrator 顺序流水线 | A→B→C 单测 | ❌ 退役 |
| T4.3 | Orchestrator fan-out + 汇总 + 超时/取消 | 并行与超时测试 | ❌ 退役 |
| T4.4 | planFromText（LLM 解析 + 规则降级） | 一句话编排可用 | ❌ 退役 |
| T4.5 | GatewayServer + 客户端互通 | 跨进程（本机两实例） | ✅ |
| T4.6 | 面板：群组页 + @组 输入（编排视图已删） | UI 操作全链路 | ✅ |
| T4.7 | 迁移（群组；`plans` 跳过并计 `skippedPlans`） | 往返 | ✅ |
| T4.8 | 集成验收（F1/F2/F5/F7） | 群聊冒烟 | ✅ |

## 1. 顺序（历史）

```
T4.0 → T4.1 →（T4.2–T4.4 已退役）
T4.5（网关）→ T4.6 → T4.7 → T4.8
```

## 2. 关键验收口径（现行）

- T4.0：`bus.send(A,B,[{text},{image}])` → B 收到含 image 块；store 落盘保留。
- T4.1：建组 [A,B]，`broadcast(A,"@产品组 早会")` → A/B 都收到；非成员不收到。
- T4.2–T4.4：已退役；勿再实现 / 测试编排引擎。
- T4.5：起 GatewayServer → 远端 HttpTransport 发消息 → 本地收到并回执。
- T4.6：面板建群组、@组发送；无编排视图。
- T4.7：迁移含 groups；`payload.plans` 忽略并返回 `skippedPlans`；导出不再写 `plans`。
- T4.8：群聊接力 / 插话 / 轮数上限冒烟通过。
