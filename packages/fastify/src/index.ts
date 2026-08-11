import type { FastifyPluginAsync } from 'fastify';
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
};
