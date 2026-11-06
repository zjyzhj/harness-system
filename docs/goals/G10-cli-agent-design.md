# G10 — CLI Agent 外包写代码（Bot 大脑 + 外部手脚）

> Goal：G10 · 状态：Phase A ✅ · 延伸：Bot 通用终端底座（2026-11-01）  
> 原则：聊天 Provider 负责理解与调度（Cursor 聊天**不再** `--mode ask`，靠空沙箱隔离，避免 Ask 人设拒工具）；**终端是 bot 能力**（默认 shell）；写用户仓库以 `cli.agent` **外包**。  
> 对齐：Grok「Bot + Tools」切分；Harness 用本机 CLI 当 Tool，不复刻云电脑。

## 1. 动机

Harness Bot 已有持久记忆、Vault、工具循环，但本机 `fs.write` / `bash` 只覆盖 workspace 白名单，扛不住大仓库改包。  
本机已安装的 `cursor-agent` / `claude` / `codex` 具备完整 coding agent 能力；聊天侧用空沙箱 / 关原生 tools 隔离，**写用户仓库**仍只走 `cli.agent`，避免聊天 CLI 直接改仓。

目标：

- Bot **借助外部 CLI 仍算自己的能力**（工具结果回对话、记忆可沉淀）
- 聊天继续轻量；写代码走显式派工
- 底层一次设计清楚：授权、目录、取消、审计、与后续 skill 包绑定可衔接

## 2. 非目标（本 Goal 不做）

- 把设置里的 CLI Provider 改成每轮 yolo Agent（拖垮闲聊）
- 在 Harness 内重做 Cursor 级 coding runtime
- 云电脑 / 合上电脑继续跑（G9 已排除）
- 自动克隆 / 接管外部 skill 包 Supervisor（可后续 G11 接 `boundSkillRoot`）
- 静默改用户任意路径且不授权

## 3. 核心对象

```text
Bot (记忆 / 人设 / Vault)
  ├─ 工程目录 agentCwd / agentDirs
  ├─ 终端槽（每目录一块 PTY）
  │     program = shell | agent:<cli>
  │     tools: term.open / read / write / keys / stop（cli.term 别名）
  │     consent: term:open（目录前缀，与派工分开）
  ├─ tool: cli.agent（上层：同槽切到 Coding CLI + 打 task）
  │     consent: cli:agent (strong) — 已有终端 ≠ 已批准改仓库
  └─ tool: bash.run（短命令 + 授权卡片；无常驻屏幕）
```

| 对象 | 职责 |
|------|------|
| 聊天 Provider | API 或本机 CLI（Cursor：无 ask 人设 + 空沙箱；Claude：关原生 tools）；负责理解与调度 |
| 终端底座 | 默认 shell；界面 xterm 与 Bot 读同一屏；不依赖本机是否装好 Coding CLI |
| `cli.agent` | 唯一写大仓库的外包入口；把该目录终端切到 agent 程序 |
| `cwd` | 工程根；须显式传入或来自 bot 已批准的绑定 |
| Consent `term:open` | 打开 shell 终端的目录信任 |
| Consent `cli:agent` | 与 `bash:*` / `term:open` 分离；默认强确认 |
| `bash.run` | 短命令；与终端并存，不接到 xterm |

## 4. 必须想清楚的设计点

### 4.1 边界：聊天 vs 派工

| | 聊天 CLI Provider | `cli.agent` |
|--|-------------------|-------------|
| 何时 | 每轮补全 | 模型主动调工具 |
| 模式 | Cursor：**不** `--mode ask`（Ask 会拒 Harness 工具）；`--sandbox enabled` + 空 workspace。Claude：`--tools ""` | agent / 可写用户工程 |
| cwd | 空沙箱（防扫 harness 仓；原生写文件无意义） | 用户工程绝对路径 |
| 超时 | ~3 min | 更长（默认 15–30 min，可配） |

**定案**：两套入口、两套参数构造，禁止复用 `completeCli` 的聊天参数去派工。模块 `core/cli-agent.ts`。  
**2026-11-01**：取消对话 Cursor 的 `--mode ask`——实战里模型会自称 Ask、拒 `cli.agent`、让用户切不存在的 Agent 模式。

### 4.2 三家 CLI 的 Agent 参数（实现时以本机 `--help` 再核）

| CLI | 方向性参数（设计意图） |
|-----|------------------------|
| cursor | 非 `ask`；`--trust`；`--workspace <cwd>`；可写 |
| claude | 允许 tools；`cwd` = 工程根；不强制 `--tools ""` |
| codex | `exec` 可写沙箱（去掉或放宽 read-only）；`--skip-git-repo-check` 按需 |

探测：`detectCli` 已有；调用前再查 `installed`，失败返回可读错误（引导安装/登录）。

### 4.3 工作目录与路径安全

1. **`cwd` 必填或可解析**：`args.cwd` → 否则 `env.PROJECT_ROOT` / bot 绑定 `agentCwd` → 仍无则工具失败并提示用户给路径或 `ui.form`。
2. **实路径**：`realpath` 后校验；拒绝 `/`、`$HOME` 本身、Harness `home` 配置目录（防改自己的 secrets）。
3. **允许根（Allowlist）**：
   - Phase A：每次强确认卡片展示完整 `cwd`；确认即「本次允许该目录」。
   - Phase B：Consent 可「总是允许此 bot 在此前缀下派工」（持久化 path prefix grants）。
4. **工程名单与 fs 权限（2026-11-01 再修订）**：
   - **`fs.list` / `fs.read`：本机任意可读路径**（桌面/下载等），**不再**用工程名单当读白名单；看结构不必 `bash ls`，也不要因「不在名单」绕 MCP。
   - 【工程目录】/`PROJECT_ROOT` = **终端槽位 + 派工默认 cwd**，不是浏览门槛。
   - **`fs.write` 仍只限 bot 工作区**；大仓库改文件走 `cli.agent`，不因「选目录 / 开终端」扩大 Harness 写面。

### 4.4 授权与审计

- 新 cap：`cli:agent`（文案：派本机 Coding CLI 改工程）。
- `requiresStrongConsent: true`；description 含：CLI 名、cwd、任务摘要（截断）、预估可写。
- 决策：`allow-once` 默认；可选 `allow`（对本 bot + 该 cwd 前缀）。
- Audit：`botId, cap, cli, cwd, taskPreview, ok, latencyMs, exitCode`；**不记** API key；命令行展示用截断 task。

### 4.5 任务与上下文怎么喂给 CLI

外包 CLI **看不到** Harness 完整 system prompt / 记忆全文（也不应倾倒）。

构造 `agentPrompt`：

```text
【角色】你是用户本机工程上的 coding agent，由 Harness bot「{name}」派来完成下列任务。
【工程】cwd = {cwd}
【任务】{task}
【约束】{可选：用户规则 / bot 记忆里 kind=rule 摘录最多 N 字}
【交付】改完后用简洁中文说明改了什么、怎么验证；不要索要 Harness 内部工具。
```

- `task`：模型传入的短任务（必填）。
- 可选 `context`：模型摘的相关文件路径/片段（限长）；禁止塞密钥明文（若含 `{{secret:` 先 fill 再… **不对 CLI 环境注入全部 secrets**，除非 task 显式需要且用户已在 Vault 配好、由 CLI 自身登录态处理）。
- **密钥策略**：默认不把 Vault 解包进子进程 env；依赖 CLI 已有登录。若未来要透传，单独 cap + 显式 allowlist 的 env keys。

### 4.6 并发、取消、超时

- 每 bot **默认同时 1 个** `cli.agent`（第二调用返回忙）。
- 绑定 Harness 当前 turn 的 `AbortSignal`：用户点停止 → kill 进程组。
- 超时：默认 20 min；超时 kill + 返回已收集的 stdout 尾部。
- 不在后台 Routine 里默默跑（本 Goal）；定时重跑留给后续 + 无人值守策略。

### 4.7 流式与 UX

- 子进程 stdout/stderr 抽「可读进度」（按行 / stream-json 增量）。
- 对话侧：工具卡片 `status: running|ok|error`；可选周期 `onBlock` 文本块「正在改…」。
- 结束后：`output` = 最终摘要（优先 CLI result 字段；否则 tail 8k）+ `cwd` + `cli` + `exitCode`。
- **不**自动 `git commit`；需要则任务里写明或用户另说。

### 4.8 与记忆 / 专 bot 的关系

成功派工后 Bot 可（由模型或宿主轻量钩子）：

- `env.set PROJECT_ROOT=cwd`（若尚未有）
- `memory.add` fact：常用 CLI、最近工程

专「改包 bot」：人设写明优先 `cli.agent`；记忆里固化根目录——**不**在本 Goal 做 skill 包 scripts 索引（留给绑定 skillRoot）。

### 4.9 失败与降级

| 情况 | 行为 |
|------|------|
| CLI 未安装/未登录 | 明确错误 + 设置页检测结果文案 |
| 用户拒绝授权 | 不重试换 CLI 绕过；告知被拒 |
| 非 0 退出 | 返回 stderr/stdout 尾部；模型可决定是否再派或改用小范围 `bash` |
| Harness workspace 小改 | 仍可用 `fs.*`；与 `cli.agent` 并存 |

### 4.10 安全威胁模型（摘要）

- 提示注入：恶意网页/文件诱使 bot 对敏感 cwd 派工 → **强确认展示 cwd** 为主要闸门。
- 路径逃逸：`cwd=../../` → realpath + 拒绝 home/harness 配置根。
- 密钥泄漏：不向 CLI 倾倒 Vault；审计不写 secret。
- 供应链：只 spawn 已知 bin 名（`cursor-agent`/`claude`/`codex`），不接受任意可执行路径参数（Phase A）。

## 5. API 草案

### 5.1 工具

```text
cli.agent
  参数:
    task: string          # 必填，任务说明
    cwd?: string          # 工程根；缺省用 PROJECT_ROOT / bot.agentCwd
    cli?: "cursor"|"claude"|"codex"  # 缺省：bot 偏好 → 本机第一个 installed
    timeoutMin?: number   # 可选，封顶 60
  返回: 文本摘要（含 cli/cwd/exit）
```

### 5.2 Bot 可选字段（Phase B）

```ts
agentCwd?: string;          // 已批准的默认工程根
agentCli?: CliName;         // 偏好 CLI
```

Phase A 可不改 Bot 类型，仅用 env / 参数。

### 5.3 Consent

```ts
cap: "cli:agent"
```

## 6. 模块落点

| 文件 | 职责 |
|------|------|
| `core/cli-agent.ts` | 参数构造、spawn、stream 解析、超时/取消、结果裁剪 |
| `core/adapters/cli.ts` | 聊天 Cursor：空沙箱 + sandbox，**无** `--mode ask`；**不**把派工 agent 参数混进聊天；可复用 `detectCli` / bin 表 |
| `core/bot-runtime.ts` | 注册 `cli.agent`；busy 锁；consent |
| `core/consent-center.ts` | 增加 `cli:agent` 标签 |
| `app/main` / 审计 UI | 如有能力矩阵页则展示新 cap |
| `tests/cli-agent.test.ts` | mock spawn：参数、拒绝路径、busy、abort |

## 7. 分期

| Phase | 交付 | 验收 |
|-------|------|------|
| **A 最小可用** ✅ | `cli.agent` + 三家 agent 参数 + 强确认 + 单 bot 一并发 + 测例 | [`core/cli-agent.ts`](../../core/cli-agent.ts)、[`tests/cli-agent.test.ts`](../../tests/cli-agent.test.ts) |
| **B 三家对齐** ✅ | `Bot.agentCli` / `agentCwd`；详情可设；`app.updateSelf`；派工回落；提示词可见 | [`core/types.ts`](../../core/types.ts)、[`app/renderer/side-panels.js`](../../app/renderer/side-panels.js) |
| **C 目录信任** ✅ | `requestCliAgent` +「总是允许此目录」前缀信任；权限区可撤销 | [`core/consent-center.ts`](../../core/consent-center.ts) |
| **探测驱动** ✅ | Coding Agent **注册表** + 实时探测；工具说明/提示词/设置跟随本机，不手写死名单；加后端=注册一条 | [`core/coding-agents.ts`](../../core/coding-agents.ts) |
| **加固** ✅ | 进程组终止；目录信任二次派工仍可见；`ready`；rule 注入；进度；bin 单表 | [`core/cli-agent.ts`](../../core/cli-agent.ts) |
| **地基** ✅ | 无人值守拒绝派工；无 consent 拒绝；不把 `{{secret}}` 填进外部 CLI；spawn 剥劫持 env；绝对路径；过浅前缀不能长期信任 | 同上 |
| **连续性** ✅ | 同 CLI 同目录续自己的会话号；续不上或换 CLI 时用工作线新开一次；聊天只带 ≤400 字摘要；偏好 auto/always/once | [`core/coding-thread.ts`](../../core/coding-thread.ts) |
| **编码终端** ✅ | 一个工程目录一块真终端。一个 Bot 可以同时留着几块（上限 4，多出来关掉最久没用的空闲终端），看着的是当前这块。换目录不关掉别的工程。打开方式与平时执行 CLI 相同。界面、Bot 易变上下文、cli.agent / cli.term 共用正在看的这一屏。用户和 Bot 都能继续输入。同一时刻只有一块在忙。空闲 30 分钟、这块换了 CLI、结束这块、退出应用会关掉对应终端。可靠性：缺 python3/桥接可读失败；starting 超时收尸；stop 后 SIGKILL 兜底；`stopAll` 清槽 | [`core/coding-presence.ts`](../../core/coding-presence.ts)、[`assets/pty-bridge.py`](../../assets/pty-bridge.py) |
| **D 衔接** | 与 PROJECT_ROOT / 专 bot 记忆模板；文档 | 改包 bot 开箱话术 |

## 7.1 产品契约：三条路径 + 何时亮终端面板（2026-11-01）

### 基层硬约定（审查后强制）

1. **空口进 Cursor 无效**：`actionGrounding`（与深度思考 `selfCheck` 同族）把本轮工具、此前工具、终端 presence（含冷 gaze 下其它活槽）交给快模型对照回复判决；不符则撤回并打回。**不靠中文词表**。闲聊/过短收尾可跳过核对。点「打开」≠ 进 Cursor；进 Coding CLI 必须真调 `cli.agent`（或 presence 已是活 agent）。
2. **打开必有活屏或可见失败**：`coding:open` 校验路径；失败 `phase=exited`（禁止 starting 僵尸）。「打开」撞上活着的 Coding CLI：**展示现有 agent 屏 + notice**，不画成失败空屏，也不偷偷换成 shell。
3. **对话脑 ≠ 派工手脚**：详情「对话模型」与「派工 CLI」分栏；聊天 Cursor 无 `--mode ask`，靠空沙箱隔离。
4. **两级 ui.ask（路径 → CLI）**：意图含糊时必须出路径卡（只看文件 / 打开终端 shell / 进 Coding CLI）；选进 CLI 且 ≥2 家已装、未点名、无 `agentCli` 时再出 CLI 卡。清晰意图禁止多此一举出卡。面板「打开」仍只起 shell。

## 7.1b 三条路径表

对外三条路径（工具名对用户隐形）；意图卡 options 与此对齐：

| 路径 | 用户看到 | Bot 路径 | 终端面板 |
|------|----------|----------|----------|
| **看/找/交文件** | 对话卡片、图片/文件 | `fs.list` / `fs.read` / `file.send` | **不亮** |
| **交互现场（shell）** | 终端黑底 + 对话 | `term.open` / 点「打开」 | **抢焦点亮起** |
| **派工改仓（Coding CLI）** | 终端黑底 + 对话 | `cli.agent` | **抢焦点亮起**（含复用进入 `busy` 且面板已收起） |

硬规则：

1. **`bash.run` / `fs.*` / `file.send` 永不自动打开终端面板**（短命令只有授权卡片）。
2. **抢焦点**：`term.open`、用户点「打开」、`cli.agent`→`starting`，以及 **复用 agent 进入 `busy` 且面板已收起**。
3. `term.read` / 已有活终端的后台刷新：可更新角标；用户主动收起后，非上述抢焦点条件**不**强弹。
4. 「工程目录」名单 = **终端槽位键 + 派工默认 cwd**；≠ 浏览白名单；≠ 已批准改仓库（仍要 `cli:agent`）；≠ `fs.write`。
5. 相册/下载/桌面等浏览：直接 `fs.list` / `fs.read`；**不要为浏览去 `term.open`**，也不要暗示「必须先加工程目录」。
6. 冷 gaze（视线在未开槽目录）：UI `snapshot` 可为 null；提示词 / grounding 用 `groundingSnapshot` 带上其它活槽。

## 8. 风险

| 风险 | 缓解 |
|------|------|
| 各 CLI 参数半年一变 | `cli-agent.ts` 集中；测例锁关键 flag；help 探测失败则文档化 fallback |
| 长任务卡 UI | 工具 running 态 + 可取消；勿阻塞整进程无响应（已有 abort） |
| 模型滥调 cli.agent | 提示词：仅改代码/工程时用；小文件仍 fs.write |
| 用户以为聊天 CLI = 会改代码 | 设置文案区分「对话用 CLI」vs「派工写代码」 |

## 9. 验收标准（Phase A）

1. Bot 调 `cli.agent` 且用户批准后，在指定 git 仓库内出现预期文件变更（人工或测例用 temp repo）。
2. `cwd` 指向 `~/.harness-bot` 或 `/` → 工具拒绝。
3. 用户点停止 → 子进程结束，工具返回「已取消」。
4. 聊天用 Cursor Provider 不写用户仓库（空沙箱）；派工 `cli.agent` 才改工程。
5. 审计一条 `cli:agent` 记录含 cwd/cli/ok。

## 10. 与后续「专 bot + skill 包」的接口预留

- `cli.agent` 解决 **通用写代码手脚**。
- 外置 skill 包（如飞书交割）后续用 `boundSkillRoot` + scripts 能力表；其中「改代码」步骤可 **内调** `cli.agent`，不必两套 spawn。
- 本文不实现 skill 索引；只保证 cap / cwd / prompt 构造可复用。
