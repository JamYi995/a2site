import Fastify, { type FastifyInstance } from 'fastify';
import { a2siteFastifyPlugin } from '@a2site/fastify';
import type { GatewayConfig } from './config.js';

export async function buildApp(config: GatewayConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 1_048_576,
  });

  app.get('/health', async () => ({
    ok: true,
    product: 'a2site',
    version: '0.1.0',
  }));

  await app.register(a2siteFastifyPlugin, {
    manifest: config.manifest,
    allowInsecureLocalhost: config.allowInsecureLocalhost,
  });

  return app;
}
