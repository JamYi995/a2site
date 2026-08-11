# A2Site Agent 身份与授权

## 目标

让外部 Agent 使用用户邮箱连接一个安装了 A2Site 的网站。验证码的读取可以由 Agent 或用户协助完成，但验证码最终始终由 Agent 调用接口提交。

## 机器入口

`GET /api/a2site/v1/identity`

该接口返回完整工作流、凭证格式、保存要求和安全约束。

## 接口

| 动作 | 方法与地址 | 认证 |
|---|---|---|
| 创建认领 | `POST /api/a2site/v1/identity/claims` | 无 |
| 请求验证码 | `POST /api/a2site/v1/identity/claims/{id}/challenges` | `X-A2Site-Claim-Secret` |
| 提交验证码 | `POST /api/a2site/v1/identity/claims/{id}/verify` | 认领密钥 + 验证码 |
| 当前身份 | `GET /api/a2site/v1/identity/me` | Bearer |
| 轮换凭证 | `POST /api/a2site/v1/identity/credentials/rotate` | Bearer |
| 撤销凭证 | `POST /api/a2site/v1/identity/credentials/revoke` | Bearer |

认领密钥使用 `a2c_` 前缀，Agent 凭证使用 `a2s_` 前缀。两者都只保存 HMAC 摘要。

## 数据表

- `a2site_site_accounts`：独立网关的默认网站账号映射。
- `a2site_agent_claims`：邮箱认领和一次性签发状态。
- `a2site_email_challenges`：验证码摘要、错误次数、替换和消费状态。
- `a2site_agent_identities`：Agent 与网站账号主体的关系。
- `a2site_agent_credentials`：凭证摘要、作用域、有效期、轮换和撤销。
- `a2site_identity_events`：身份安全审计。
- `a2site_rate_limit_counters`：数据库持久限流。

## 网站账号适配器

`SiteAccountAdapter.resolveVerifiedEmail()` 是身份模块与网站账号系统的唯一必要连接点。

- 独立网关默认使用 `DatabaseSiteAccountAdapter`，在 A2Site 数据库中建立账号主体。
- 已有账号系统的网站应实现自己的适配器，用验证后的邮箱解析站点内部 `subject_id`。
- A2Site 不需要读取网站完整用户表，也不要求数据库超级用户权限。

## 数据库

- 本地开发默认使用 `.data/a2site` 持久 PGlite。
- 正式环境必须配置 `A2SITE_DATABASE_URL` 使用 PostgreSQL。
- 迁移记录保存在 `a2site_schema_migrations`。
- 正式数据库 TLS、备份恢复、连接池和高可用需要由部署方独立配置和验收。

## 邮件

独立网关当前只内置本地 `ConsoleEmailSender`，只允许开发环境使用。正式网站必须注入实现 `EmailSender` 的邮件适配器；没有正式适配器时生产启动失败关闭。

## 安全约束

- 正式环境必须显式设置至少 32 字节的 `A2SITE_AUTH_HASH_SECRET`。
- Agent 只能请求网站允许的作用域，未知作用域直接拒绝。
- 默认只开放 `manifest:read` 和 `identity:read`。
- 认领、发码和验证码校验都执行数据库限流。
- 验证码默认六位、10 分钟有效、最多错误 5 次。
- 认领默认 30 分钟有效，凭证默认 30 天有效。
- 明文凭证不会写入数据库，也不会通过接口再次显示。
- 轮换后旧凭证立即失效；撤销后不能恢复。
- 生产反向代理信任边界尚未开放配置，默认只使用连接来源地址，避免伪造转发头。
