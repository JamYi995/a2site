import { describe, expect, it } from 'vitest';
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
});
