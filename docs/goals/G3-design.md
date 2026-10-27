# G3-DESIGN — 桌面宠物深度化

> Goal：G3 · 状态：✅ 已实现 · 上游：[G3-spec](./G3-spec.md) · 下游：[G3-tasks](./G3-tasks.md)

## 1. 现状与方案

| 维度 | 现状 | 方案 |
|------|------|------|
| 动画 | CSS 关键帧 3 种 | **Sprite/帧系统**：`PetSkin { frames: Record<Action, string[]>, fps }`，宠物窗口轮播帧；无图时 CSS 帧兜底 |
| 形态 | 情绪徽章 | **状态机扩展**：`mood × action` → 帧选择；idle/walk/sleep/celebrate/work |
| 富文本 | tinyMarkdown 单文件 | **抽共用** `app/renderer/common-render.js`（renderBlocks/tinyMarkdown/esc），面板与宠物同源 |
| 任务结果 | 仅系统通知 | `pushPetEvent(task-done, {rich})` 富块；宠物渲染工具卡片 |
| 闹钟 | 无 | `Scheduler` 扩展 `once` 类型 + `petAlarm` 投递标记 |

## 2. 数据模型

```ts
interface PetSkin {
  id: string;
  name: string;               // 风格名：像素/圆润/写实
  frames: Record<PetAction, string[]>;  // 每动作多帧（dataUrl 或 emoji）
  fps: number;
}

type PetAction = "idle" | "walk" | "jump" | "sleep" | "celebrate" | "work" | "think";

interface Bot { ... skinId?: string }          // bot 绑定皮肤
interface ScheduledTask { ..., kind?: "cron" | "once"; alarmAt?: number; notifyPet?: boolean }
```

- `assets/skins/<skinId>/frames.json + *.png`；默认内置 `default`（emoji/css 帧）+ `pixel`（程序化生成 3 帧）。
- 皮肤与形象打通：`persona.generate` 增加 `style?: "default"|"pixel"|"cute"` 参数，生成头像同时生成/选用配套皮肤帧。

## 3. 模块

```ts
// core/pet-skin.ts（新，纯 TS 可测）
class PetSkinRegistry {
  list(): PetSkin[]; get(id): PetSkin;
  applyFrames(botId, action, frameIndex): string;   // 取当前帧 dataUrl
  defaultSkin(bot): PetSkin;
}

// core/scheduler.ts 扩展
create({ kind: "once", alarmAt, notifyPet, ... })
onAlarm?.(task)                                  // 到期 → main 推宠物事件
```

## 4. 宠物窗口（pet.js/pet.html）

- 结构：`#pet-sprite`（帧容器，`<img>` 轮播） + 保留情绪徽章；`#pet-avatar` 降级为静态预览。
- 动画循环：`setInterval(1000/fps)` 切换帧；busy 时叠加 work/think 帧，空闲随机 idle/walk/jump。
- 气泡：复用 `common-render.js` 渲染富块；「查看完整会话」按钮 → `api.window.openSession(sessionId)`（新 IPC：聚焦主面板并跳到会话）。
- 任务事件：`task-done/task-error` 带 `rich` 块 → 宠物用 renderBlocks 展示（含工具卡）。
- 闹钟：`onAlarm` → `pushPetEvent({type:"alarm", ...})` → 宠物置顶气泡 + bounce + 系统通知；点击可推迟/关闭。

## 5. 面板配合

- 新 IPC：`window.openSession(sessionId)`（主面板收到后 select 会话）。
- 形象生成 flow 增加「风格」选择（default/pixel/cute）。
- 定时任务创建 UI 增加「一次性 + 提醒宠物」选项。

## 6. 风险

- 帧图生成依赖图像 API：离线用程序化像素帧（canvas 绘制 3 帧：站/跳/睡），不阻塞。
- 共用渲染器抽取避免双份 markdown 逻辑漂移：单测覆盖共用模块。
- 宠物频繁动画 CPU：窗口 60MB 预算，动画间隔 ≥100ms，document.hidden 时暂停。

## 7. 改动文件

- `core/pet-skin.ts`（新）、`core/scheduler.ts`（once/alarm）
- `app/renderer/common-render.js`（新抽取）、`pet.js`/`pet.html`/`pet.css`
- `app/main.ts`（openSession IPC / alarm 推送 / persona 风格）、`preload.ts`
- `core/persona.ts`（style 参数 + 皮肤生成）
- `tests/`（pet-skin、scheduler once、persona style、渲染共用）
