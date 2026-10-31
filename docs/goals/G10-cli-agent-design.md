# G10 — CLI Agent 外包写代码（Bot 大脑 + 外部手脚）

> Goal：G10 · 状态：设计定稿 · 日期：2026-10-31  
> 原则：聊天 Provider **不改** Agent 模式；写仓库能力以工具 `cli.agent` **外包**给本机 Cursor / Claude / Codex CLI。  
> 对齐：Grok「Bot + Tools」切分；Harness 用本机 CLI 当 Tool，不复刻云电脑。

## 1. 动机

Harness Bot 已有持久记忆、Vault、工具循环，但本机 `fs.write` / `bash` 只覆盖 workspace 白名单，扛不住大仓库改包。  
本机已安装的 `cursor-agent` / `claude` / `codex` 具备完整 coding agent 能力，却在聊天适配器里被故意阉割（ask / 关 tools / read-only）。

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
  └─ tool: cli.agent
        ├─ resolve: which CLI + cwd + task
        ├─ consent: cap cli:agent (strong)
        ├─ spawn: cursor-agent | claude | codex  (agent / writable)
        ├─ stream: 进度摘要 → 对话 / 可取消
        └─ result: 文本摘要 + 可选变更提示 → 记忆可记 PROJECT_ROOT / 偏好 CLI
```

| 对象 | 职责 |
|------|------|
| 聊天 Provider | 仍为 API 或 CLI-ask；负责理解与调度 |
| `cli.agent` | 唯一写大仓库的外包入口（本 Goal） |
| `cwd` | 工程根；须显式传入或来自 bot 已批准的绑定 |
| Consent `cli:agent` | 与 `bash:dev` 分离；默认强确认 |

## 4. 必须想清楚的设计点

### 4.1 边界：聊天 vs 派工

| | 聊天 CLI Provider | `cli.agent` |
|--|-------------------|-------------|
| 何时 | 每轮补全 | 模型主动调工具 |
| 模式 | ask / tools 关 / read-only | agent / 可写 |
| cwd | 空沙箱（防扫 harness 仓） | 用户工程绝对路径 |
| 超时 | ~3 min | 更长（默认 15–30 min，可配） |

**定案**：两套入口、两套参数构造，禁止复用 `completeCli` 的 ask 参数。新模块 `core/cli-agent.ts`。

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
4. **与 `allowedRoots`（fs/bash）解耦**：`cli.agent` 不扩大 Harness `fs.write` 白名单；外包进程自己的权限模型。

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
| `core/adapters/cli.ts` | 保持聊天 ask；**不**把 agent 参数混进去；可复用 `detectCli` / bin 表 |
| `core/bot-runtime.ts` | 注册 `cli.agent`；busy 锁；consent |
| `core/consent-center.ts` | 增加 `cli:agent` 标签 |
| `app/main` / 审计 UI | 如有能力矩阵页则展示新 cap |
| `tests/cli-agent.test.ts` | mock spawn：参数、拒绝路径、busy、abort |

## 7. 分期

| Phase | 交付 | 验收 |
|-------|------|------|
| **A 最小可用** | `cli.agent` + cursor 优先 + 强确认 + 单 bot 一并发 + 测例 | 指定 cwd 能改文件；拒绝 harness home；停止能 kill |
| **B 三家对齐** | claude / codex agent 参数核验 + `agentCli` 偏好 | 设置里探测哪家可用，派工可选 |
| **C 目录信任** | cwd 前缀长期授权 + Bot.agentCwd | 二次派工同前缀可少点一次（仍可要求 once） |
| **D 衔接** | 与 PROJECT_ROOT / 专 bot 记忆模板；文档 | 改包 bot 开箱话术 |

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
4. 聊天用 Cursor Provider 仍为 ask，不写仓库。
5. 审计一条 `cli:agent` 记录含 cwd/cli/ok。

## 10. 与后续「专 bot + skill 包」的接口预留

- `cli.agent` 解决 **通用写代码手脚**。
- 外置 skill 包（如飞书交割）后续用 `boundSkillRoot` + scripts 能力表；其中「改代码」步骤可 **内调** `cli.agent`，不必两套 spawn。
- 本文不实现 skill 索引；只保证 cap / cwd / prompt 构造可复用。
