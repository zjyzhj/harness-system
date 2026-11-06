# G4-DESIGN — 多 Bot 协作

> Goal：G4 · 状态：✅ 群聊已实现 · ❌ 编排已退役（2026-11，对齐 Grok：群聊 @ / bot.ask） · 上游：[G4-spec](./G4-spec.md) · 下游：[G4-tasks](./G4-tasks.md)

多 Bot 协作以**群聊**为产品面：一间房、多段对话、接力与插话。原「编排 / Orchestrator / plan.*」产品与引擎已全删；多步接力请用群聊 `@` 或 `bot.ask`。

| | 群聊 |
|---|---|
| 是什么 | 一间房，里面可以有多段对话 |
| 对应关系 | 一段对话同时只有一轮接力。换到另一段不停掉这段；同一段再发一句是插话 |
| 中途变化 | 人离开后还没开口的跳过；被点名的说完这一句。主持人离开后不再替他小结。群名唯一 |
| 谁能发起 | 用户建房；成员在自己的房里发言 |

## 1. 现状与方案

| 维度 | 方案 |
|------|------|
| 通信 | **富消息体**：`TransportMessage.content: string\|ContentBlock[]` |
| 群组 | **GroupRegistry** + 群聊会话 / 接力 |
| 编排 | **已退役**（无 `core/orchestrator`、无 `plan.*` 产品工具、迁移忽略旧 `plans`） |
| 网关 | **GatewayServer** |

## 2. 模块

- `core/group-registry.ts`、`core/group-session.ts`、`core/group-relay.ts`
- `core/gateway-server.ts`
- 面板：群组页 / `@组`

## 3. 退役说明

- 历史会话 id 前缀 `plan-` 仍可只读浏览（后台会话标签）。
- 旧迁移包里的 `plans` 字段导入时跳过（`skippedPlans`）。
- 模型若仍调用 `plan.*`，运行时返回「编排已下线」引导。
