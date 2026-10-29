# G8 灵境（Lingjing）— 文本 + 音色还原

> 阶段：Design · 范围：MVP（文本对话 + 真人音色克隆）· 视频数字人延后

## 1. 产品边界

| | 普通 bot | **灵境 Presence** |
|--|--|--|
| 目的 | 做事 / 陪伴 / 桌宠 | **留住特定的人**（私密联结） |
| 实体 | `Bot` | `Presence`（独立，不进 bot 列表） |
| 形象 | Live2D / 形状头像 | MVP 不做视频；仅文本 + 声音 |
| 声音 | 系统朗读（可选） | **参考音频克隆的真人音色** |
| 工具 | 完整工具链 | **无工具**，只对话 |
| 存储 | `bots.json` + sessions | `realm/presences.json` + `presence:<id>` 会话 |

定位一句话：**媒介，不是替身**——维持联结，不伪装真人在线、不无限续造人格。

## 2. MVP 成功标准

1. 可创建 Presence（含授权声明），与 bot 列表隔离  
2. 上传参考音频（建议 8–10s）→ 远端音色 ID（SiliconFlow CosyVoice 等）  
3. 文本对话：按此人痕迹回复，并合成其音色音频可播放  
4. 始终展示「灵境 · AI 再现」标识  
5. 可封存 / 删除 Presence 与本地素材  

非目标：视频口型、实时打断、群聊、工具调用、公网分享。

## 3. 技术选型

- **LLM**：复用现有 `ProviderCenter`（OpenAI 兼容）  
- **TTS / 克隆**：配置项 `tts`（与 `asr` 并列），**不绑死供应商**  
  - 协议：任意兼容 `POST /audio/speech`  
  - `cloneMode`：`none`（预设 voice）/ `upload`（可配 uploadPath）/ `inline`（references 附参考音）  
  - 预设仅快捷填表（OpenAI / CosyVoice 等）  
- **生图**：任意 OpenAI 兼容 `/images/generations`，预设非强制  
- **本机**：`~/.harness-bot/realm/<presenceId>/`（参考音、合成音）  

## 4. 数据模型（摘要）

```ts
Presence {
  id, name, relation?, bio?, styleNotes?, corpus?,
  providerId, consent { affirmedAt, role, statement },
  voice { status, remoteVoiceId?, refPath?, refText?, error? },
  createdAt, updatedAt, archived?
}
```

会话：`Session.botId = "presence:" + id`，消息 `meta.realm = true`，回复可含 `audio` 内容块。

## 5. 合规闸门（MVP）

创建时必须勾选并选择身份角色：

- `self`：本人授权  
- `with-consent`：已获本人明确同意  
- `kin`：近亲属（逝者情形）  

界面固定文案：AI 再现、私密使用、可删除。不做主动推送「该来看看 TA」。

## 6. 模块拆分

| 模块 | 职责 |
|------|------|
| `core/realm/*` | Presence 存储、提示词、对话回合 |
| `core/adapters/tts.ts` | 上传音色 / 合成语音 |
| `app/host/realm-ipc.ts` | IPC |
| `app/renderer/realm.js` | 独立 UI 面 |

## 7. 后续（非本 MVP）

视频数字人、流式 TTS、本地 CosyVoice、深度合成隐式水印。
