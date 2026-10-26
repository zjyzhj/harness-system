# G5-TASKS — 系统深度接入

> Goal：G5 · 状态：⏳ 待实现 · 上游：[G5-design](./G5-design.md)

## 0. 总览

| 任务 | 内容 | 出口 | 状态 |
|------|------|------|------|
| T5.0 | ConsentCenter（grant/revoke/once/ttl/expire） | 授权生命周期单测 | ⬜ |
| T5.1 | 授权弹窗 IPC（bot 名/能力/一次/长期/拒绝） | 未授权调用挂起等待 | ⬜ |
| T5.2 | AuditLog（append-only jsonl + 查询/导出） | 每次调用落一条 | ⬜ |
| T5.3 | SystemAccess.apple（openApp/activate/type/click/hotkey 模板） | 模板校验 + 真 osascript 冒烟 | ⬜ |
| T5.4 | 截图（区域/全屏 → image 块注入会话） | 授权后截图可用 | ⬜ |
| T5.5 | bash 白名单分组（dev/read/net/io）+ 强确认命令 | 分组放行 + rm 强确认 | ⬜ |
| T5.6 | TCC 引导检测（辅助功能/屏幕录制） | 状态检测 + 引导打开设置 | ⬜ |
| T5.7 | 面板授权矩阵 + 审计日志页 | UI 撤销/查看/导出 | ⬜ |
| T5.8 | 集成验收（F1–F9） | 全绿 + 冒烟 | ⬜ |

## 1. 顺序

```
T5.0 → T5.1 → T5.2（授权核心 + 审计）
T5.3 → T5.4（AppleScript + 截图，需真机冒烟）
T5.5 → T5.6（bash 分组 + TCC）
T5.7 → T5.8
```

## 2. 关键验收口径

- T5.0：grant(once) 用一次即失效；grant(ttl 1min) 过期后 request=false；revoke 全部生效。
- T5.1：未授权 request → 返回 pending 且弹窗；点「拒绝」→ false；点「一次」→ 本次 true 下次 false。
- T5.2：连续 10 次调用 → 审计 10 条；导出 JSON 含全部字段。
- T5.3：`openApp Safari` 模板冒烟成功；注入 `" & ` 等参数被拒（模板校验测试）。
- T5.4：授权 screen 后截图返回文件存在 + dataUrl 可作 image 块。
- T5.5：`git status` 在 bash:dev 授权下放行；`rm -rf /` 触发强确认且未输入 confirm 拒绝。
- T5.6：检测辅助功能状态返回 boolean；未授权时提示引导。
- T5.7：面板撤销后 bot 再调用被拒；审计页过滤生效。
