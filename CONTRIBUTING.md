# 参与贡献

欢迎 Issue、讨论与 Pull Request。源码以 [GitHub 仓库](https://github.com/zjyzhj/harness-system) 为准。

## 开发环境

- macOS（arm64 优先）
- [Bun](https://bun.sh)

```bash
bun install
bun test
bun run typecheck
bun start          # 构建并启动
# 或
bun run dev        # 签名 + 构建壳 + 启动 Electron
```

## 提 PR 前

1. 跑通 `bun test`；涉及类型的改动再跑 `bun run typecheck`
2. 大功能先对照 `docs/goals/` 里对应 Goal 的边界（spec / design）
3. 提交信息写清「为什么」，风格对齐现有 `git log`
4. 不要提交密钥、`.env`、本机数据目录或 `out.txt` 一类临时文件
5. Live2D 样本与第三方许可见 `app/renderer/live2d/LICENSE-samples.md`；勿擅自替换为未授权资源

## 分支与 PR

1. 从最新 `main` 拉分支
2. 一个 PR 尽量只做一件事；说明动机、用法与测试方式
3. 维护者合并后默认保留 squash / merge commit（以仓库设置为准）

## 安全与同意

涉及系统能力（通知、剪贴板、文件、截屏、电脑操控、命令执行）的改动，须走同意中心 / 审计路径，不要绕过授权弹窗。

## 许可证

贡献代码即同意以仓库根目录 [MIT License](./LICENSE) 授权。第三方依赖与 Live2D 样本仍受各自许可证约束。
