# 待做（备选）

> 更新：2026-11-02 · 近期加固已完成后的备选项；非阻塞上线。

## 备选（先记着，未排期）

（暂无）

## 本轮已完成

1. 例行入站 Webhook 令牌轮换 / 作废（例行面板 🪝 管理：复制 / 换新 / 关闭）
2. 远程网关强制 HMAC：Connect → 入站网关「要求 HMAC」；`GatewayCfg.requireHmac`
3. `webhook.post` 写入审计日志
4. MCP stdio 安装白名单 + 非白名单二次确认（`requiresStrongConsent`）
5. 短链 TTL 可配（1–365 天，Connect 短链桥 + Worker）
6. `/bots/msg` 跨机 bot：令牌展示/轮换 + 限流 + Connect 说明
7. Grok-gap 抛光：例行进对话卡 / 时区 / Presence waiting / 技能 per-bot / 花名册 pin·hide·section / 记忆导入

## 明确暂缓

- G6 公证 / electron-updater
