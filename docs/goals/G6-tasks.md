# G6-TASKS — 打包·安全·分发

> Goal：G6 · 状态：⏳ 待实现 · 上游：[G6-design](./G6-design.md)

## 0. 总览

| 任务 | 内容 | 出口 | 状态 |
|------|------|------|------|
| T6.0 | electron-builder 配置 + dmg/zip 产物 | `bun run dist` 出 dmg（unsigned 可标注） | ⬜ |
| T6.1 | 签名/公证 hook（有证书则跑，无则跳过） | Gatekeeper 通过（有证） | ⬜ |
| T6.2 | electron-updater + 版本检查 UI | 检测/下载/重启升级（本地 mock 更新源） | ⬜ |
| T6.3 | SecretStore 抽象 + Keychain 实现 + File 降级 | key 不落明文（Keychain 模式） | ⬜ |
| T6.4 | Provider keyRef 改造 + 密钥迁移 | config.json 无明文 key；export 脱敏不变 | ⬜ |
| T6.5 | schema_version + v3 迁移链（含 G1 jsonl） | 升级往返数据完整 | ⬜ |
| T6.6 | 日志轮转 + 崩溃兜底 | 日志文件生成 + 断点可查 | ⬜ |
| T6.7 | 审计导出（CSV/JSON）+ 设置页版本/渠道 | 导出可用 | ⬜ |
| T6.8 | 集成验收（F1–F8） | dmg 可装 + 升级迁移全绿 | ⬜ |

## 1. 顺序

```
T6.0 → T6.1（打包管线先行，可并行开发）
T6.3 → T6.4 → T6.5（安全 + 迁移，核心）
T6.2 → T6.6 → T6.7（更新/日志/导出）
T6.8（集成）
```

## 2. 关键验收口径

- T6.0：`bun run dist:mac`（无证书）产出 `dist-mac/Harness Bot-<v>-arm64.dmg` + 标注 unsigned；安装后能启动。
- T6.2：设置页点「检查更新」→ 命中 mock latest-mac.yml → 下载 → 重启后版本变化，数据保留。
- T6.3：`KeychainSecretStore.set/get/delete` 真机冒烟；`FileSecretStore` 0600 且单测过。
- T6.4：迁移后 `config.json` 无明文 key（有 keyRef）；`exportPayload({maskKeys:true})` 保持脱敏。
- T6.5：v2 样例数据树 → `migrateSchema` → v3；10k 消息已转 jsonl；schema.json version=3。
- T6.6：主进程/渲染器日志轮转（按日 + 10MB）；`uncaughtException` 记录后退出。
- T6.7：审计导出 CSV/JSON 字段完整；设置页显示 version/channel。
