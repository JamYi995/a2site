import Fastify, { type FastifyInstance } from 'fastify';
import { a2siteFastifyPlugin } from '@a2site/fastify';
import type { IdentityService } from '@a2site/identity';
import type { GatewayConfig } from './config.js';

export interface GatewayDependencies {
  identityService?: IdentityService;
}

export async function buildApp(
  config: GatewayConfig,
  dependencies: GatewayDependencies = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 1_048_576,
  });

  app.get('/health', async () => ({
    ok: true,
    product: 'a2site',
    version: '0.2.0',
  }));

  const manifest = dependencies.identityService
    ? {
        ...config.manifest,
        endpoints: {
          ...config.manifest.endpoints,
          identity: '/api/a2site/v1/identity',
        },
        actions: [
          ...(config.manifest.actions ?? []),
          {
            id: 'identity.claim.create',
            title: '创建 Agent 邮箱认领',
            description: '由外部 Agent 使用用户邮箱创建连接认领',
            method: 'POST' as const,
            endpoint: '/api/a2site/v1/identity/claims',
            risk: 'low' as const,
            requires_auth: false,
            requires_human_confirmation: false,
          },
          {
            id: 'identity.credential.rotate',
            title: '轮换 Agent 凭证',
            description: '签发新凭证并让旧凭证立即失效',
            method: 'POST' as const,
            endpoint: '/api/a2site/v1/identity/credentials/rotate',
            risk: 'medium' as const,
            requires_auth: true,
            requires_human_confirmation: false,
          },
          {
            id: 'identity.credential.revoke',
            title: '撤销 Agent 凭证',
            description: '由 Agent 撤销自己的当前访问凭证',
            method: 'POST' as const,
            endpoint: '/api/a2site/v1/identity/credentials/revoke',
            risk: 'medium' as const,
            requires_auth: true,
            requires_human_confirmation: false,
          },
        ],
      }
    : config.manifest;

  await app.register(a2siteFastifyPlugin, {
    manifest,
    allowInsecureLocalhost: config.allowInsecureLocalhost,
    identityService: dependencies.identityService,
  });

  return app;
}
