# 调研：macOS 打包·签名·公证·自动更新·密钥安全（G6 落地调研）

> 调研日期：2026-10-28 · 目标项目：Harness Bot（Electron 33.4.11 + bun + 纯 TS，零原生依赖）
> 上游：[G6-spec](./goals/G6-spec.md) · [G6-design](./goals/G6-design.md) · 结论可直接指导 T6.0–T6.8
> 调研方式：官方文档抓取（electron.build / apple / electronjs）+ GitHub API 只读核对（版本、issue、修复状态），来源链接见文末。

---

## 0. TL;DR（核心结论）

| 主题 | 结论 | 对设计文档的修正 |
|---|---|---|
| 打包 | 用 **electron-builder 26.18.x**（稳定线）+ `target: [dmg, zip]` | — |
| bun 兼容 | electron-builder **≥26.8.2 已修复 bun 依赖收集**（#9443/#9804 已合并）；25.x 及更早会崩 | 必须锁 26.x，勿用 24/25 |
| 签名公证 | Developer ID + hardenedRuntime + notarytool；无证书时 `CSC_IDENTITY_AUTO_DISCOVERY=false` 出 unsigned | 删掉 obsolete 流程（已用 notarytool） |
| 密钥存储 | **弃 keytar（已归档 2022），改用 Electron 内置 `safeStorage`**（macOS 底层就是 Keychain，零原生依赖） | ⚠️ 修正 G6-design "keytar 或 security CLI" |
| 自动更新 | electron-updater 6.8.12；macOS 必须 zip target + **签名后才能更新**；Squirrel 重启即装 | 补：v28 起清单 Ed25519 强签名，v26 无此要求 |
| 日志 | electron-log 轮转默认 1MB/`.old.log`，按日需自定义 `resolvePathFn` | — |
| 审计/迁移 | 审计已有 `audit-log.ts`；补 CSV/JSON 导出即可；schema_version 方案成立 | — |

**落地版本建议**：`electron-builder@26.18.1` + `electron-updater@6.8.12`（同一发布批次，2026-10-26）。**不要**上 v27/v28 alpha/next（引入清单 Ed25519 强制签名，当前阶段徒增复杂度）。

---

## 1. 打包（F1/F2）— electron-builder

### 1.1 版本现状（GitHub Releases 核对，2026-10-26）

- 稳定线 npm 版本：`electron-builder@26.18.1`、`electron-updater@6.8.12`（同批次发布）。
- Git tag 对应 `v26.0.20`（npm 26.18.1）；master 已演进到 v29.30.0 / v28.0.0，包含 v27→v28 的一系列破坏性变更（见 §2.3 清单签名）。
- 项目当前无 electron-builder 依赖，需新增：`bun add -d electron-builder`。

### 1.2 mac 核心配置

```yaml
appId: com.harness.bot
productName: Harness Bot
mac:
  category: public.app-category.productivity
  target: [dmg, zip]          # zip 必选：无 zip 无法生成 latest-mac.yml（Squirrel.Mac 需要）
  hardenedRuntime: true       # 公证必需
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  identity: "Developer ID Application: Your Name (TEAMID)"   # 省略则钥匙串自动发现
dmg:
  sign: false                 # dmg 本身可不签（app 已签）
```

- 架构：`--arm64` 原生 / `--x64` / `--universal`（合并双架构）。建议 v1 先 arm64 + x64 双 dmg，universal 可选。
- **无证书构建**：设 `CSC_IDENTITY_AUTO_DISCOVERY=false` + 无 `CSC_LINK` → 产出 ad-hoc 未签名 dmg。项目仓库可标注 unsigned，本机右键打开可安装。
- **防"静默未签名"**：electron-builder 默认无证书就跳过签名继续构建（"silently unsigned"）。G6 验收要求"未签名要标记"→ 建议发布 CI 里加 `forceCodeSigning: true` 并配合 `updateManifest`/`mac.notarize` 显式判定；开发 build 走一遍 `codesign --verify` 自查。

### 1.3 bun 兼容性（⚠️ 本项目最大风险，已解决的坑）

GitHub issue 核对：

- **#9434**（2025-12）"Not compatible with Bun"：bun 1.3.3 + electron-builder 26.3.5 → `bun does not support any CLI for dependency tree extraction`，依赖收集崩溃。
- **#9641**（2026-03）"Bun node-modules traversal ignores overridden dependency resolution"：bun + `overrides` 时打包失败（production dependency not found）。
- **修复状态**：
  - **#9443** 合并 2025-12-14：`fix: allow npm list to work on yarn berry and bun project setups`（进入 26.8.x）。
  - **#9804** 合并 2026-05-31：`fix(traversal): accept transitive dependencies resolved outside their declared range by overrides`（进入 26.8.2 之后稳定线）。

**结论**：**electron-builder ≥26.8.2 才可靠支持 bun**；本项目直接上 26.18.1（2026-10 发布）无此问题。若安装后遇依赖遍历报错，检查是否被锁到了旧版本；仍需 node_modules 遍历兜底时可用 `npm install` 作为 second-order workaround（不改变 bun 日常开发）。

---

## 2. 签名与公证（F1/F2）

### 2.1 证书

- macOS Gatekeeper 只认 Apple 颁发的证书。直接分发（dmg/zip/pkg 外分发）需要 **Developer ID Application** 证书。
- 前提：**Apple Developer Program 会员**（$99/年，按人民币约 ¥688/年；个人与公司均可申请，公司需邓白氏编号）。证书本身在会员内免费签发。
- 备查：证书还分 Developer ID Installer（pkg）、Apple Distribution / Mac App Distribution（MAS）。本项目走 dmg+zip 分发 → 只需 Developer ID Application。

### 2.2 公证（当前推荐流程 = notarytool，altool 已废弃）

```bash
# 1. 签名（必须先签、必须 --options runtime 即 hardenedRuntime、必须 --timestamp）
codesign --force --options runtime --timestamp \
  --sign "Developer ID Application: Your Name (TEAMID)" YourApp.app

# 2. 打包 zip 提交公证（notarytool；凭据用 App Store Connect API Key 或 Apple ID）
xcrun notarytool submit YourApp.zip \
  --key-path ~/.config/notarytool/AuthKey.p8 --key-id KEY_ID --issuer-id ISSUER_ID --wait

# 3. 装订票据（让离线也过 Gatekeeper）
xcrun stapler staple YourApp.app

# 4. 验证
codesign --verify --deep --strict --verbose=2 YourApp.app
spctl --assess --type execute --verbose=4 YourApp.app   # → accepted source=Notarized Developer ID
xcrun stapler validate YourApp.app
```

**electron-builder / GitHub Actions 集成**：

```yaml
- name: Build and sign
  run: npx electron-builder --mac
  env:
    CSC_LINK: ${{ secrets.CSC_LINK }}                  # base64(p12) 或路径
    CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}
    APPLE_ID: ${{ secrets.APPLE_ID }}
    APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
    APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
```

- electron-builder 26 内置公证：配置 `mac.notarize`（`{ teamId, appleId, appleIdPassword }`），或保留 `afterSign` hook 用 `@electron/notarize`。
- 注意：**p12 上 CI 用 base64**（mac 用 `base64 -i`，Linux 用 `base64 -w0`），CI secret 单行。
- 任何改动（版本/二进制）后必须重签 + 重公证 + 重装订。

---

## 3. 自动更新（F3/F8）— electron-updater

### 3.1 机制与硬性前提

- macOS 更新走 **Squirrel.Mac**：需要 `zip` target 才能生成 `latest-mac.yml`；dmg 供安装，zip 供更新。
- **macOS 应用必须已签名才能自动更新**（electron-builder 文档明确：macOS application must be signed）。→ 意味着 unsigned 阶段自动更新不可用，G6 验收 T6.2 的"本地 mock 更新源"仍可用（dev-app-update.yml + forceDevUpdateConfig）。
- 安装时机：macOS 是 Squirrel 原生 staging，**应用重启后自动应用，无需 quitAndInstall**（Windows/Linux 才有 autoInstallEvent；v28 引入 `onNextLaunch`，macOS 行为不变）。

### 3.2 接入要点

```ts
import electronUpdater, { type AppUpdater } from "electron-updater";
// ESM 兼容 workaround（见 electron-builder#7976）：不能直接 import { autoUpdater }
const { autoUpdater } = electronUpdater;
autoUpdater.logger = log;                 // 接 electron-log
autoUpdater.checkForUpdatesAndNotify();   // 不要手动 setFeedURL：app-update.yml 由构建自动生成
```

- 事件：`checking-for-update` / `update-available` / `update-not-available` / `download-progress` / `update-downloaded` / `error`。
- 元数据：v26 默认 `files[]` 格式（`url`/`sha512`/`size`）；顶层 `path`/`sha512` 属旧格式（electronUpdaterCompatibility <2.16 才输出）。
- 灰度：手动编辑 `latest-mac.yml` 加 `stagingPercentage: 10`；撤回灰度的坏版本要"升版本号再发"。
- 调试：根目录放 `dev-app-update.yml` + `autoUpdater.forceDevUpdateConfig = true`；本地 mock 可用 Minio 或静态服务器。

### 3.3 发布配置（publish provider）

```yaml
publish:
  - provider: github
    owner: zhoujinyu
    repo: harness-bot
    releaseType: draft        # 默认 draft；GH_TOKEN/GITHUB_TOKEN 存在时自动建 release 并上传
# 或自托管：
publish:
  - provider: generic
    url: https://updates.example.com/harness-bot
# generic 不会自动上传，需自行上传 dmg/zip/latest-mac.yml（G6 已选此路线则记得这一步）
```

- 列表第一项为默认更新 feed（写入 `resources/app-update.yml`）。多 provider 上传时 `dmg.publish`/`zip.publish` 首项必须一致，否则构建报 InvalidConfigurationError。
- GitHub 私有仓库：客户端设 `GH_TOKEN` + `private: true`（仅特殊场景）。

### 3.4 v28 重大变化（现阶段规避，未来升级注意）

- electron-builder **master/v28 起强制 `latest*.yml` 清单签名**：用 Ed25519 私钥（`electron-builder create-update-key` 生成 → `ELECTRON_BUILDER_UPDATE_SIGN_KEY` base64 env）对清单签名，客户端构建时嵌入公钥验签后再下载；无密钥发布构建直接失败。
- 影响：一旦某版本内嵌公钥，未签名清单即被拒（fail-closed，`ERR_UPDATER_MANIFEST_NOT_SIGNED`），想关掉只能显式 `updateManifest: false`。密钥可多把轮换。
- **v26 没有此强制**，因此当前用 v26 可先跑通更新链路，v28 升级时再补密钥体系（建议届时把密钥生成纳入 CI pipeline）。

---

## 4. 密钥存储（F4）— ⚠️ 修正 G6-design

### 4.1 keytar 已废弃（勿用）

- GitHub `atom/node-keytar`：**2022-12-15 由 owner 归档，只读**，进入 Public archive。无迁移指引维护中。npm 上标记 deprecated。
- G6-design 原写"keytar 或 security CLI"→ **keytar 路线应删除**。

### 4.2 推荐：Electron 内置 `safeStorage`（零原生依赖，macOS 即 Keychain）

- macOS 上 safeStorage 的加密密钥就存在**系统钥匙串（Keychain）**，天然满足 F4"key 不落明文文件"，且**无需新增原生依赖**（对齐项目零重依赖原则）。
- API 现状（Electron 33 可用，同步 API 将在 Electron 46 移除）：
  - 推荐异步：`encryptStringAsync(plain)` / `decryptStringAsync(enc)`（解密返回 `{ result, shouldReEncrypt }`）。
  - 可用性检测：`isAsyncEncryptionAvailable()`（异步）。
  - 旧同步 `encryptString`/`decryptString`/`isEncryptionAvailable` 已弃用。
- **macOS 签名要求**：未正确代码签名的 build 会被系统视为不同应用，导致 keychain 授权每次重新弹出 → 与 §2 签名强相关。
- **规避 Linux 回退**：Linux 无 secret store 时 safeStorage 退化为 `basic_text`（硬编码口令加密，等于明文）。本项目 macOS 为主，可接受；如未来跨平台要在 Linux 上显式警告"insecure 模式"。
- 建议的 `SecretStore` 实现顺序：**safeStorage 为主**（持久化到 providers.json 的密文 Buffer），FileSecretStore（0600）降级仅开发态，显式 `insecure` 标记。

### 4.3 keyRef 改造（维持 G6-design）

- `Provider.apiKey` 改为 `keyRef?: "keychain:<providerId>"`，ProviderCenter 启动时经 SecretStore 解析为内存值；`exportPayload({maskKeys:true})` 脱敏行为不变。
- 迁移：`config.json` 中已有 apiKey → 首次启动加密写入 SafeStore → 原字段置空 + 写 keyRef。

---

## 5. 日志（F6）— electron-log

- **electron-log** 4.x 能力核对（macOS 默认路径：`~/Library/Logs/{app}/main.log`）：
  - 主进程：`import log from 'electron-log/main'; log.initialize();`
  - 渲染进程：`import log from 'electron-log/renderer'`（模板化渲染进程需手动转发；`utilityProcess` 日志不自动转发）。
  - 级别：error → silly；文件格式 `[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}`。
  - 与 updater 集成：`autoUpdater.logger = log`。
- **轮转**：文件传输 `maxSize` 默认 1MB，超限重命名为 `main.old.log`（`archiveLogFn` 可覆盖自定义，默认单文件历史）。`maxFiles`/按日轮转**文档未提供** → G6 要求"按日+10MB"需自定义 `resolvePathFn`（按日分文件）或 `archiveLogFn`。
- G6 需实现：`uncaughtException` → `log.errorHandler.startCatching()` 后记录退出。

---

## 6. 审计导出（F7）与数据迁移（F5/F6）

- 项目已有 `core/audit-log.ts`：按天 JSONL append-only，`query()` / `exportAll()` 齐备 → F7 只需补 CSV/JSON 序列化（一行 `exportAll()` + `arrayToCsv` 工具函数）。
- `~/.harness-bot/schema.json`（`version`）+ 启动迁移链方案成立；G1 已实现 messages.json→sessions/<sid>.jsonl 迁移，v2→v3 迁移链按 [G6-design §2 core/schema.ts](./goals/G6-design.md) 落地即可，注意先用 `schema.json.bak` 备份、失败回滚（对齐 G6-design §5 风险）。
- 验收口径参考：v2 样例数据树 → migrateSchema → schema.json version=3；10k 消息转 jsonl；config.json 无明文 key。

---

## 7. 落地建议清单（修正后的 G6 实施顺序）

1. **安装**：`bun add -d electron-builder`（确认解析到 **26.18.1**；勿被旧 lock 锁到 <26.8.2）。
2. **打包管线**：electron-builder.yml 按 §1.2；先出 unsigned dmg/zip 走通 `bun run dist:mac`（T6.0）。
3. **密钥存储**：改设计为 safeStorage（§4.2），实现 `core/secret-store.ts` + File 降级；Alike G6 任务的 FileSecretStore 单测不变（T6.3/T6.4）。
4. **自动更新**：electron-updater + publish（github 或 generic），dev-app-update.yml 本地 mock 验证（T6.2）。记住 macOS 需签名，unsigned 阶段仅能 mock。
5. **CI 签名/公证**：有 Developer ID + p12 时配置 CSC_* / APPLE_*，`notarytool` 公证 + stapler；无证书走 `CSC_IDENTITY_AUTO_DISCOVERY=false` unsigned（T6.1）。
6. **迁移/日志/审计**：schema v3 迁移链（T6.5）、electron-log 自定义按日轮转（T6.6）、审计 CSV/JSON 导出 + 设置页版本/渠道（T6.7）。
7. **集成验收**：F1–F8（T6.8）。

---

## 8. 风险清单

| 风险 | 等级 | 对策 |
|---|---|---|
| electron-builder 被锁到 <26.8.2 遇 bun 崩溃 | 高 | Lock 26.18.1；验证 `bun run dist` 依赖收集正常 |
| 无 Apple Developer 证书 → 无法 Gatekeeper 通过/自动更新不可用 | 高 | 明确 unsigned 标注；文档说明"需证书才能分发"；auto-update 仅 mock |
| 误用已归档 keytar 引入原生编译依赖 | 高 | 改用 safeStorage（已修正设计） |
| 未来升 v28 强制清单签名，无密钥则发布失败 | 中 | 现 v26 先跑通；升级时提前建 Ed25519 密钥并双签轮换 |
| dmg/zip publish 首 provider 不一致导致构建失败 | 低 | publish 只在 `mac.publish` 配一次（G6-design 已对） |
| Linux 上 safeStorage 退化明文 | 低 | 本项目 macOS 为主；未来跨平台加 insecure 警告 |

---

## 9. 资料来源

**官方文档（electron.build / Electron / Apple）**
- electron-builder 通用打包：https://www.electron.build/mac
- Auto Update（含 v26/v28 差异）：https://electron.build/docs/features/auto-update
- Publish（github/generic/s3/r2/keygen）：https://electron.build/docs/features/publish
- Code Signing（CSC_* env、GHA 配置）：https://electron.build/docs/features/code-signing
- Signed Update Manifests（v28 Ed25519 清单签名）：https://electron.build/docs/features/signed-update-manifests
- Electron safeStorage API：https://www.electronjs.org/docs/latest/api/safe-storage
- Apple 公证 macOS 软件（notarytool）：https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution

**GitHub（gh api 只读核对）**
- electron-builder releases（electron-builder@26.18.1 / electron-updater@6.8.12，2026-10-26）：https://github.com/electron-userland/electron-builder/releases
- bun 兼容问题：#9434、#9641、#9500；修复 PR #9443（2025-12-14）、#9804（2026-05-31）
- 清单签名源码（master 分支）：`packages/app-builder-lib/src/publish/updateInfoBuilder.ts`
- keytar 归档状态：https://github.com/atom/node-keytar
- electron-log（路径/级别/轮转）：https://github.com/megahertz/electron-log · file transport: `docs/transports/file.md`