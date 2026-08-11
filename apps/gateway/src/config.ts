import {
  A2SITE_MANIFEST_PATH,
  type A2SiteManifestInput,
} from '@a2site/protocol';

export interface GatewayConfig {
  host: string;
  port: number;
  allowInsecureLocalhost: boolean;
  manifest: A2SiteManifestInput;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? '3200');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('A2SITE_PORT 必须是 1 到 65535 之间的整数');
  }
  return port;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('布尔配置只能是 true 或 false');
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const origin = env.A2SITE_SITE_ORIGIN ?? 'http://localhost:3200';
  return {
    host: env.A2SITE_HOST ?? '0.0.0.0',
    port: parsePort(env.A2SITE_PORT),
    allowInsecureLocalhost: parseBoolean(env.A2SITE_ALLOW_INSECURE_LOCALHOST, true),
    manifest: {
      site: {
        id: env.A2SITE_SITE_ID ?? 'example-site',
        name: env.A2SITE_SITE_NAME ?? '示例网站',
        origin,
        description: env.A2SITE_SITE_DESCRIPTION ?? '一个支持外部 Agent 自动发现的网站',
        operator: env.A2SITE_OPERATOR_NAME,
      },
      endpoints: {
        manifest: A2SITE_MANIFEST_PATH,
      },
      actions: [{
        id: 'a2site.manifest.read',
        title: '读取网站能力清单',
        description: '读取网站提供给外部 Agent 的机器可读能力、端点和风险要求',
        method: 'GET',
        endpoint: A2SITE_MANIFEST_PATH,
        risk: 'low',
        requires_auth: false,
        requires_human_confirmation: false,
      }],
    },
  };
}
