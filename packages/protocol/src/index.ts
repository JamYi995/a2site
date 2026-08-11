import { z } from 'zod';

export const A2SITE_SCHEMA_VERSION = '1.0' as const;
export const A2SITE_WELL_KNOWN_PATH = '/.well-known/a2site.json' as const;
export const A2SITE_COMPATIBLE_WELL_KNOWN_PATH = '/.well-known/agent-site.json' as const;
export const A2SITE_MANIFEST_PATH = '/api/a2site/v1/manifest' as const;

const slugPattern = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

const relativeOrAbsoluteHttpUrlSchema = z.string().min(1).superRefine((value, context) => {
  if (value.startsWith('/')) {
    if (value.startsWith('//')) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: '相对地址不能以 // 开头' });
    }
    return;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: '必须是绝对 HTTP(S) 地址或以 / 开头的站内地址' });
    return;
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: '仅支持 HTTP(S) 地址' });
  }
  if (url.username || url.password) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: '地址不能包含用户名或密码' });
  }
  if (url.hash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: '地址不能包含 fragment' });
  }
});

export const actionRiskSchema = z.enum(['low', 'medium', 'high']);

export const actionSchema = z.object({
  id: z.string().regex(slugPattern, '能力 id 必须是稳定的小写标识'),
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(1000),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  endpoint: relativeOrAbsoluteHttpUrlSchema,
  risk: actionRiskSchema,
  requires_auth: z.boolean(),
  requires_human_confirmation: z.boolean(),
  input_schema: z.record(z.unknown()).optional(),
  output_schema: z.record(z.unknown()).optional(),
}).superRefine((action, context) => {
  if (action.risk === 'high' && !action.requires_human_confirmation) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requires_human_confirmation'],
      message: '高风险能力必须要求独立人工确认',
    });
  }
});

export const siteManifestInputSchema = z.object({
  schema_version: z.literal(A2SITE_SCHEMA_VERSION).default(A2SITE_SCHEMA_VERSION),
  site: z.object({
    id: z.string().regex(slugPattern, '网站 id 必须是稳定的小写标识'),
    name: z.string().min(1).max(120),
    origin: z.string().url(),
    description: z.string().max(1000).optional(),
    operator: z.string().max(200).optional(),
    privacy_url: relativeOrAbsoluteHttpUrlSchema.optional(),
    terms_url: relativeOrAbsoluteHttpUrlSchema.optional(),
  }),
  agent: z.object({
    audience: z.literal('external_agents').default('external_agents'),
    platform_provides_agent: z.literal(false).default(false),
  }).default({ audience: 'external_agents', platform_provides_agent: false }),
  endpoints: z.object({
    manifest: relativeOrAbsoluteHttpUrlSchema.default(A2SITE_MANIFEST_PATH),
    identity: relativeOrAbsoluteHttpUrlSchema.optional(),
    confirmations: relativeOrAbsoluteHttpUrlSchema.optional(),
    feedback: relativeOrAbsoluteHttpUrlSchema.optional(),
  }),
  actions: z.array(actionSchema).max(500).default([]),
});

export type A2SiteAction = z.infer<typeof actionSchema>;
export type A2SiteManifestInput = z.input<typeof siteManifestInputSchema>;

export interface A2SiteManifest {
  schema_version: typeof A2SITE_SCHEMA_VERSION;
  site: {
    id: string;
    name: string;
    origin: string;
    description?: string;
    operator?: string;
    privacy_url?: string;
    terms_url?: string;
  };
  agent: {
    audience: 'external_agents';
    platform_provides_agent: false;
  };
  endpoints: {
    manifest: string;
    identity?: string;
    confirmations?: string;
    feedback?: string;
  };
  actions: Array<Omit<A2SiteAction, 'endpoint'> & { endpoint: string }>;
}

export interface CreateManifestOptions {
  allowInsecureLocalhost?: boolean;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

function parseSiteOrigin(value: string, options: CreateManifestOptions): URL {
  const origin = new URL(value);
  if (origin.username || origin.password || origin.search || origin.hash) {
    throw new Error('site.origin 不能包含账号密码、查询参数或 fragment');
  }
  if (origin.pathname !== '/' && origin.pathname !== '') {
    throw new Error('site.origin 只能包含协议、域名和端口');
  }
  if (origin.protocol !== 'https:') {
    const localAllowed = options.allowInsecureLocalhost === true
      && origin.protocol === 'http:'
      && isLoopbackHostname(origin.hostname);
    if (!localAllowed) {
      throw new Error('site.origin 必须使用 HTTPS；只有显式允许的本机开发地址可以使用 HTTP');
    }
  }
  return origin;
}

function absoluteUrl(value: string, origin: URL): string {
  const result = new URL(value, origin);
  if (!['http:', 'https:'].includes(result.protocol)) {
    throw new Error('端点仅支持 HTTP(S) 地址');
  }
  if (result.username || result.password || result.hash) {
    throw new Error('端点不能包含账号密码或 fragment');
  }
  return result.toString();
}

export function createSiteManifest(
  value: A2SiteManifestInput,
  options: CreateManifestOptions = {},
): A2SiteManifest {
  const parsed = siteManifestInputSchema.parse(value);
  const origin = parseSiteOrigin(parsed.site.origin, options);

  const site: A2SiteManifest['site'] = {
    id: parsed.site.id,
    name: parsed.site.name,
    origin: origin.origin,
  };
  if (parsed.site.description !== undefined) site.description = parsed.site.description;
  if (parsed.site.operator !== undefined) site.operator = parsed.site.operator;
  if (parsed.site.privacy_url !== undefined) site.privacy_url = absoluteUrl(parsed.site.privacy_url, origin);
  if (parsed.site.terms_url !== undefined) site.terms_url = absoluteUrl(parsed.site.terms_url, origin);

  const endpoints: A2SiteManifest['endpoints'] = {
    manifest: absoluteUrl(parsed.endpoints.manifest, origin),
  };
  if (parsed.endpoints.identity !== undefined) endpoints.identity = absoluteUrl(parsed.endpoints.identity, origin);
  if (parsed.endpoints.confirmations !== undefined) endpoints.confirmations = absoluteUrl(parsed.endpoints.confirmations, origin);
  if (parsed.endpoints.feedback !== undefined) endpoints.feedback = absoluteUrl(parsed.endpoints.feedback, origin);

  return {
    schema_version: A2SITE_SCHEMA_VERSION,
    site,
    agent: parsed.agent,
    endpoints,
    actions: parsed.actions.map((action) => ({
      ...action,
      endpoint: absoluteUrl(action.endpoint, origin),
    })),
  };
}

export function parseSiteManifest(
  value: unknown,
  options: CreateManifestOptions = {},
): A2SiteManifest {
  return createSiteManifest(siteManifestInputSchema.parse(value), options);
}
