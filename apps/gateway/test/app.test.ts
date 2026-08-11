import { describe, expect, it } from 'vitest';
import { createDatabase, runMigrations } from '@a2site/database';
import {
  IDENTITY_MIGRATIONS,
  IdentityService,
  MemoryEmailSender,
} from '@a2site/identity';
import { buildApp } from '../src/app.js';
import { loadGatewayConfig } from '../src/config.js';

describe('A2Site gateway', () => {
  it('提供健康检查和绝对化的网站发现清单', async () => {
    const config = loadGatewayConfig({
      A2SITE_SITE_ID: 'gateway-test',
      A2SITE_SITE_NAME: '网关测试站',
      A2SITE_SITE_ORIGIN: 'http://localhost:3200',
      A2SITE_ALLOW_INSECURE_LOCALHOST: 'true',
    });
    const app = await buildApp(config);

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, product: 'a2site' });

    const publicHealth = await app.inject({ method: 'GET', url: '/api/a2site/v1/health' });
    expect(publicHealth.statusCode).toBe(200);
    expect(publicHealth.json()).toMatchObject({ ok: true, database: 'not_checked' });

    const manifest = await app.inject({ method: 'GET', url: '/.well-known/a2site.json' });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json()).toMatchObject({
      site: { id: 'gateway-test', origin: 'http://localhost:3200' },
      agent: { audience: 'external_agents', platform_provides_agent: false },
      endpoints: { manifest: 'http://localhost:3200/api/a2site/v1/manifest' },
    });

    await app.close();
  });

  it('拒绝错误的端口配置', () => {
    expect(() => loadGatewayConfig({ A2SITE_PORT: '70000' })).toThrow(/A2SITE_PORT/);
  });

  it('只接受显式可信反向代理提供的客户端地址', async () => {
    const config = loadGatewayConfig({
      A2SITE_SITE_ORIGIN: 'http://localhost:3200',
      A2SITE_ALLOW_INSECURE_LOCALHOST: 'true',
      A2SITE_TRUSTED_PROXIES: '127.0.0.1,::1',
    });
    const app = await buildApp(config);
    app.get('/test-client-ip', async (request) => ({ ip: request.ip }));

    const trusted = await app.inject({
      method: 'GET',
      url: '/test-client-ip',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });
    expect(trusted.json()).toEqual({ ip: '203.0.113.9' });

    const untrusted = await app.inject({
      method: 'GET',
      url: '/test-client-ip',
      remoteAddress: '198.51.100.7',
      headers: { 'x-forwarded-for': '203.0.113.10' },
    });
    expect(untrusted.json()).toEqual({ ip: '198.51.100.7' });
    await app.close();
  });

  it('通过 HTTP 完成 Agent 邮箱连接并在发现清单中公开身份入口', async () => {
    const config = loadGatewayConfig({
      A2SITE_SITE_ID: 'identity-site',
      A2SITE_SITE_NAME: '身份测试站',
      A2SITE_SITE_ORIGIN: 'http://localhost:3200',
      A2SITE_ALLOW_INSECURE_LOCALHOST: 'true',
      A2SITE_AUTH_HASH_SECRET: 'gateway-test-hash-secret-longer-than-thirty-two-bytes',
    });
    const database = await createDatabase();
    await runMigrations(database, IDENTITY_MIGRATIONS);
    const email = new MemoryEmailSender();
    const identity = new IdentityService(database, email, {
      siteId: 'identity-site',
      hashSecret: config.identity.hashSecret,
      allowedScopes: config.identity.allowedScopes,
      defaultScopes: config.identity.defaultScopes,
    });
    const app = await buildApp(config, { identityService: identity });

    const manifest = await app.inject({ method: 'GET', url: '/.well-known/a2site.json' });
    expect(manifest.json().endpoints.identity)
      .toBe('http://localhost:3200/api/a2site/v1/identity');

    const claimResponse = await app.inject({
      method: 'POST',
      url: '/api/a2site/v1/identity/claims',
      payload: { email: 'agent@example.com', agent_name: 'Codex', client_type: 'codex' },
    });
    expect(claimResponse.statusCode).toBe(200);
    const claim = claimResponse.json();

    const challengeResponse = await app.inject({
      method: 'POST',
      url: `/api/a2site/v1/identity/claims/${claim.claim_id}/challenges`,
      headers: { 'x-a2site-claim-secret': claim.claim_secret },
    });
    expect(challengeResponse.statusCode).toBe(200);
    const challenge = challengeResponse.json();

    const verifyResponse = await app.inject({
      method: 'POST',
      url: `/api/a2site/v1/identity/claims/${claim.claim_id}/verify`,
      headers: { 'x-a2site-claim-secret': claim.claim_secret },
      payload: { challenge_id: challenge.challenge_id, code: email.latestCode() },
    });
    expect(verifyResponse.statusCode).toBe(200);
    const credential = verifyResponse.json();

    const meResponse = await app.inject({
      method: 'GET',
      url: '/api/a2site/v1/identity/me',
      headers: { authorization: `Bearer ${credential.access_token}` },
    });
    expect(meResponse.statusCode).toBe(200);
    expect(meResponse.json()).toMatchObject({
      site_id: 'identity-site',
      agent_name: 'Codex',
      scopes: ['manifest:read', 'identity:read'],
    });

    await app.close();
    await database.close();
  });

  it('生产环境缺少 PostgreSQL、正式密钥或邮件适配器时失败关闭', () => {
    expect(() => loadGatewayConfig({
      NODE_ENV: 'production',
      A2SITE_SITE_ORIGIN: 'https://example.com',
    })).toThrow(/A2SITE_DATABASE_URL/);
  });

  it('生产 SMTP 配置完整时允许启动配置', () => {
    const config = loadGatewayConfig({
      NODE_ENV: 'production',
      A2SITE_SITE_ORIGIN: 'https://example.com',
      A2SITE_DATABASE_URL: 'postgresql://a2site:secret@localhost/a2site',
      A2SITE_AUTH_HASH_SECRET: 'production-hash-secret-longer-than-thirty-two-bytes',
      A2SITE_EMAIL_MODE: 'smtp',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
      SMTP_SECURE: 'false',
      SMTP_USER: 'smtp-user',
      SMTP_PASSWORD: 'smtp-password',
      EMAIL_FROM_ADDRESS: 'agent@example.com',
    });
    expect(config.identity.emailMode).toBe('smtp');
    expect(config.identity.smtp).toMatchObject({ host: 'smtp.example.com', port: 587 });
  });

  it('身份认领在解析前拒绝超过 16 KiB 的请求正文', async () => {
    const config = loadGatewayConfig({
      A2SITE_SITE_ORIGIN: 'http://localhost:3200',
      A2SITE_ALLOW_INSECURE_LOCALHOST: 'true',
    });
    const database = await createDatabase();
    await runMigrations(database, IDENTITY_MIGRATIONS);
    const identity = new IdentityService(database, new MemoryEmailSender(), {
      siteId: 'example-site',
      hashSecret: config.identity.hashSecret,
      allowedScopes: config.identity.allowedScopes,
      defaultScopes: config.identity.defaultScopes,
    });
    const app = await buildApp(config, { identityService: identity });

    const response = await app.inject({
      method: 'POST',
      url: '/api/a2site/v1/identity/claims',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        email: 'large@example.com',
        agent_name: 'x'.repeat(17_000),
      }),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });

    await app.close();
    await database.close();
  });
});
