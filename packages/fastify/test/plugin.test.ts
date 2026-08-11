import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { a2siteFastifyPlugin } from '../src/index.js';

describe('a2siteFastifyPlugin', () => {
  it('同时提供规范发现地址、兼容发现地址和清单接口', async () => {
    const app = Fastify();
    await app.register(a2siteFastifyPlugin, {
      manifest: {
        site: {
          id: 'plugin-test',
          name: '插件测试站',
          origin: 'https://example.com',
        },
        endpoints: { manifest: '/api/a2site/v1/manifest' },
        actions: [],
      },
    });

    for (const path of [
      '/.well-known/a2site.json',
      '/.well-known/agent-site.json',
      '/api/a2site/v1/manifest',
    ]) {
      const response = await app.inject({ method: 'GET', url: path });
      expect(response.statusCode).toBe(200);
      expect(response.json().site.id).toBe('plugin-test');
      expect(response.json().endpoints.manifest)
        .toBe('https://example.com/api/a2site/v1/manifest');
    }

    await app.close();
  });
});
