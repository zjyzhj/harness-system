# harness-share-bridge

把超长 `harnessbot://` 模板存进 Cloudflare KV，给出可转发的 HTTPS 短链。

## 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| POST | `/api/put` | `Authorization: Bearer $PUT_KEY`，body `{ link, name?, role? }`（id 服务端生成；约 90 天 TTL；按钥限流约 20/分、200/日） |
| GET | `/api/list` | 本钥下短链列表（不含协议正文） |
| DELETE | `/api/b/:id` | 撤销短链（立刻失效） |
| POST | `/w/:token` | **公网入站 Webhook**（令牌在路径）；JSON body，`message` / `priority`；返回 202 入队 |
| GET | `/api/inbound/pull?tokens=` | 本机用 `PUT_KEY` 拉取待处理入站 |
| POST | `/api/inbound/ack` | 本机确认已处理（`{ keys: kvKey[] }`） |
| GET | `/b/:id` | 预览页 |
| GET | `/b/:id?open=1` | 唤起协议链接 |
| GET | `/b/:id?format=json` | JSON（含 `link`） |

## 部署

```bash
set -a && source ~/.config/appfactory-cloudflare-legal/api_token.env && set +a
export CLOUDFLARE_API_TOKEN PUT_KEY  # PUT_KEY 自备
cd cloud/share-bridge
npx wrangler@4 secret put PUT_KEY
npx wrangler@4 deploy
```

或用仓库脚本：`bun run cloud/share-bridge/deploy.ts`
