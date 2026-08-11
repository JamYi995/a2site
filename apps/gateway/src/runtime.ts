import { createDatabase, runMigrations, type A2SiteDatabase } from '@a2site/database';
import {
  ConsoleEmailSender,
  IDENTITY_MIGRATIONS,
  IdentityService,
} from '@a2site/identity';
import type { GatewayConfig } from './config.js';

export interface GatewayRuntime {
  database: A2SiteDatabase;
  identityService: IdentityService;
}

export async function createGatewayRuntime(config: GatewayConfig): Promise<GatewayRuntime> {
  const database = await createDatabase({
    databaseUrl: config.databaseUrl,
    pglitePath: config.pglitePath,
  });
  await runMigrations(database, IDENTITY_MIGRATIONS);
  const identityService = new IdentityService(database, new ConsoleEmailSender(), {
    siteId: String(config.manifest.site.id),
    hashSecret: config.identity.hashSecret,
    allowedScopes: config.identity.allowedScopes,
    defaultScopes: config.identity.defaultScopes,
  });
  return { database, identityService };
}
