# 单机生产部署

该目录提供 A2Site 独立服务的最小生产配置。它与宿主网站共享域名，但不共享应用进程、数据库、系统用户或环境文件。

果酱盒子生产实例使用：

- 代码：`/opt/a2site/app`，只从公开 GitHub 仓库拉取；
- 服务：`a2site-gateway.service`；
- 监听：`127.0.0.1:3320`；
- 可信代理：只信任同机 Nginx 的 `127.0.0.1` 和 `::1`；
- 配置：`/etc/a2site/gateway.env`，权限 `0600`；
- 业务动作：可选 `/etc/a2site/actions.json` 普通文件，由 `A2SITE_ACTIONS_FILE` 指向，不得包含凭据；
- 数据库：独立 PostgreSQL 数据库 `a2site` 和最小权限角色；
- 公网入口：`/.well-known/a2site.json`、`/.well-known/agent-site.json`、`/api/a2site/`。

正式配置不得提交 SMTP 密码、数据库密码或身份哈希密钥。修改 Nginx 前先备份，执行 `nginx -t` 成功后才能 reload。
