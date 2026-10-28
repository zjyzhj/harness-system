# G7-DESIGN — 宠物智能深化（从「功能多」到「智能完备」）

> Goal：G7 · 状态：📝 设计中 · 上游：G3（形态/帧）已完成 · 约束：prefs 默认关进阶能力；hide≠disable；不发明未实现能力

## 0. 诊断

当前宠物是**多引擎拼盘**（换装 / 动作 / FX / 互访 / 进化 / 搭话 / 一句话导演 / Live2D），各自能跑，但：

| 浅的表现 | 根因 |
|---------|------|
| 会换皮、会说话，但不像「这只」宠 | 外形、人设、情绪、记忆未共用一条心智总线 |
| 一句话能触发很多意图，体感仍碎 | 单次意图落地，没有节拍脚本与事后学习 |
| 开了智能开关仍「偶尔蹦一句」 | Companion / Visit / Evolve / Proactive 各管各的配额与状态文件 |
| 画个球 / 换装期望落空 | 形象管道诚实度不足：生成≠上台；硬切形状皮曾是假智能 |
| XP 升级 vs 自进化提议两套「进化」 | 产品叙事分裂 |

**原则（延续既有）：** 模型优先、规则兜底；进阶默认关；能力可关闭但不可假装已实现。

---

## 1. 目标产品形态

用户感知的完备性 = **同一只宠物**在四种时间尺度上连续：

1. **瞬间**（0–3s）：动作 / FX / 表情跟得上话和事件  
2. **回合**（一次对话 / 一句话设计）：多意图编排成可理解的小节拍，结果可解释  
3. **一天**（空闲）：在 prefs 打开时，搭话 / 做事 / 互访 / 换装共享情境与配额，不重复、不瞎换  
4. **成长**（周–月）：记忆沉淀、关系升温、进化提议结构化落地，外形与身份对齐

非目标（本 Goal 不做）：自研 Live2D 骨骼生成、全屏开放世界漫游、默认打开全部进阶开关。

---

## 2. 架构：PetMind（心智总线）

今日状态散落在 `pets.json` / `companion.json` / `pet-visits.json` / `pet-evolve.json` / `pet-effects.json` / `proactive.json` / bot 字段 / `prefs.pet(+Bots)`。

### 2.1 统一只读投影（先投影，后可合并存储）

```ts
/** core/pet-mind.ts — 纯函数聚合，各引擎仍可写自己的文件 */
interface PetMind {
  botId: string;
  identity: {
    name: string;
    persona: string;
    card?: PersonaCard;
    skinId?: string;
    avatar?: Bot["avatar"];
    avatarPath?: string;
  };
  body: {
    mood: PetMood;          // 与 pet.js data-mood 对齐
    action: PetAction;
    renderMode: "live2d" | "sprite" | "shape" | "emoji";
  };
  bond: {
    xp: number;
    stage: string;          // 与 XP 展示统一
    affinity: Record<string, number>; // peerId → 亲密度（互访驱动）
  };
  memory: {
    recentFacts: string[];  // 从 MemorySystem 抽 pet 相关
    lastVisitAt?: number;
    lastEvolveAt?: number;
    pendingEvolveId?: string;
  };
  autonomy: {
    prefs: PetPrefs;        // resolvePetPrefs 结果
    quotas: { chatLeft: number; workLeft: number; appearLeft: number };
    lastSpokeAt?: number;
    lastDecision?: { at: number; kind: string; via: "model" | "rule"; note: string };
  };
}
```

- **读**：Companion / Visit / Evolve / Director 执行前都 `loadPetMind(botId)`。  
- **写**：各引擎照旧；另增 `petMind.noteDecision(...)` 写到轻量 `pet-activity.jsonl`（可观测）。  
- **不**在 G7 第一期强行合并 JSON 文件（风险高）；先统一接口与活动日志。

### 2.2 记忆闭环（最高杠杆）

| 时刻 | 今日 | G7 |
|------|------|-----|
| 气泡完整对话 | BotRuntime 可写记忆 | 保持 |
| 空闲搭话 | 几乎不写 | 显著句 → `memory.add(source:"pet-companion")` |
| 互访结束 | 仅 visits 日志 | 双方各记一条短事实 + affinity± |
| 进化接受 | persona 字符串拼接 | 结构化补丁 + memory |
| 一句话改宠 | 改字段 | 记「用户偏好」事实（如「喜欢形状头像」） |

检索：companion / visit invent / evolve invent / director 的 user 提示统一塞 `PetMind.memory.recentFacts`（截断）。

---

## 3. 子系统深化（按优先级）

### P0 — 选型与具身（用户已踩过的坑）

**形象（Appear）** — 已部分落地，G7 收束：

1. 管道顺序固定：生图 → 模型选型(keep/shape/skin) → 规则选型 → 高分 petdex → 诚实说明  
2. `keep`：只改聊天头像/角色卡，**桌宠皮不动**  
3. `shape`：仅几何/色块意图或模型明示；渲染必须可见（blob 缓存键与换皮竞态已修）  
4. 禁止：无匹配时无脑 `shape-blob`

**具身（Body）** — 新建 `core/pet-motion.ts`：

```ts
// mood × action × traits → Live2D motion/expression 策略
resolveMotion(mind: PetMind): { group: string; expression?: boolean; holdSec: number }
```

替换 `pet.js` 里 `live2dOnAction` 的硬编码映射；sprite 行策略同源。目标：同一句「累了」在工作狂人设 vs 懒人设上动作不同。

### P1 — 节拍脚本（Director 从「触发器」变「导演」）

今日：`act` / `fx` / `say` 各推一条事件。

G7：`PetBeat[]` 可编排：

```ts
type PetBeat =
  | { type: "action"; action: PetAction; hold?: number }
  | { type: "fx"; phrase: string }
  | { type: "say"; text: string; title?: string }
  | { type: "wait"; ms: number }
  | { type: "skin"; skinId: string };

// resolveAndPlayScript(botId, beats) — 顺序 pushPetEvent + 间隔
```

- 规则：常见短语展开（「放个大招」→ fx + celebrate + say）  
- 模型：导演 JSON 可返回 `beats` 数组（上限 6）  
- FX invent / act 复用现有 registry，不新造渲染能力

### P2 — 关系型互访

- `affinity[peerId]`：串门成功 +1～3，冷落衰减  
- 选对象：模型或加权随机（亲密度 + 久未见）  
- 台词 invent 带上双方 recentFacts 与 affinity 档位  
- UI：历史里显示关系温度；可选「坐一会儿」（同屏气泡，不永久改 window 架构）

### P3 — 进化合一

合并叙事：

1. **XP stage**：仍驱动视觉环/称号（cosmetic）  
2. **Evolve proposal**：改身份（personaCard / persona 字段 / 可选 skill 草稿）  
3. 升级瞬间若 `selfEvolve` 开，可**顺带**触发一次 `observeSmart`（降噪：有内容才提议）  
4. `skill_hint`：生成 `skill.save` 草稿，用户「好」才写入 SkillRegistry——不自动落技能  

### P4 — Companion 可感知

在 prefs 打开时：

- 每次自主发言气泡带小字：`via model|rule · 配额 n/m`（设置里可关）  
- 设置页展示**有效 prefs**（全局 ⊕ 单宠覆盖），不要只写全局  
- 活动时间线：最近 20 条 `pet-activity`（换装 / 互访 / 进化 / 被 prefs 挡住）

### P5 — 工具与提示完备

- `pet.mind`：只读聚合（给 agent 与调试）  
- `pet.activity`：最近决策  
- 系统提示：只列出**当前 prefs 下真正可执行**的能力；关着的写「设置中未开启」——继续禁止假装  

---

## 4. 模块与文件（建议）

| 新增/改 | 职责 |
|--------|------|
| `core/pet-mind.ts` | 聚合投影、`noteDecision`、activity 读写 |
| `core/pet-motion.ts` | mood/action/traits → 动作策略 |
| `core/pet-script.ts` | Beat 解析与顺序执行辅助 |
| `core/persona.ts` | 保持智能选型；与 mind 对齐文案 |
| `core/pet-visit.ts` | affinity + 选型 |
| `core/pet-evolve.ts` | 结构化补丁 + 与 XP 钩子 |
| `core/companion.ts` | 读 mind；写记忆 |
| `app/main.ts` | 注入 invent；执行 script；IPC mind/activity |
| `app/renderer/pet.js` | 用 motion 策略；播 beats；活动入口 |
| `app/renderer/settings-pages.js` | 有效 prefs + 活动摘要 |
| `tests/pet-mind.test.ts` 等 | 选型 / 节拍 / affinity / 记忆写入 |

---

## 5. 分期落地

### Phase A — 地基（约 1 迭代）

- [ ] `PetMind` 投影 + `pet-activity.jsonl`  
- [ ] 记忆闭环：companion / visit / evolve accept / 一句话偏好  
- [ ] 形象选型回归测试锁定（球→shape+circle；狐狸 keep；少女→Live2D；模型覆盖规则）  
- [ ] 设置：有效 prefs 只读展示 + 活动最近条

### Phase B — 体感（约 1 迭代）

- [ ] `pet-motion` 驱动 Live2D/sprite  
- [ ] `PetBeat` 脚本 + 导演多拍  
- [ ] 互访 affinity  

### Phase C — 成长（约 1 迭代）

- [ ] 进化与 XP 叙事合一  
- [ ] skill_hint → 草稿确认流  
- [ ] `pet.mind` / `pet.activity` 工具  
- [ ] Companion「为何开口」可解释元数据

每期验收：**关 prefs 时行为不退化**；**开 prefs 时决策可在活动里追溯 via=model|rule**。

---

## 6. 风险

| 风险 | 缓解 |
|------|------|
| 模型延迟拖垮一句话设计 | 规则先返回；模型选型/节拍超时 15s 降级 |
| 记忆噪音 | 只写短事实；同类合并；companion 低置信不写 |
| Live2D 能力上限 | motion 策略只映射已有 group；不承诺新动作 |
| 范围膨胀 | 非目标写死；新功能必须挂上 PetMind 或明确「故意孤立」 |

---

## 7. 成功标准

1. 用户说「画个球」：可见圆球形状宠或诚实 keep+说明，绝不透明空壳。  
2. 同一 bot 在搭话 / 互访 / 进化提示里能引用最近相关事实。  
3. 打开互访一周后，亲密度高的一对更容易串门，台词不总是同一模板。  
4. 设置里能回答：「这只宠为什么刚才换装 / 为什么不说话」。  
5. Agent 调用 `pet.*` 时不会声称未开启的能力已执行。
