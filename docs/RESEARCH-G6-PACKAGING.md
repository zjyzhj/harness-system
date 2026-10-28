# 调研:macOS 打包 · 签名公证 · 自动更新 · 密钥安全(Electron)

> 目标读者:Harness Bot G6(打包·安全·分发)实现者
> 调研对象:electron-builder / electron-updater / Electron safeStorage / @electron/notarize / electron-log
> 版本快照:2026-10-28,数据来自 npm registry、electron-builder 官方文档与源码(`gh api` 只读拉取)
> 结论依据:真实配置键、环境变量、源码字段与验收命令,路径可直接去官方文档核对。

---

## 1. 结论速览(先看这个)

| # | 结论 | 数据支撑 |
|---|------|----------|
| 1 | **版本锁 electron-builder 26.x stable + electron-updater 6.x**,不追 v27(仅 alpha) | npm `latest=26.18.0`、`next=27.0.0-alpha.13`;updater `latest=6.8.11`、`next=7.0.0-alpha.12` |
| 2 | G6-design 的扁平签名配置(`identity/hardenedRuntime/entitlements`)与 **v26 语法完全一致**;v27 才改 `mac.sign.*` 嵌套 | v26 `macOptions.ts` 字段为扁平;v26→v27 迁移文档 |
| 3 | 公证用 **env 凭证触发**(`mac.notarize: true` + `APPLE_API_KEY` 三件套),`afterSign hook` 不是必需 | v26 macOptions `notarize` 注释 |
| 4 | **密钥存储改用 Electron `safeStorage`**,放弃 keytar / security CLI | `atom/node-keytar` `archived=true`,pushes 止于 2022-12,77 个 open issues;7000 行依据见 §6 |
| 5 | 自动更新「检查更新」跨版本,**无证书时无法真升**(macOS 强制签名),mock 只能验证到下载阶段 | electron-build 自动更新文档「Code signing is required on macOS」 |
| 6 | v26 的自动更新清单(`latest-mac.yml`)**只做 sha512 校验,无 Ed25519 签名**(签名清单是 v27 新特性) | updater 6.8.11 不含 updateManifest 字段;v27 迁移文档 |
| 7 | dmg 默认 target 必带 `zip`(Squirrel.Mac 自动更新必需),不要只配 dmg | mac 文档「default targets are zip and dmg」 |
| 8 | 日志用 `electron-log` 5.x(maxSize 字节轮转 + `.old` 存档 + 渲染器转发),自研轮转无必要 | electron-log file transport 文档 |

---

## 2. 版本矩阵与选型

### 2.1 npm 实况(2026-10-28)

| 包 | latest | 说明 |
|----|--------|------|
| electron-builder | **26.18.0**(2026-10-20) | 生产可用;v27 全部是 alpha,git tag 有 v28/v29 但 npm 未发 stable |
| electron-updater | **6.8.11** | 与 builder 26.x 配套;7.0 仅 alpha |
| electron (项目依赖) | ^33.0.0(最新 45.1.0) | Electron 33(2024-10)已偏老,EOL;建议 G6 期间评估升级 |
| electron-log | 5.4.4 | 日志轮转/渲染器转发 |
| keytar | 7.9.0(2025-07 modified) | 上游仓库已归档,不推荐新增依赖 |

### 2.2 选型建议

```bash
bun add -D electron-builder@^26
bun add electron-updater@^6 electron-log@^5
```

**不要**用 `electron-builder@latest`(会进 v27 alpha)。若未来要 v27 的「强制签名、签名更新清单、mac.sign 嵌套」,另开分支用 `bunx electron-builder migrate-schema` 迁移配置,无需现在冒险。

---

## 3. 打包(electron-builder,对应 T6.0)

### 3.1 配置(electron-builder.yml,对齐 G6-design + v26 语法)

```yaml
appId: com.harness.bot
productName: Harness Bot
directories:
  output: dist-mac
files:
  - dist/**
  - assets/**
  - package.json
asar: true
mac:
  category: public.app-category.productivity
  target:
    - dmg
    - zip            # 必须:latest-mac.yml 依赖 zip,Squirrel.Mac 自动更新必需
  hardenedRuntime: true
  entitlements: build/entitlements.mac.plist   # 可选,见 §4.3
dmg:
  sign: false         # 默认即 false;只签 DMG 容器不签 app
  window:             # 540×380,Finder 窗口
    width: 540
    height: 380
  background: build/background.png             # 需要时配 @2x
  contents:
    - x: 130; y: 220; type: file
    - x: 410; y: 220; type: link
publish:
  - provider: generic            # 或 github;generic 需手动传包见 §5
    url: https://updates.example.com/harness-bot
```

要点(带出处):
- **appId 反域名格式,发布后不可改**——改变会破坏 NSUserDefaults/数据路径(mac 文档)。
- **`productName: Harness Bot` 含空格**——v26 允许;v27 起拒绝需 sanitize 的名字(但「Harness Bot」无需 sanitize,仍可用)。
- arm64 默认即可;如需 x64/universal:`--x64` / `--universal`(mac 文档 architecture 表)。
- 辅助 Helper 的 bundle id 由 appId 自动派生,无需配置。

### 3.2 脚本(对齐 T6.0 验收)

```jsonc
{
  "scripts": {
    "dist:mac": "electron-builder --mac --arm64 -c.mac.sign.identity=null",
    "dist:mac:unsigned": "CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --mac --arm64"
  }
}
```

- 无证书时产出 `dist-mac/Harness Bot-0.1.0-arm64.dmg` + `-mac.zip`,打包产物在 **dist-mac/**(G6-design 用 dist-mac,别和构建输出 dist/ 混淆)。
- `CSC_IDENTITY_AUTO_DISCOVERY=false` 或 `sign.identity=null` 跳过签名,产出 unsigned dmg(本地可装,首次启动需 System Settings 放行)。

---

## 4. 签名与公证(对应 T6.1)

### 4.1 v26 机制

`mac.notarize` 是 **boolean**。electron-builder 检测到签名证书 + 公证凭证后**自动签名并公证**,无需自定义 `afterSign`(v26 内置 @electron/notarize 集成)。

```
签名:需要 Developer ID Application 证书
  - 本机:自动在钥匙串找有效身份
  - CI:CSC_LINK=<p12路径> + CSC_KEY_PASSWORD
公证:满足凭证则触发;否则警告并跳过
强制:mac.notarize: true 时无凭证直接构建失败(可选)
```

### 4.2 公证凭证(三选一,v26 源码注释)

| 方式 | 环境变量 | 适用 |
|------|----------|------|
| **API Key(推荐 CI)** | `APPLE_API_KEY`(.p8 路径或 base64)+ `APPLE_API_KEY_ID` + `APPLE_API_ISSUER` | 不过期、免 2FA;electron-builder 写入临时 0600 文件 |
| Apple ID | `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` | 本地/一次性 |
| Keychain profile | `APPLE_KEYCHAIN` + `APPLE_KEYCHAIN_PROFILE` + `APPLE_TEAM_ID` | 仅本机开发 |

> 官方建议用 API Key(安全性更佳,文档引 #7859)。注意 `.p8` 只可下载一次,存 CI secret。

### 4.3 entitlements(最小化)

- **现代 Electron 只需 `com.apple.security.cs.allow-jit`**,electron-builder 默认授予——**裸 Electron 不写 entitlements 文件即可公证**。
- 除非你的 bot 要加载外部签名/未签名原生库,才需要 `disable-library-validation`。
- **不要**默认加 `allow-unsigned-executable-memory`(2019 老 Electron 才需要,且削弱 Hardened Runtime)。
- 若自建 `build/entitlements.mac.plist`,它会**替换**默认(不是合并),务必保留 `allow-jit`(notarization/mac 文档)。

### 4.4 验收命令(发布前必跑)

```bash
spctl --assess --verbose --type exec "dist-mac/Harness Bot.app"   # accepted / Notarized
xcrun stapler validate "dist-mac/Harness Bot.app"                # validate action worked
codesign --verify --deep --strict --verbose=2 "dist-mac/Harness Bot.app"
```

### 4.5 无证书流程(验收口径)

- `bun run dist:mac` 无需证书,产出 unsigned dmg + 标记文档说明;
- 有证书 + 凭证时走签名→公证→stapler,自动完成。

---

## 5. 自动更新(对应 T6.2)

### 5.1 接入方式

`electron-updater` 2 行:

```ts
import { autoUpdater } from 'electron-updater'
autoUpdater.logger = log
autoUpdater.checkForUpdatesAndNotify()
```

- ⚠️ **不能在打包后的 `dist/main.cjs` 里 autoUpdater 与 Electron 内置 autoUpdater 混用**——用 electron-updater 的,别 `require('electron').autoUpdater`。
- `setFeedURL` 不要手动调用;electron-builder 打包时自动生成 `app-update.yml`,feed 由 `publish` 配置决定。

### 5.2 Provider(generic 优先)

| Provider | 上传 | 说明 |
|----------|------|------|
| `github` | 自动(需 GH_TOKEN) | 公开仓库最佳;私有需客户端 GH_TOKEN,不推荐 |
| **`generic`**(推荐自托管) | 手动 | 任意静态服务器;协议简单,`latest-mac.yml` 需手动放上去 |
| `s3` / `spaces` / `r2` | 自动 | 需要对应云凭证 |

```yaml
publish:
  - provider: generic
    url: https://updates.example.com/harness-bot   # 目录里必须有 latest-mac.yml + dmg/zip
```

### 5.3 元数据文件

构建后产出:
- `latest-mac.yml`(含 `files[]` + `sha512`;electron-updater ≥2.16 用 files 格式)
- `name-<ver>-mac.zip` + `.blockmap`(差分更新的基础)
- `.dmg`

### 5.4 本地 mock 测试(T6.2 验收)

```bash
# 1. 项目根放 dev-app-update.yml(generic,指向本地静态目录)
# 2. 起静态服务器
python3 -m http.server 8080 -d /tmp/update-stage
# 3. 代码里强制 dev 模式
autoUpdater.forceDevUpdateConfig = true
```

可验证到 `update-available` → `download-progress` → `update-downloaded`;**真正重启升级需签名版 dmg**(macOS 强制签名)。无证书时该环节标记为「已下载待签名升」。

- electron-updater 事件:`checking-for-update / update-available / update-not-available / download-progress / update-downloaded / error`。
- 灰度:`stagingPercentage: 10`(手动改 latest-mac.yml),事故召回需**升版本号**不可原地覆盖。
- 更接近生产:Minio(官方推荐本地更新服务器)。

### 5.5 stable/beta 渠道

- electron-updater **无原生 channel 概念**。做法:两个 generic 目录(`/stable`、`/beta`),app 侧按设置渠道改 feed(直接 `new MacUpdater({provider:'generic', url})`),或用两个不同版本号发布流,beta 版本号更高且 staging 收窄。

### 5.6 安全格线(v26)

- 下载物按清单 `sha512` 校验;清单本身仅受 HTTPS + 存储方保护(v27 才加 Ed25519 签名清单)。**自托管请务必上 HTTPS 且把静态目录访问权限收紧**。
- 升级迁移先行备份:`schema.json.bak` + 数据目录(对齐 G6-design 风险节)。

---

## 6. 密钥存储(对应 T6.3/T6.4,重点修订)

### 6.1 方案对比与选型

| 方案 | macOS 后端 | 依赖 | 结论 |
|------|-----------|------|------|
| **`electron.safeStorage`(推荐)** | **Keychain Access**,key 存钥匙串、密文可落文件 | 内置,零依赖 | ✅ 首选 |
| keytar | Keychain | 原生模块(需 rebuild) | ❌ 上游已归档 |
| `security` CLI 子进程 | Keychain(`add-generic-password`) | 无 | ⚠️ 可用但慢、参数解析风险、跨版本脆弱 |

**数据支撑(为何弃 keytar)**:
- `atom/node-keytar` GitHub:`archived=true`、`pushed_at=2022-12-12`、`open_issues=77`;
- npm `keytar 7.9.0` 2025-07 有发布,但仓库本体不再演进,依赖其原生二进制对新 Electron 有 ABI 风险;
- Electron 官方已内置 safeStorage 并对 macOS 用 Keychain,社区早已转向它。

**数据支撑(为何弃 security CLI)**:
- 每个 key 一次子进程 + 输出解析,脆弱;
- safeStorage 已在签名 app 内做了钥匙串授权与 key 生命周期管理。

### 6.2 落地设计(建议修订 G6-design)

```ts
// core/secret-store.ts  —— 实现不变,后端换成 safeStorage
import { safeStorage, app } from 'electron'

interface SecretStore { get(k: string): string | null; set(k: string, v: string): void; delete(k: string): void; health(): boolean }

export class KeychainSecretStore implements SecretStore {
  // 值向量:enc=[salt 8B + iv 12B + tag 16B + cipher],经 safeStorage.encryptString → 密文存 HARNESS_HOME/config.keys.json(0600)
  // key: 由 app.getPath('userData') 下的文件名派生,保证每个 provider 稳定
}
```

- 保留 `FileSecretStore`(0600 + `insecure` 标记)作降级,满足「无原生依赖」约束;
- `Provider.apiKey → Provider.keyRef`,启动时经 SecretStore 解析(对齐 G6-design §3);
- 迁移 `config.json` 已有明文 apiKey → Keychain → 原字段置空 + keyRef;`exportPayload({maskKeys:true})` 不变。

### 6.3 macOS 关键陷阱(必读)

- **签名一致性**:未签名或每次签名不同(临时签名/证书轮换),macOS 会把 app 当作不同实体,Keychain 每次重新弹授权——所以**密钥安全依赖发布主分支的签名稳定**(safeStorage 官方文档明确提及)。
- Electron 33 中 `safeStorage.encryptString/decryptString`(同步)可用;**Electron 46 起已移除同步 API**,务必只写 `encryptStringAsync/decryptStringAsync` 封装,未来升级零改动(safe-storage.md)。
- 降级:Linux 无 secret store 时 `basic_text` 明文——本项目的 File 降级覆盖该场景。

---

## 7. 日志与崩溃(对应 T6.6)

### 7.1 electron-log 5.x(替代自研轮转)

- macOS 默认路径:`~/Library/Logs/{app name}/main.log`(正好对齐 G6 预期)。
- 轮转:`log.transports.file.maxSize`(字节),超限时移为 `.old.log`;`archiveLogFn` 可自定义多代归档。
- 渲染器转发:主进程 `log.initialize()`,渲染器 `import log from 'electron-log/renderer'`;`utilityProcess` 需手动转发。
- 大小上限建议 `maxSize: 10 * 1024 * 1024`(对齐 T6.6 的 10MB)。

### 7.2 崩溃兜底

```ts
process.on('uncaughtException', (e) => { log.error('uncaught', e); app.exit(1) })
process.on('unhandledRejection', (r) => log.error('rejection', r))
// 原生崩溃 → Electron crashReporter.start({ uploadToServer:false }) 落盘，或依赖 dmg 版系统崩溃日志
```

断点可查 = `~/Library/Logs/Harness Bot/main.log + .old.log`。

---

## 8. 数据版本与迁移(对应 T6.5)

- `~/.harness-bot/schema.json { version: 3 }` + 启动迁移链,对齐 G6-design(SCHEMA_VERSION=3)。
- v2→v3:messages → jsonl(项目 G1 已有 jsonl 分片,复用)、密钥迁 Keychain、结构校验。
- **路径一致性警告**:打包后 `app.getPath('userData')` 由 `productName`/`appId` 决定;开发态(`electron .`)与打包态目录不同,迁移逻辑必须显式基于 `HARNESS_HOME`(项目已有)或用同一目录解析,否则升级数据丢失(§3 的 appId 不可变同理)。
- 迁移失败回滚:`schema.json.bak` + 保留原目录(G6-design 风险节应急预案)。

---

## 9. 审计导出(对应 T6.7)

- 现 `core/audit-log.ts` 存 jsonl;
- **JSON**:逐行读 jsonl → 数组 → 面板下载(含时间/来源/动作/参数脱敏);
- **CSV**:按 RFC 4180 处理转义(引号、逗号、换行包裹),导出仅含审计字段;
- 零额外依赖,纯 ts 实现即可。

---

## 10. 对 G6-design / G6-tasks 的修订建议

| 位置 | 原文 | 修订 |
|------|------|------|
| G6-design §1 Keychain | keytar 或 security CLI | **safeStorage**(§6.1 证据) |
| G6-design §4 配置 | target `[dmg, zip]` ✅ | 保留;明确声明 zip 为自动更新必需 |
| G6-design §4 `mac.notarize` | 未写明凭证来源 | 三种 env 凭证,CI 用 API Key |
| G6-tasks T6.2 | mock 时要验证升级生效 | 无证书时只能到「download-downloaded」,真升标注需签名版 |
| G6-tasks T6.3 冒烟 | keytar 真机冒烟 | safeStorage 冒烟 + 签名一致性检查 |
| package.json | electron ^33 | G6 期间评估升级(33 EOL;safeStorage sync API 将于 46 移除,建议直接写 async) |

---

## 11. 验收自检(对应 G6 F1–F8)

- [ ] F1 `bun run dist:mac` 产出 dmg + zip,unsigned 可注明
- [ ] F2 有凭证时自动签名+公证+stapler;`spctl --assess` accepted
- [ ] F3 generic + latest-mac.yml 走通 检测→下载→(签名版)重启
- [ ] F4 Provider apiKey→keyRef,config.json 无明文;FileSecretStore 0600
- [ ] F5 `schema.json` v3 迁移往返,数据完整
- [ ] F6 electron-log 轮转 10MB + .old;uncaught 落日志
- [ ] F7 审计导出 CSV/JSON 字段完整
- [ ] F8 设置页显示 version/channel + 检查更新按钮

---

## 12. 主要来源

- electron-builder macOS 配置:[mac.md](https://www.electron.build/mac)
- electron-builder DMG 配置:[dmg.md](https://www.electron.build/dmg)
- electron-builder macOS 签名:[code-signing-mac.md](https://www.electron.build/code-signing/code-signing-mac.html)
- electron-builder 公证:[code-signing/notarization.md](https://www.electron.build/code-signing/notarization.html)
- electron-builder 自动更新:[auto-update.md](https://www.electron.build/auto-update)
- electron-builder publish(含 generic):[publish.md](https://www.electron.build/publish)
- electron-builder 签名更新清单(v27):[signed-update-manifests.md](https://www.electron.build/security/signed-update-manifests.html)
- v26→v27 迁移:[migration/v26-to-v27](https://www.electron.build/migration/v26-to-v27)
- v26 源码 `macOptions.ts`(`gh api …?ref=v26.0.18`)
- Electron safeStorage 官方文档:`docs/api/safe-storage.md`(electron/electron)
- electron-log:[README](https://github.com/megahertz/electron-log)、[file transport](https://github.com/megahertz/electron-log/blob/master/docs/transports/file.md)
- keytar 归档状态:`gh api repos/atom/node-keytar`(`archived: true`)
- npm 版本实况:`registry.npmjs.org/{electron-builder,electron-updater,keytar,electron-log}`