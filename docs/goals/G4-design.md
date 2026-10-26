# G4-DESIGN — 多 Bot 协作与编排

> Goal：G4 · 状态：⏳ 待实现 · 上游：[G4-spec](./G4-spec.md) · 下游：[G4-tasks](./G4-tasks.md)

## 1. 现状与方案

| 维度 | 现状 | 方案 |
|------|------|------|
| 通信 | MessageBus 文本路由 | **富消息体**：`TransportMessage.content: string|ContentBlock[]`，内部序列化保留块 |
| 群组 | 无 | **GroupRegistry**：`group:{name, members:botId[], admin}` + `@组` 解析 |
| 编排 | 无 | **Orchestrator**：`Plan = {stages:[{botId, prompt, mode:seq|fan}]}`，逐步执行 + 结果汇入 |
| 网关 | HttpTransport 半成品 | **GatewayServer**（http server：`/bots/msg` + `/health` + token 校验）+ 客户端已存在 |
| 可视化 | 无 | 面板编排视图（阶段卡片 + 状态点 + 结果） |

## 2. 数据模型

```ts
interface Group { id; name; members: string[]; admin: string; createdAt }

interface TransportMessage { ..., content: string | ContentBlock[]; kind?: "chat"|"bot-to-bot"|"group" }

interface OrchestrationPlan {
  id; ownerBotId; title; createdAt;
  stages: Array<{ id; botId; prompt; mode: "seq"|"fan"; status: "pending"|"running"|"done"|"error"; result?: string; startedAt?; finishedAt? }>;
  status: "pending"|"running"|"done"|"error";
}
```

## 3. 模块

```ts
// core/group-registry.ts（新）
class GroupRegistry {
  create(name, admin): Group; join/leave(id, botId); list(botId?); resolveAt("@组") -> members[]
}

// core/orchestrator.ts（新）
class Orchestrator {
  constructor(deps: { bus, groups?, memory })
  run(plan): Promise<OrchestrationPlan>          // 逐步执行；seq 串行、fan 并行
  stageResult(planId, stageId, ok, output)       // 回填 + 触发下一步
  cancel(planId); list(); prune(olderThan)
  // 权限：仅 ownerBotId ∈ groups 或 owner 是主控(user) 可 run
}

// core/gateway-server.ts（新）
class GatewayServer {
  constructor(port, token, bus)
  start(): Promise<void>; stop()
  // POST /health（GET）· POST /bots/msg（校验 token → bus.addTransport(new HttpTransport(url,token)) 回环）
}

// message-bus.ts 升级
send(from, to, content: string|ContentBlock[], ctx?)   // 富消息
broadcast(from, groupId, content)                     // 群组扇出
```

## 4. 编排流程示例

```
用户：让 A 调研，B 总结，C 写报告
→ Orchestrator.planFromText("...")  // LLM 解析成 stages（缺省 seq）
→ stage1: A handle("调研 X") → result
→ stage2: B handle("总结以下内容: <A结果>") → result
→ stage3: C handle("基于总结写报告: <B结果>")
→ 最终 report 回主控会话 + 宠物事件
```

- `planFromText` 用主控默认 provider LLM 解析；失败降级规则（`→` 分段、bot 名匹配）。
- 每个阶段把上一阶段 result 注入 prompt；超时（默认 5min）标记 error 并中止后续。

## 5. 网关

- 启动：主进程 `gateway.start({port: 8787, token})`（config 可开关）。
- 远程注册：对端 `HttpTransport(url, token)` 连入 → 本机 bus 收到远程消息按 bot id 路由；找不到 handler 时回「未注册」。
- 安全：token 放 config（0600）；消息体序列化 JSON（ContentBlock 数组）。

## 6. 面板

- 群组页：建组/加人/移除/@组 快捷输入。
- 编排视图：计划列表 + 阶段卡片（状态色点、耗时、结果预览、重试/取消）。
- 输入框支持 `@组名 任务` 和 `编排：...` 自然语言。

## 7. 风险

- 编排死锁/循环：阶段禁止引用自身；每计划最大 10 阶段；超时兜底。
- 富消息跨进程序列化：ContentBlock 直接 JSON，无特殊类型（dataUrl 大图注意体积，网关设 5MB 上限）。
- 权限：编排仅主控与 admin 组员发起；bot 无管理员时拒绝。

## 8. 改动文件

- `core/group-registry.ts`、`core/orchestrator.ts`、`core/gateway-server.ts`（新）
- `core/message-bus.ts`、`core/transport.ts`（富消息）
- `app/main.ts`、`preload.ts`、`renderer.js`（群组页/编排视图/@组）
- `tests/`（group/broadcast/orchestrator/gateway/富消息）
