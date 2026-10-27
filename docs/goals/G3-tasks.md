# G3-TASKS — 桌面宠物深度化

> Goal：G3 · 状态：✅ 已实现 · 上游：[G3-design](./G3-design.md)

## 0. 总览

| 任务 | 内容 | 出口 | 状态 |
|------|------|------|------|
| T3.0 | PetSkinRegistry + 默认/pixel 皮肤 | 单测：帧轮播数据正确 | ✅ |
| T3.1 | 宠物帧动画引擎（action→帧切换 + 空闲随机） | 窗口动画 ≥30fps | ✅ |
| T3.2 | 抽共用渲染器 common-render.js + 面板/宠物同源 | 单测共用模块 | ✅ |
| T3.3 | 宠物气泡富渲染 + 「打开会话」 | 点击从面板打开会话 | ✅ |
| T3.4 | Scheduler once/alarm + 宠物闹钟 | 到期弹气泡+通知，可推迟 | ✅ |
| T3.5 | 任务结果富展示进宠物（done/error 工具卡） | 定时任务完成宠物展示 | ✅ |
| T3.6 | persona 风格参数 + 皮肤联动妆容 | 换形象皮肤同步 | ✅ |
| T3.7 | 彩蛋交互（摸摸/双击）+ 多显示器拖拽记忆 | 交互反馈 + 重启保持位置 | ✅ |
| T3.8 | 集成验收（F1–F8） | 全绿 + 冒烟 | ✅ |

## 1. 顺序

```
T3.0 → T3.1 → T3.7（基础动画/拖拽）
T3.2 → T3.3（渲染共用 → 气泡富显 + 打开会话）
T3.4 → T3.5（闹钟 + 任务结果）
T3.6（皮肤联动）→ T3.8
```

## 2. 关键验收口径

- T3.0：`applyFrames("idle", 0|1|2)` 返回不同帧；`defaultSkin` 总是非空。
- T3.1：切 working 状态 → 帧循环切换到 work 帧组；`document.hidden` 时暂停轮播（性能断言）。
- T3.2：`renderBlocks` 同一输入在面板与宠物输出一致（单测快照）。
- T3.3：宠物气泡点「查看完整会话」→ 主面板窗口聚焦并选中该会话。
- T3.4：`create({kind:"once", alarmAt:+60s, notifyPet:true})` → 到期 `onAlarm` 触发一次，不再重复。
- T3.5：模拟 task-done 带 rich 块 → 宠物气泡出现工具卡。
- T3.6：`persona.generate(bot, desc, {style:"pixel"})` → bot.skinId 更新 + 皮肤帧可用。
