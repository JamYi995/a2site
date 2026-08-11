# A2Site（果酱桥）

A2Site 是一个让网站能够被外部 Agent 安全发现和调用的开源接入层，由果酱盒子发起。

它不提供 Agent，也不要求用户改用某一种 Agent。Codex、Hermes、Claude、OpenClaw 或其他本地/云端 Agent，都可以通过同一套机器可读入口了解网站能力、完成授权，并在高风险操作时把用户带回网站进行独立确认。

## 当前状态

当前为 `0.2.0` 第二阶段：

- 已完成网站能力清单协议和 JSON Schema。
- 已完成 Fastify 接入插件。
- 已完成可独立运行的接入网关。
- 已提供规范发现地址 `/.well-known/a2site.json`。
- 已兼容通用发现地址 `/.well-known/agent-site.json`。
- 所有清单、身份工作流和后续步骤端点在输出时自动初始化为绝对地址，Agent 不需要猜测安装或调用来源。
- 高风险能力如果没有声明独立人工确认，清单校验会直接失败。
- 已完成 Agent 邮箱认领、验证码提交和一次性凭证签发。
- 已完成凭证作用域、轮换、撤销、到期和数据库审计。
- 已实现正式 PostgreSQL 与本地持久 PGlite 两种数据库适配器。
- 已提供站点账号适配器，第三方网站不需要使用 A2Site 自建账号表。
- 已提供正式 SMTP 验证码适配器和数据库健康检查，可作为独立生产服务部署。

独立人工确认、问题反馈与附件是后续阶段；当前版本不会在清单中宣称尚未实现的端点。

## 本地运行

```bash
corepack pnpm install
cp .env.example .env
corepack pnpm dev
```

打开：

- `http://localhost:3200/health`
- `http://localhost:3200/.well-known/a2site.json`
- `http://localhost:3200/api/a2site/v1/identity`

也可以使用 Docker：

```bash
docker compose up --build
```

单机生产部署配置见 [`deploy/single-server`](deploy/single-server/README.md)。生产服务只监听回环地址，由网站反向代理公开规范入口。

## 接入现有 Fastify 网站

```ts
import Fastify from 'fastify';
import { a2siteFastifyPlugin } from '@a2site/fastify';

const app = Fastify();

await app.register(a2siteFastifyPlugin, {
  manifest: {
    site: {
      id: 'my-site',
      name: '我的网站',
      origin: 'https://example.com',
    },
    endpoints: {
      manifest: '/api/a2site/v1/manifest',
    },
    actions: [],
  },
});
```

## 模块边界

A2Site 开源范围包括网站发现协议、Agent 身份与授权、人工确认、反馈与附件、安全审计基础、接入工具包和基础界面。

果酱盒子的 Skill/MCP 能力市场、专家经营、支付、权益、安装更新、分成结算和托管资源不属于本仓库。

## Agent 连接流程

1. Agent 调用身份入口读取机器方案。
2. Agent 使用邮箱创建认领，临时保存只返回一次的认领密钥。
3. Agent 请求邮箱验证码；本地开发模式把验证码输出到服务主机终端。
4. Agent 读取验证码，或者只向用户询问验证码，再由 Agent 调用验证接口提交。
5. 平台只返回一次明文 `a2s_` 凭证，Agent 应以 `0600` 权限保存。
6. Agent 调用 `/identity/me` 验证身份，也可以轮换或撤销当前凭证。

完整接口和生产边界见 [身份与授权协议](docs/identity.md)。

给 Agent 的最短连接指令：

> 读取 `https://jamboxsys.com/.well-known/a2site.json`，按清单连接果酱盒子；需要邮箱验证码时再向我询问。

## 许可证与品牌

代码采用 [Apache-2.0](LICENSE) 许可证。A2Site、果酱桥、果酱盒子及其标识的使用规则见 [TRADEMARK.md](TRADEMARK.md)。

安全问题请不要提交公开 Issue，按 [SECURITY.md](SECURITY.md) 中的方式处理。
