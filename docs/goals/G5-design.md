# G5-DESIGN — 系统深度接入

> Goal：G5 · 状态：⏳ 待实现 · 上游：[G5-spec](./G5-spec.md) · 下游：[G5-tasks](./G5-tasks.md)

## 1. 方案

| 维度 | 方案 | 理由 |
|------|------|------|
| 授权模型 | **Capability + Consent（组级）**：`grant(botId, cap, {ttl?, once?})`；未授权 → 挂起并弹窗 | 对齐 macOS TCC 心智；默认 deny |
| 弹窗 | 主进程 `dialog.showMessageBox`（bot 名/能力/参数/仅一次/长期）+ IPC 回调 | 简单、原生、无新 UI 依赖 |
| AppleScript | `osascript` spawn（白名单脚本模板：openApp/activeApp/keystroke/click/screenshot） | 系统级能力，macOS 内建 |
| 截图 | `screencapture -x -R<x,y,w,h> <path>`（授权组 screen） | 零依赖，回 path → image 块 |
| bash | `ToolExecutor` 白名单升级为**分组命令**：dev(git/docker…)/read(cat/ls…)/net(curl/ping…)/io(cp/mv…) | 按组而非单命令授权 |
| 审计 | `core/audit-log.ts`：append-only JSONL `audit/<date>.jsonl` | 可轮转、可导出 |
| 撤销 | 面板「系统授权」页：撤销/过期/查看全部 grant | 与审计同页 |

## 2. 数据模型

```ts
type Cap = "notify"|"clipboard"|"fs"|"bash:dev"|"bash:read"|"bash:net"|"gui"|"screen"|"apple";

interface Grant { botId; cap: Cap; once?: boolean; expiresAt?: number; grantedAt; note? }
interface AuditEvent { at; botId; cap; action; args; granted: boolean; ok: boolean; latencyMs; detail? }

class ConsentCenter {
  request(botId, cap, ctx): Promise<{granted:boolean}>   // 有 grant → true；once 消耗；无 → 弹窗
  grant(botId, cap, opts); revoke(botId, cap?); list(botId?); expire()
}

class SystemAccess extends SystemKit {
  apple(action: "openApp"|"activate"|"type"|"click"|"hotkey", args, botId, consent)
  screenshot(rect, botId, consent): Promise<{path, dataUrl}>   // image 块注入
  runBash(cmd, group, botId, consent)
}
```

## 3. 执行流（bot 调用系统能力）

```
ToolExecutor.run("apple.openApp", {...})
 → SystemAccess.apple(..., botId)
 → ConsentCenter.request(botId, "apple", desc)
     ├─ 未授权 → main 弹窗（异步等用户）→ 记录 grant
     └─ 已授权 → 执行 osascript（白名单模板校验）
 → AuditLog.append(...)
 → 结果回 tool 循环
```

- 弹窗是主进程阻塞式（`dialog` 同步），工具循环 await 用户决定，天然串行安全。
- **危险命令二次确认**：`rm -rf`/`diskutil erase`/`sudo` 强制 `requiresStrongConsent: true` → 弹窗文案红色 + 需输入 `confirm`。
- 白名单模板校验：osascript 只允许预置模板 + 参数插值（参数转义），禁止任意脚本拼接。

## 4. GUI 自动化前置

- 首次请求 `gui/screen` 时检测辅助功能权限：`AXIsProcessTrusted`（经 osascript 探测），未授权 → 引导打开 System Settings（`open "x-apple.systempreferences:..."`）。
- 截图权限同理（Screen Recording TCC）。

## 5. 面板

- 「系统授权」页：bot × cap 矩阵（granted/ttl/撤销）；审计日志列表（时间/能力/结果）+ 过滤 + 导出。
- Bot 详情页显示「已授权能力」徽章。

## 6. 风险

- TCC/隐私弹窗无法代码绕过 → 提供引导 + 检测状态回显。
- osascript 注入风险 → 模板化 + 参数转义 + 危险词拦截。
- 授权遗漏（bot 请求频率高）→ 每 bot 每能力默认 5min 冷却提示「再次申请」。

## 7. 改动文件

- `core/consent-center.ts`、`core/system-access.ts`、`core/audit-log.ts`（新）
- `core/system-kit.ts`（能力分组）、`core/tool-executor.ts`（bash 分组 + 强确认）
- `core/bot-runtime.ts`（工具调用挂起授权）
- `app/main.ts`（dialog + osascript + screencapture）、`preload.ts`、`renderer.js`（授权页/审计页）
- `tests/`（consent/audit/白名单分组/osascript mock/强确认）
