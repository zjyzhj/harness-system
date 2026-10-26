# 调研：成熟开源 AI Agent/Bot 的底层运行时实现

> 目标读者：macOS bot 项目复刻者
> 调研对象（2026-10 快照，均通过 `gh api` 只读拉取）：`zhayujie/CowAgent`（Python）、`deepseek-ai/deepseek-harness`（TS，Everything is a Plugin）、`openclaw/openclaw`（TS，OpenClaw 官方 39 万 star）、`cline/cline`、`RooCodeInc/Roo-Code`（VS Code AI）
> 结论依据：各仓库真实文件路径 + 源码/文档片段；行号未逐行标注，路径可直接去仓库核对。

## 1. 目录落点（memory / skills / scheduler / tools）

### zhayujie/CowAgent（Python 多智能体）
| 能力 | 路径 |
|---|---|
| 记忆 | `agent/memory/`（`manager.py` 总入口、`conversation_store.py` SQLite 会话、`summarizer.py` 摘要/Deep Dream、`vector_backend.py`、`chunker.py`、`reranker.py`、`storage.py`、`embedding/`） |
| 技能 | `agent/skills/`（`loader.py` 目录发现、`frontmatter.py` YAML 解析、`service.py`、`manager.py`、`types.py`） |
| 定时 | `agent/tools/scheduler/`（`scheduler_service.py` 后台线程、`scheduler_tool.py` Agent 工具、`task_store.py` JSON 持久化、`time_utils.py`） |
| 工具/插件 | `agent/tools/`（`tool_manager.py`、`base_tool.py`、`mcp/mcp_tool.py`、`bash/`、`web_search/`、`browser/` 等） |
| 上下文组装 | `agent/prompt/builder.py`（system prompt 分节：persona → tools → skills → memory → 项目上下文） |

### deepseek-ai/deepseek-harness（TS monorepo）
| 能力 | 路径 |
|---|---|
| 记忆/会话 | `packages/session/`（多条 `session-*` 子包）、`packages/compaction/`（`compaction/`、`compaction-image-offload/`、`compaction-tool-result-pruner/`） |
| 技能 | `packages/skill/skill/src/index.ts`（register/render/发现）、`packages/skill/skill-filesystem/`（磁盘扫描）、`packages/skill/tool-skill/`（`skill` 工具）、`packages/skill/tool-workspace-dependencies/` |
| 定时 | `packages/schedule/schedule/src/`（`domain.ts` 规则编解码 + 校验、`runtime.ts`、`storage.ts`、`types.ts`、`client.ts`、`update.ts`）、`packages/schedule/tool-schedule/` |
| 工具/插件 | `packages/extensions/cordis-*` + `vendor/cordis/`（微内核容器）、`packages/tools/`、`packages/mcp/`、`packages/tool-*` 大量工具子包 |
| 上下文管理 | `packages/context/`、`packages/spill/`、`packages/llm/`、`packages/typert/` |

### openclaw/openclaw（TS，官方）
| 能力 | 路径 |
|---|---|
| 记忆 | `packages/memory-host-sdk/src/`（`engine-storage.ts`、`engine-embeddings.ts`、`engine-sessions.ts`、`host/sqlite.ts`、`host/session-transcript-corpus*.ts`）、`src/plugins/memory-*`（state/runtime/provider） |
| 技能 | `src/skills/`（`loading/` 加载器、`discovery/`、`library/`、`lifecycle/` 安装、`runtime/`、`workshop/`）、`packages/skill/skill-filesystem/` |
| 定时 | `src/agents/tools/cron-tool*.ts`、`src/cron/`、`src/claws/cron.ts`、`src/cli/cron-cli/`、`src/state/` 下 `*cron*` schema（postgres/sqlite） |
| 工具/插件 | `packages/plugin-sdk/src/`（`plugin-entry.ts`、`cli-runtime.ts`、`core.ts`、一堆 `*-runtime.ts`）、`src/plugins/`（registry）、`packages/plugin-package-contract/` |
| 多智能体 | `src/agents/subagents/`（`registry/`、`swarm/`）、`packages/worker-runtime/` |

### cline/cline 与 RooCodeInc/Roo-Code（VS Code AI）
| 能力 | 路径（两仓合并） |
|---|---|
| 记忆 | Cline：`docs/best-practices/memory-bank.mdx`（文档化记忆法，非内置 DB）；Roo：`src/core/task-persistence/TaskHistoryStore.ts`（任务历史/断点恢复） |
| 技能 | Cline：`docs/customization/skills.mdx`、`src/core/tools/SkillTool.ts`（Cline 侧）、`.cline/skills/`；Roo：`src/services/skills/SkillsManager.ts`、`src/core/tools/SkillTool.ts`、`src/shared/skills.ts`、`.roo/skills/` |
| 定时 | Cline：仅 CLI/SDK 支持，`.cron.md` 文件（`sdk/examples/cron/*.cron.md`）、`docs/cli/scheduling.mdx`、`docs/sdk/guides/scheduled-agents.mdx`；Roo：无内置 cron |
| 工具/插件 | Cline：`docs/mcp/mcp-overview.mdx`、`docs/sdk/tools.mdx`、`docs/sdk/guides/creating-custom-tools.mdx`、hooks（`sdk/examples/hooks/`）+ MCP；Roo：`src/core/tools/`（`BaseTool`）+ MCP |
| 上下文 | Cline：`docs/core-workflows/working-with-files.mdx`（context files）；Roo：`src/core/context-management/`、`src/core/condense/`（折叠/压缩） |

## 2. 记忆存储与注入模式

**CowAgent：文件 + SQLite + 向量混合，明确三层**
- 长期记忆层：markdown 文件树，`memory/YYYY-MM-DD.md`、`memory/shared/`、`memory/users/<id>/`、`knowledge/`；`MEMORY.md` 为“权威总结”文件，**每次会话注入 system prompt**（`prompt/builder.py` 的 memory 分节）。
- 短时/会话层：SQLite `<workspace>/memory/long-term/index.db`，三张表 `sessions` / `messages` / `runs`（`conversation_store.py`），按 `(agent_id, session_id, seq)` 组织，支持会话恢复、上下文用量快照、裁剪。
- 检索：hybrid —— 向量（embedding provider）+ 关键词 FTS5，`vector_weight` 融合，可选 reranker；`chunker.py` 分块；**temporal decay**（`_compute_temporal_decay`，半衰期 30 天，只作用于带日期的日记文件，`MEMORY.md` 为 evergreen）。
- 自动摘要：`summarizer.py` —— 上下文裁剪/溢出时把被丢弃的对话用 LLM 汇总为当日记录；`flush_memory()` 支持 `threshold / overflow / daily_summary` 三种触发；另有“Deep Dream”阶段把每日记录蒸馏为 `MEMORY.md` + 梦境日记（提供提示词模板，见文件内 `SUMMARIZE_SYSTEM_PROMPT` / `_DREAM_*_PROMPT`）。

**OpenClaw：SQLite + 可选向量，插件化能力注册**
- 存储：SQLite（`packages/memory-host-sdk/src/host/sqlite.ts`），引擎分 `engine-storage.ts`（语料）、`engine-embeddings.ts`（嵌入）、`engine-sessions.ts`（会话）；向量后端可插拔（`store.vector.enabled + extensionPath`，默认 sqlite-vec / FTS `unicode61` tokenizer）。
- 注入：`src/plugins/memory-state.ts` 是核心 —— 记忆以 **plugin capability 注册**方式挂进运行时（`MemoryPromptSectionBuilder` / `PreparedMemoryPromptSection`），`memory-prompt-prepare.ts` 把“本次可用工具集、agent/session key、project key”传给 builder 生成注入片段；检索有“memory + sessions”双语料源（`memory-search.ts`，`sources: ["memory","sessions"]`），远程/本地 embedding provider 可降级为 tokenizer-only。
- 分层：短期=当前 session transcript，长期=记忆语料库，跨会话=`rememberAcrossConversations` 开关把 sessions 也纳入检索。

**Cline：Memory Bank（纯 Markdown 方法论）**
- `memory-bank/` 六个文件（`projectbrief/productContext/activeContext/systemPatterns/techContext/progress.md`）以规则（`.clinerules`）驱动 Agent 主动读写；原理是“用文件代替数据库”，可一键 `update memory bank` 压缩会话。适合 bot 复刻的最低成本方案。

**Roo-Code：任务持久化**
- `TaskHistoryStore.ts` 保存每次 task 的历史（含 API messages），支持跨 CR 恢复；`src/core/condense/` 做上下文折叠。本质是“session 级记档 + 摘要折叠”，非长期知识库。

**共性问题与结论**：所有项目都避免“把全部历史塞进上下文”。通用模式 = 短期(SQLite/会话 JSONL) + 长期(文件/向量) 两层；`MEMORY.md` 式“权威小结文件每次注入 + 检索结果按需注入”是最省事且被验证的组合。

## 3. Skills 规范与加载

**统一规范：目录 + `SKILL.md` + YAML frontmatter**
- CowAgent `frontmatter.py`：`FRONTMATTER_RE = ^\ufeff?---\s*\n(.*?)\n---\s*\n`，PyYAML safe_load（无 PyYAML 时退化为简单 KV 解析），必填 `name` / `description`。
- OpenClaw `src/skills/loading/frontmatter.ts`：严格解析（`parseFrontmatterBlockResult`，出错即报 invalid），额外支持 `install`（brew/node/go/uv/download 安全校验）、`os`、`requires` 等字段，有专门的安全正则（如 brew formula、npm spec、download URL 只允许 http/https）。
- Roo `SkillsManager.ts`：`gray-matter` 解析 frontmatter；skill 名 = 目录名；支持符号链接扫描。
- Cline `docs/customization/skills.mdx`：`name` 必须等于目录名，`description` 决定何时触发（≤1024 字符）。

**加载与渐进披露（progressive disclosure）**
- Cline 三级披露：Metadata（启动时 ~100 token/个，仅 name+description）→ Instructions（触发时加载 SKILL.md 正文）→ Resources（按需 read_files / scripts）。
- OpenClaw：`skill-prompt-catalog.ts` 把可用技能渲染成 `<available_skills>` XML 目录（name+location）；`skill-prompt-limits.ts` 做预算裁剪（默认最大 150 个、18k 字符，超出降级 compact 格式）；`skill-materializer.ts` 计算 content hash + displayName + 调用策略（`disableModelInvocation`）。
- CowAgent `prompt/builder.py`：skills 分节紧随 tools 之后，理由是“技能需要 read 工具才能读全”——即目录只放名称+描述，正文靠 Agent 主动 `read`（这也是渐进披露的一种廉价实现）。
- Roo：skills 可按 mode 划分（`skills/` 通用 + `skills-{mode}/` 按模式），通过 `skill` 工具参数触发并带 approval。

**触发方式**：统一做成“模型可选工具”（`skill` tool / slash command），正文只在调用时进入上下文；OpenClaw 还检查技能目录变更（watcher）与 safety scan（`src/skills/security/`）。

## 4. 定时任务实现

**CowAgent：自研线程循环 + croniter（无 APScheduler 依赖）**
- `scheduler_service.py`：后台 `threading.Thread` 主循环，`_is_task_due` 轮询持久化任务；失败“下个 tick 重试”；支持 `run_now` 立即执行（不改动原 schedule）、timezone（IANA）。
- 工具层 `scheduler_tool.py`：通过 function calling 暴露 create/list/get/delete/enable/disable；`schedule_type ∈ cron | interval | once`：cron 用 `croniter` 校验+算下次，interval 秒数，once 支持相对时间 `+5s/+10m/+1h` 或 ISO。
- `task_store.py`：单 JSON 文件（`{"tasks": {...}}`），每任务含 id/name/message/ai_task/schedule/时区/created_at/enabled；原子写（`common/atomic_write`）、RLock 并发保护。

**OpenClaw：`automation` 工具 + 持久化 store + delivery 配置**
- `src/agents/tools/cron-tool.ts`：`name: "automation"`，actions 覆盖 create/list/get/update/delete/run-now/enable/disable；`cron-tool-schema.ts` 定义参数；`cron-tool-creator-cap.ts`/`cron-creator-authority-context.ts` 做创建者授权管理（agent 只能管自己的 job）。
- 任务类型：`CronJobWire`（`packages/gateway-protocol/src/schema/cron.types.js`），schedule 支持 cron/interval/once/at 等；`CronDelivery` 配置结果投递（会话内消息 / 频道 / webhook），`cron-run-logs` 记录每次执行、`diagnostics` 保留故障诊断；`src/claws/cron.ts` 做记录与赎回。
- 存储：PostgreSQL / SQLite schema（`src/state/postgres-schema.generated/fragment-cron_*`），含运行时授权表、run receipts、触发状态退役——即**任务与执行历史都持久化**，重启可续跑。

**Cline：`.cron.md` 文件即任务定义**
- CLI hub 调度（`cline schedule`），任务文件（`sdk/examples/cron/daily-code-review.cron.md`）frontmatter：`id / title / workspaceRoot / schedule("0 9 * * MON-FRI") / tools / mode(act|plan|yolo) / enabled / modelSelection / timeoutSeconds / systemPrompt / maxIterations / tags / metadata / notesDirectory / extensions(source, rules, skills, plugins)`，正文 = 任务 prompt。自动批准自身工具调用（无人值守）、`max-parallel` 默认 1、pause/resume、执行历史与统计（`docs/cli/scheduling.mdx`）。

**deepseek-harness：`ScheduleService`（cordis Service，规则语言 + 持久化+同步）**
- `package schedule`：`ScheduleRecord` 分 `at/every/after/daily/weekly/cron` 六种规则（`domain.ts` 严格解码、Temporal polyfill 算时间、`CRON_SEARCH_HORIZON_YEARS=400` 防止不可满足规则失控）；注册为 `ctx.schedule` 服务（`declare module '@deepseek-ai/cordis' { interface Services { schedule: ScheduleService } }`），由 RemoteService 同步宿主，`archiveAdmission()` 等入口，历史 `schedule/change` 事件留痕。

**失败重试共性**：无人值守定时任务普遍“自批准工具调用 + 记录 run/诊断 + 失败通知（webhook/消息）”，重试多为下个周期自然重跑，而非即时重试（CowAgent 明确“delivery failed, will retry next tick”）。

## 5. 工具/插件体系

**都是 function calling（OpenAI tool schema）在前，MCP 做外部集成**
- CowAgent：`tool_manager.py` 统一注册/校验/执行（含参数截断、整型校验、路径安全），工具即 Python 类实现 `execute(params) -> ToolResult`；MCP 单独走 `agent/tools/mcp/mcp_tool.py`（动态装载 MCP server 工具）。
- OpenClaw：`packages/plugin-sdk/src/plugin-entry.ts` 是插件入口契约（几十个 `*-runtime.ts` 分别管 config/provider-auth/secret/tools/exec-approvals 等），`src/plugins/` 是运行时注册中心（registry + config-state）；插件可注册 memory capability、skill bundle、cron authority、provider、UI contribution 等，**memory/skills/cron 全是“插件能力”**。
- deepseek-harness：`vendor/cordis/` 微内核容器（Context/Service/Event/Registry），插件 `apply(ctx)` 里 `ctx.tools.register(defineTool({name, description, parameters, output, execute, presentCall}))`（见 `packages/extensions/tool-cordis/src/index.ts`）；`packages/mcp/` 独立过 MCP；`packages/tools/` 提供 `defineTool` 声明式 DSL。
- Roo：`BaseTool` 子类（如 `SkillTool extends BaseTool<"skill">`），实现 `execute()` + `handlePartial()`，注册进工具集，使用 Anthropic tool-use 协议；MCP 另设 `src/core/mcp/`。
- Cline：MCP 为主（`docs/mcp/`），SDK 提供自定义工具 API（`docs/sdk/guides/creating-custom-tools.mdx`），hooks（`PreToolUse.py` 等）提供**事件钩子注入上下文/改写输入**（示例 `PreToolUse_InjectContext`：在工具执行前注入文件上下文、环境信息）。

**插件注册接口长什么样（最小仿写面）**
```ts
// deepseek-harness / cordis：声明式
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'my_tool',
    description: '...',
    parameters: { foo: { type: 'string' } },
    execute(args, exec) { /* return JsonValue */ },
  }))
}

// OpenClaw plugin entry（plugin-sdk/plugin-entry.ts）：导出 name/apply 等契约
export const name = 'my-plugin'
export const inject = ['tools', 'memory', 'skills']
export function apply(ctx: PluginContext): void { /* ctx.tools.register(...); ctx.memory.register(...) */ }
```

## 6. 最值得复刻的成熟设计模式清单

1. **Markdown 即长期记忆（CowAgent / Cline）**：`MEMORY.md` 权威总结常驻 system prompt + 按日期/主题的 md 文件树 + 向量/FTS 检索按需注入。起步零依赖、人类可读、可 diff、可手工编辑 —— macOS bot 复刻首选。
2. **会话 JSONL/SQLite + 摘要压缩（CowAgent / deepseek / Roo）**：短期记忆单文件 `sessions/messages` 表持久化；达到阈值/溢出时 LLM 摘要写回当日文件（Tri-fold：threshold/overflow/daily_summary），从根上控制上下文增长。
3. **SKILL.md frontmatter + 三级渐进披露（Cline / OpenClaw / CowAgent）**：启动只载入 `name+description` 目录（预算裁剪：150 个 / 18k 字符），正文由 `skill` 工具按需读取；`description` 就是路由信号。
4. **技能=插件能力（OpenClaw / deepseek cordis）**：memory、skills、cron、tools 都注册为“能力”，统一在运行时 registry 里管理生命周期、授权、卸载 —— 比硬编码模块更易横向扩展。
5. **自研轻量调度器，croniter 校验（CowAgent / OpenClaw）**：后台线程轮询 + JSON/SQLite 任务存储 + `once/interval/cron` 三种类型 + IANA 时区 + 原子写；不引入 APScheduler 这类重依赖，任务格式和重试策略完全可控。
6. **`.cron.md` 文件即任务（Cline）**：任务定义用 frontmatter（schedule/mode/tools/timeout/model/tags）+ 正文 prompt，天然可版本化、可审计、可被 Agent 自己创建 —— 与技能文件体系对称。
7. **无人值守自批准 + 执行留痕 + 投递配置（Cline / OpenClaw）**：定时任务自动批准自身工具调用；每次运行写 run log/diagnostics；结果可投递到会话/webhook；失败靠下个周期重跑 + 通知，而非即时重试。
8. **模板注入上下文（Cline hooks / CowAgent prompt builder）**：上下文按节拼装（persona → tools → skills目录 → memory → 项目文件 AGENT.md/USER.md/MEMORY.md），并用 hooks 在工具执行前注入实时环境信息 —— 保持 system prompt 稳定可调。

## 附：可直接参考的关键文件（最短路径）

- CowAgent：`agent/memory/manager.py`、`agent/memory/summarizer.py`、`agent/skills/loader.py`、`agent/tools/scheduler/scheduler_tool.py`、`agent/tools/scheduler/task_store.py`、`agent/prompt/builder.py`
- OpenClaw：`src/skills/loading/frontmatter.ts`、`src/skills/loading/skill-prompt-limits.ts`、`src/plugins/memory-state.ts`、`src/agents/tools/cron-tool.ts`、`src/agents/tools/cron-tool-schema.ts`、`packages/plugin-sdk/src/plugin-entry.ts`
- deepseek-harness：`packages/schedule/schedule/src/domain.ts`、`packages/skill/skill/src/index.ts`、`packages/extensions/tool-cordis/src/index.ts`、`vendor/cordis/src/context.ts`
- Cline：`docs/customization/skills.mdx`、`docs/cli/scheduling.mdx`、`sdk/examples/cron/daily-code-review.cron.md`、`docs/best-practices/memory-bank.mdx`、`sdk/examples/hooks/PreToolUse_InjectContext.py`
- Roo-Code：`src/services/skills/SkillsManager.ts`、`src/core/tools/SkillTool.ts`、`src/core/task-persistence/TaskHistoryStore.ts`
