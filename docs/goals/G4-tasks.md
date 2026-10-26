# G4-TASKS — 多 Bot 协作与编排

> Goal：G4 · 状态：⏳ 待实现 · 上游：[G4-design](./G4-design.md)

## 0. 总览

| 任务 | 内容 | 出口 | 状态 |
|------|------|------|------|
| T4.0 | TransportMessage 富消息体 + MessageBus 富互发 | 图片块互发测试 | ⬜ |
| T4.1 | GroupRegistry（建组/成员/@组解析） | 广播到组员 | ⬜ |
| T4.2 | Orchestrator 顺序流水线 | A→B→C 单测 | ⬜ |
| T4.3 | Orchestrator fan-out + 汇总 + 超时/取消 | 并行与超时测试 | ⬜ |
| T4.4 | planFromText（LLM 解析 + 规则降级） | 一句话编排可用 | ⬜ |
| T4.5 | GatewayServer + 客户端互通 | 跨进程（本机两实例） | ⬜ |
| T4.6 | 面板：群组页 + 编排视图 + @组 输入 | UI 操作全链路 | ⬜ |
| T4.7 | 迁移（群组/编排结果）+ 权限校验 | 往返 + 非授权拒绝 | ⬜ |
| T4.8 | 集成验收（F1–F7） | 全绿 + 冒烟 | ⬜ |

## 1. 顺序

```
T4.0 → T4.1 → T4.2 → T4.3 → T4.4
T4.5（网关，可并行）→ T4.6 → T4.7 → T4.8
```

## 2. 关键验收口径

- T4.0：`bus.send(A,B,[{text},{image}])` → B 收到含 image 块；store 落盘保留。
- T4.1：建组 [A,B]，`broadcast(A,"@产品组 早会")` → A/B 都收到；非成员不收到。
- T4.2：三阶段 seq 计划跑完，stage3 输入含 stage2 结果；状态全 done。
- T4.3：fan 三路并行完成；单路超时 → 该 stage error，后续中止。
- T4.4：`"让 A 调研，B 总结，C 写报告"` 解析出 3 stages；无 LLM 时规则兜底。
- T4.5：起 GatewayServer(8787) → 远端 HttpTransport 发消息 → 本地收到并回执。
- T4.6：面板建群组、@组发送、编排视图显示阶段状态。
- T4.7：迁移含 groups/plans；非 admin bot 调 `run` 抛权限错。
