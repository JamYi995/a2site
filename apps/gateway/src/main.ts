import 'dotenv/config';
import { buildApp } from './app.js';
import { loadGatewayConfig } from './config.js';
import { createGatewayRuntime } from './runtime.js';

const config = loadGatewayConfig();
const runtime = await createGatewayRuntime(config);
const app = await buildApp(config, { identityService: runtime.identityService });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'A2Site gateway stopping');
  await app.close();
  await runtime.database.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.host, port: config.port });
  console.log(`A2Site gateway listening on http://${config.host}:${config.port}`);
} catch (error) {
  console.error(error);
  process.exit(1);
}
