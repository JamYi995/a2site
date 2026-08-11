# 参与贡献

感谢参与 A2Site。

## 开发流程

1. 建立独立分支。
2. 保持协议与果酱盒子商业逻辑解耦。
3. 新增行为时同步更新测试和文档。
4. 提交前运行：

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

公开提交不得包含密码、Token、用户数据、生产域名配置、服务器信息或私有商业代码。
