# G6-TASKS — 打包·安全·分发

> Goal：G6 · 状态：🟡 进行中（2026-11） · 上游：[G6-design](./G6-design.md)

## 0. 总览

| 任务 | 内容 | 出口 | 状态 |
|------|------|------|------|
| T6.0 | electron-builder 配置 + dmg/zip 产物 | `bun run dist` / `dist:mac` 出 dmg | ✅ 已有（arm64） |
| T6.1 | 签名/公证 hook（有证书则跑，无则跳过） | `scripts/notarize.cjs` afterSign；无证跳过 | 🟡 hook 已接，公证待凭证 |
| T6.2 | electron-updater + 版本检查 UI | 关于页「检查更新」；未配发布源时明确提示 | 🟡 UI/IPC 已接，下载未接 |
| T6.3 | SecretStore + safeStorage 加密 | key 不落明文（enc: / Keychain） | ✅ 现用 safeStorage |
| T6.4 | Provider key 加密落盘 + 导出脱敏 | config 加密字段；export maskKeys | ✅ |
| T6.5 | schema_version（`schema.json`） | 启动 `ensureSchema` → v3 | 🟡 版本文件已有；结构迁移链待扩 |
| T6.6 | 日志轮转 + 崩溃兜底 | FileLogger 按日/10MB；uncaught 写日志 | ✅ |
| T6.7 | 审计导出 + 关于页版本/渠道 | 设置页导出；关于页显示 version/channel/schema | ✅ |
| T6.8 | 集成验收（F1–F8） | dmg 可装 + 升级全绿 | ⬜ |

## 1. 顺序（剩余）

```
T6.1 公证（Developer ID + 凭证）→ T6.2 electron-updater 真源
T6.5 结构迁移补全（若有破坏性变更）→ T6.8
```

## 2. 关键验收口径

- T6.0：`bun run dist:mac` 产出 `release/` 下 dmg；无证可标 unsigned。
- T6.2：关于页点「检查更新」→ 未配源时有明确文案；配好 latest-mac.yml 后可下载重启。
- T6.5：`~/.harness-bot/schema.json` 含 `version: 3`。
- T6.6：`logs/main-YYYY-MM-DD.log` 生成；未捕获异常写入同一日志。
- T6.7：审计导出 CSV/JSON；关于页显示真实 `app.getVersion()`。
