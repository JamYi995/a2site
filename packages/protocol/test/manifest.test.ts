import { describe, expect, it } from 'vitest';
import {
  A2SITE_MANIFEST_PATH,
  createSiteManifest,
  parseSiteManifest,
} from '../src/index.js';

const baseManifest = {
  site: {
    id: 'demo-site',
    name: '示例网站',
    origin: 'https://example.com',
    privacy_url: '/privacy',
  },
  endpoints: {
    manifest: A2SITE_MANIFEST_PATH,
  },
  actions: [{
    id: 'content.read',
    title: '读取内容',
    description: '读取公开内容',
    method: 'GET' as const,
    endpoint: '/api/content',
    risk: 'low' as const,
    requires_auth: false,
    requires_human_confirmation: false,
  }],
};

describe('createSiteManifest', () => {
  it('将所有站内地址初始化为 Agent 可直接访问的绝对地址', () => {
    const manifest = createSiteManifest(baseManifest);

    expect(manifest.site.origin).toBe('https://example.com');
    expect(manifest.site.privacy_url).toBe('https://example.com/privacy');
    expect(manifest.endpoints.manifest).toBe('https://example.com/api/a2site/v1/manifest');
    expect(manifest.actions[0]?.endpoint).toBe('https://example.com/api/content');
    expect(manifest.agent).toEqual({ audience: 'external_agents', platform_provides_agent: false });
  });

  it('仅在显式允许时接受本机 HTTP 开发地址', () => {
    const local = {
      ...baseManifest,
      site: { ...baseManifest.site, origin: 'http://localhost:3200' },
    };

    expect(() => createSiteManifest(local)).toThrow(/HTTPS/);
    expect(createSiteManifest(local, { allowInsecureLocalhost: true }).site.origin)
      .toBe('http://localhost:3200');
  });

  it('拒绝没有独立人工确认的高风险能力', () => {
    const invalid = {
      ...baseManifest,
      actions: [{
        ...baseManifest.actions[0],
        id: 'order.pay',
        risk: 'high' as const,
        requires_human_confirmation: false,
      }],
    };

    expect(() => createSiteManifest(invalid)).toThrow(/高风险能力/);
  });

  it('可以再次解析已经绝对化的清单', () => {
    const manifest = createSiteManifest(baseManifest);
    expect(parseSiteManifest(manifest)).toEqual(manifest);
  });
});
