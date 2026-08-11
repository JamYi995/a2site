import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  A2SITE_MANIFEST_PATH,
  actionSchema,
  type A2SiteManifestInput,
} from '@a2site/protocol';

const MAX_ACTIONS_FILE_BYTES = 256 * 1024;
const RESERVED_ACTION_IDS = new Set([
  'a2site.manifest.read',
  'identity.claim.create',
  'identity.credential.rotate',
  'identity.credential.revoke',
]);

export interface GatewayConfig {
  host: string;
  port: number;
  trustedProxies: string[];
  allowInsecureLocalhost: boolean;
  nodeEnv: string;
  databaseUrl?: string;
  pglitePath: string;
  identity: {
    hashSecret: string;
    allowedScopes: string[];
    defaultScopes: string[];
    emailMode: 'console' | 'smtp';
    smtp?: {
      host: string;
      port: number;
      secure: boolean;
      user: string;
      password: string;
      fromAddress: string;
      fromName: string;
      replyTo?: string;
    };
  };
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

function parseScopes(value: string): string[] {
  const scopes = [...new Set(value.split(',').map((scope) => scope.trim()).filter(Boolean))];
  if (scopes.length === 0) throw new Error('Agent 作用域配置不能为空');
  return scopes;
}

function parseTrustedProxies(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean))];
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`邮件模式为 smtp 时必须配置 ${key}`);
  return value;
}

function parseSmtpPort(value: string | undefined): number {
  const port = Number(value ?? '587');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('SMTP_PORT 必须是 1 到 65535 之间的整数');
  }
  return port;
}

function loadActionsFile(value: string | undefined, isProduction: boolean) {
  if (!value?.trim()) return [];
  const configuredPath = value.trim();
  if (isProduction && !isAbsolute(configuredPath)) {
    throw new Error('生产环境的 A2SITE_ACTIONS_FILE 必须使用绝对路径');
  }

  const filePath = resolve(configuredPath);
  const pathStat = lstatSync(filePath);
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error('A2SITE_ACTIONS_FILE 必须是普通文件，不能是目录或符号链接');
  }

  let fileDescriptor: number;
  try {
    fileDescriptor = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new Error('A2SITE_ACTIONS_FILE 必须是可读取的普通文件，不能是符号链接');
  }

  let valueFromFile: unknown;
  try {
    const openedStat = fstatSync(fileDescriptor);
    if (!openedStat.isFile()) throw new Error('A2SITE_ACTIONS_FILE 必须是普通文件');
    if (openedStat.size > MAX_ACTIONS_FILE_BYTES) {
      throw new Error('A2SITE_ACTIONS_FILE 不能超过 256 KiB');
    }
    const source = readFileSync(fileDescriptor, 'utf8');
    try {
      valueFromFile = JSON.parse(source);
    } catch {
      throw new Error('A2SITE_ACTIONS_FILE 必须是有效 JSON');
    }
  } finally {
    closeSync(fileDescriptor);
  }

  const actions = actionSchema.array().max(100).parse(valueFromFile);
  const actionIds = new Set<string>();
  for (const action of actions) {
    if (!action.endpoint.startsWith('/') || action.endpoint.startsWith('//')) {
      throw new Error(`动作 ${action.id} 的 endpoint 必须是以 / 开头的站内地址`);
    }
    if (RESERVED_ACTION_IDS.has(action.id) || actionIds.has(action.id)) {
      throw new Error(`动作 id ${action.id} 重复或属于 A2Site 保留标识`);
    }
    actionIds.add(action.id);
  }
  return actions;
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const origin = env.A2SITE_SITE_ORIGIN ?? 'http://localhost:3200';
  const nodeEnv = env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';
  const databaseUrl = env.A2SITE_DATABASE_URL?.trim() || undefined;
  const hashSecret = env.A2SITE_AUTH_HASH_SECRET?.trim()
    || 'local-development-only-a2site-hash-secret-change-me';
  const allowedScopes = parseScopes(env.A2SITE_ALLOWED_SCOPES ?? 'manifest:read,identity:read');
  const defaultScopes = parseScopes(env.A2SITE_DEFAULT_SCOPES ?? 'manifest:read,identity:read');
  const emailMode = env.A2SITE_EMAIL_MODE?.trim() || 'console';
  const configuredActions = loadActionsFile(env.A2SITE_ACTIONS_FILE, isProduction);

  if (isProduction && !databaseUrl) {
    throw new Error('生产环境必须配置 A2SITE_DATABASE_URL，不能使用本地 PGlite');
  }
  if (isProduction && !env.A2SITE_AUTH_HASH_SECRET?.trim()) {
    throw new Error('生产环境必须显式配置 A2SITE_AUTH_HASH_SECRET');
  }
  if (emailMode !== 'console' && emailMode !== 'smtp') {
    throw new Error('A2SITE_EMAIL_MODE 只能是 console 或 smtp');
  }
  if (isProduction && emailMode !== 'smtp') {
    throw new Error('生产环境必须接入正式邮件发送适配器，不能把验证码输出到终端');
  }

  const smtp = emailMode === 'smtp'
    ? {
        host: required(env, 'SMTP_HOST'),
        port: parseSmtpPort(env.SMTP_PORT),
        secure: parseBoolean(env.SMTP_SECURE, false),
        user: required(env, 'SMTP_USER'),
        password: required(env, 'SMTP_PASSWORD'),
        fromAddress: required(env, 'EMAIL_FROM_ADDRESS'),
        fromName: env.EMAIL_FROM_NAME?.trim() || 'A2Site',
        ...(env.EMAIL_REPLY_TO?.trim() ? { replyTo: env.EMAIL_REPLY_TO.trim() } : {}),
      }
    : undefined;

  return {
    host: env.A2SITE_HOST ?? '0.0.0.0',
    port: parsePort(env.A2SITE_PORT),
    trustedProxies: parseTrustedProxies(env.A2SITE_TRUSTED_PROXIES),
    allowInsecureLocalhost: parseBoolean(env.A2SITE_ALLOW_INSECURE_LOCALHOST, true),
    nodeEnv,
    ...(databaseUrl ? { databaseUrl } : {}),
    pglitePath: env.A2SITE_PGLITE_PATH?.trim() || '.data/a2site',
    identity: {
      hashSecret,
      allowedScopes,
      defaultScopes,
      emailMode,
      ...(smtp ? { smtp } : {}),
    },
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
      actions: [
        {
          id: 'a2site.manifest.read',
          title: '读取网站能力清单',
          description: '读取网站提供给外部 Agent 的机器可读能力、端点和风险要求',
          method: 'GET',
          endpoint: A2SITE_MANIFEST_PATH,
          risk: 'low',
          requires_auth: false,
          requires_human_confirmation: false,
        },
        ...configuredActions,
      ],
    },
  };
}
