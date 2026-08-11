import type { FastifyPluginAsync } from 'fastify';
import { IdentityError, type IdentityService } from '@a2site/identity';
import {
  A2SITE_COMPATIBLE_WELL_KNOWN_PATH,
  A2SITE_MANIFEST_PATH,
  A2SITE_WELL_KNOWN_PATH,
  createSiteManifest,
  type A2SiteManifestInput,
  type CreateManifestOptions,
} from '@a2site/protocol';

export interface A2SiteFastifyOptions extends CreateManifestOptions {
  manifest: A2SiteManifestInput;
  identityService?: IdentityService;
}

type JsonObject = Record<string, unknown>;

async function registerIdentityRoutes(app: Parameters<FastifyPluginAsync>[0], identity: IdentityService) {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof IdentityError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      });
    }
    const statusCode = Number((error as { statusCode?: number }).statusCode);
    if (statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({
        error: {
          code: statusCode === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST',
          message: statusCode === 413 ? '请求正文超过接口限制' : '请求格式无效',
        },
      });
    }
    app.log.error(error);
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用' } });
  });

  app.get('/api/a2site/v1/identity', async () => ({
    schema_version: '1.0',
    audience: 'external_agents',
    objective: '由当前 Agent 使用用户邮箱连接网站，并安全保存自己的访问凭证',
    authentication: {
      scheme: 'Bearer',
      token_prefix: 'a2s_',
      local_file_mode: '0600',
    },
    workflow: [
      { step: 1, method: 'POST', endpoint: '/api/a2site/v1/identity/claims', action: '创建邮箱认领' },
      { step: 2, method: 'POST', endpoint_template: '/api/a2site/v1/identity/claims/{claim_id}/challenges', action: '请求邮箱验证码' },
      { step: 3, method: 'POST', endpoint_template: '/api/a2site/v1/identity/claims/{claim_id}/verify', action: '由 Agent 提交验证码并领取一次性明文凭证' },
      { step: 4, method: 'GET', endpoint: '/api/a2site/v1/identity/me', action: '验证凭证与作用域' },
    ],
    security: {
      claim_secret_header: 'X-A2Site-Claim-Secret',
      never_put_in_chat_or_artifact: ['email_otp', 'claim_secret', 'agent_token'],
      plaintext_credential_returned_once: true,
    },
  }));

  app.post('/api/a2site/v1/identity/claims', { bodyLimit: 16_384 }, async (request) => {
    const body = (request.body ?? {}) as JsonObject;
    return identity.createClaim({
      email: body.email,
      agentName: body.agent_name,
      clientType: body.client_type,
      requestedScopes: body.requested_scopes,
      remoteAddress: request.ip,
    });
  });

  app.post('/api/a2site/v1/identity/claims/:id/challenges', { bodyLimit: 1_024 }, async (request) => {
    const parameters = request.params as { id?: string };
    return identity.sendChallenge({
      claimId: parameters.id,
      claimSecret: request.headers['x-a2site-claim-secret'],
      remoteAddress: request.ip,
    });
  });

  app.post('/api/a2site/v1/identity/claims/:id/verify', { bodyLimit: 8_192 }, async (request) => {
    const parameters = request.params as { id?: string };
    const body = (request.body ?? {}) as JsonObject;
    return identity.verifyClaim({
      claimId: parameters.id,
      claimSecret: request.headers['x-a2site-claim-secret'],
      challengeId: body.challenge_id,
      code: body.code,
      remoteAddress: request.ip,
    });
  });

  app.get('/api/a2site/v1/identity/me', async (request) => (
    identity.getMe(request.headers.authorization)
  ));

  app.post('/api/a2site/v1/identity/credentials/rotate', { bodyLimit: 1_024 }, async (request) => (
    identity.rotateCredential(request.headers.authorization)
  ));

  app.post('/api/a2site/v1/identity/credentials/revoke', { bodyLimit: 8_192 }, async (request) => {
    const body = (request.body ?? {}) as JsonObject;
    return identity.revokeCredential(request.headers.authorization, body.reason);
  });
}

export const a2siteFastifyPlugin: FastifyPluginAsync<A2SiteFastifyOptions> = async (
  app,
  options,
) => {
  const manifest = createSiteManifest(options.manifest, {
    allowInsecureLocalhost: options.allowInsecureLocalhost,
  });

  const response = async () => manifest;
  const routeOptions = {
    config: { rateLimit: false },
    handler: response,
  };

  app.get(A2SITE_WELL_KNOWN_PATH, routeOptions);
  app.get(A2SITE_COMPATIBLE_WELL_KNOWN_PATH, routeOptions);
  app.get(A2SITE_MANIFEST_PATH, routeOptions);

  if (options.identityService) {
    await app.register(async (identityApp) => {
      await registerIdentityRoutes(identityApp, options.identityService as IdentityService);
    });
  }
};
