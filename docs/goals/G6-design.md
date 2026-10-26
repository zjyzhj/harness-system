# G6-DESIGN — 打包·安全·分发

> Goal：G6 · 状态：⏳ 待实现 · 上游：[G6-spec](./G6-spec.md) · 下游：[G6-tasks](./G6-tasks.md)

## 1. 方案

| 维度 | 方案 | 理由 |
|------|------|------|
| 打包 | **electron-builder**（dmg + zip，arm64+x64） | 生态成熟、配置化、支持 afterSign 公证 |
| 签名/公证 | `notarize`（Apple ID + Developer ID） | Gatekeeper 兼容；无证书时 `CSC_IDENTITY_AUTO_DISCOVERY=false` 出 unsigned |
| 自动更新 | **electron-updater** + 自托管 latest-mac.yml（GitHub Releases 或静态服务器） | 轻量、与 electron-builder 配套 |
| Keychain | **keytar** 或 `security` CLI 封装（`security add-generic-password`） | 零重依赖走系统钥匙串；无法用 keytar 时用 security 子进程 |
| 数据版本 | `~/.harness-bot/schema.json`（`version`）+ 启动迁移链 | 升级可感知结构变化 |
| 日志 | `~/Library/Logs/harness-bot/*.log` 轮转（主进程 + 渲染器 console 转发） | 断点排查 |
| 审计导出 | `core/audit-log.ts` 已存 jsonl → 面板一键 CSV/JSON | F7 |

## 2. 模块

```ts
// core/secret-store.ts（新，可测接口 + security CLI 实现）
interface SecretStore { get(p): string|null; set(p, v): void; delete(p): void; health(): boolean }
class KeychainSecretStore implements SecretStore   // security add-generic-password -a <acc> -s <svc> -w
class FileSecretStore implements SecretStore        // 降级（显式开关，0600，仅开发）

// core/schema.ts（新）
const SCHEMA_VERSION = 3;
migrateSchema(home): Promise<{ from, to }>          // v2→v3：messages.json→jsonl、key 迁移到 Keychain、结构校验

// app/main.ts
- initSecretStore()：优先 Keychain，失败提示并用 FileSecretStore（标记 insecure）
- 启动迁移：migrateSchema → 再初始化 Store 各集合
- updater：checkForUpdatesAndNotify()（stable/beta 由 config 渠道切换）
```

## 3. Provider 密钥改造

- `Provider.apiKey` 存 id 引用：`Provider.keyRef?: "keychain:<providerId>"`；ProviderCenter 启动时经 SecretStore 解析为内存值。
- 迁移：`config.json` 中已存在的 apiKey → 写入 Keychain → 原字段置空 + keyRef；`exportPayload` 脱敏不变（maskKeys）。
- 测试用 `FileSecretStore`（临时目录）验证逻辑；`KeychainSecretStore` 仅真机冒烟。

## 4. 打包配置（electron-builder.yml）

```yaml
appId: com.harness.bot
productName: Harness Bot
files: [dist/**, assets/**]
mac: { category: public.app-category.productivity, target: [dmg, zip], hardenedRuntime: true, entitlements: build/entitlements.mac.plist }
dmg: { sign: false }
publish: [ { provider: github, owner: zhoujinyu, repo: harness-bot } ]   # 或 static
```

- 脚手架：`scripts/notarize.cjs`（afterSign hook）；`bun run dist:mac`（arm64/x64/universal 可选）。
- UI：设置页显示版本 + 渠道 + 检查更新按钮；主进程 `app.getVersion()`。

## 5. 风险

- 无开发者证书 → 只能出 unsigned dmg（本机自签可装）；文档说明。
- keytar 原生模块编译 → 选用 `security` CLI 优先，避免原生依赖（对齐零重依赖原则）。
- 自动更新覆盖迁移：更新前先备份数据目录（`schema.json.bak`），失败回滚。

## 6. 改动文件

- `core/secret-store.ts`、`core/schema.ts`（新）
- `core/provider-center.ts`（keyRef 解析）、`core/store.ts`（schema_version）
- `app/main.ts`（secret/updater/日志）、`settings` UI
- `electron-builder.yml`、`scripts/notarize.cjs`、`scripts/dist.ts`
- `tests/`（secret-store(File)/schema 迁移/keyRef 解析/导出脱敏）
