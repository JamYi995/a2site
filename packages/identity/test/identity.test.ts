import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, runMigrations, type A2SiteDatabase } from '@a2site/database';
import {
  IDENTITY_MIGRATIONS,
  IdentityError,
  IdentityService,
  MemoryEmailSender,
} from '../src/index.js';

const HASH_SECRET = 'test-only-a2site-hash-secret-that-is-longer-than-32-bytes';

describe('IdentityService', () => {
  let database: A2SiteDatabase;
  let email: MemoryEmailSender;
  let service: IdentityService;

  beforeEach(async () => {
    database = await createDatabase();
    await runMigrations(database, IDENTITY_MIGRATIONS);
    email = new MemoryEmailSender();
    service = new IdentityService(database, email, {
      siteId: 'test-site',
      hashSecret: HASH_SECRET,
      allowedScopes: ['manifest:read', 'identity:read'],
      defaultScopes: ['manifest:read', 'identity:read'],
    });
  });

  afterEach(async () => {
    await database.close();
  });

  async function connectAgent() {
    const claim = await service.createClaim({
      email: 'User@Example.com',
      agentName: 'Codex on Mac',
      clientType: 'codex',
      remoteAddress: '127.0.0.1',
    });
    const challenge = await service.sendChallenge({
      claimId: claim.claim_id,
      claimSecret: claim.claim_secret,
      remoteAddress: '127.0.0.1',
    });
    const issued = await service.verifyClaim({
      claimId: claim.claim_id,
      claimSecret: claim.claim_secret,
      challengeId: challenge.challenge_id,
      code: email.latestCode(),
      remoteAddress: '127.0.0.1',
    });
    return { claim, challenge, issued };
  }

  it('由 Agent 完成邮箱验证码连接并只获得允许的作用域', async () => {
    const { issued } = await connectAgent();
    expect(issued.access_token).toMatch(/^a2s_/);
    expect(issued.scopes).toEqual(['manifest:read', 'identity:read']);

    const me = await service.getMe(`Bearer ${issued.access_token}`);
    expect(me).toMatchObject({
      site_id: 'test-site',
      agent_name: 'Codex on Mac',
      client_type: 'codex',
      scopes: ['manifest:read', 'identity:read'],
    });
    expect(me).not.toHaveProperty('email');
  });

  it('错误验证码会持久累计并最终锁定', async () => {
    const claim = await service.createClaim({ email: 'otp@example.com', agentName: 'Hermes' });
    const challenge = await service.sendChallenge({
      claimId: claim.claim_id,
      claimSecret: claim.claim_secret,
    });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(service.verifyClaim({
        claimId: claim.claim_id,
        claimSecret: claim.claim_secret,
        challengeId: challenge.challenge_id,
        code: '999999' === email.latestCode() ? '888888' : '999999',
      })).rejects.toMatchObject({
        code: attempt === 5 ? 'CHALLENGE_LOCKED' : 'INVALID_OTP',
      });
    }
    await expect(service.verifyClaim({
      claimId: claim.claim_id,
      claimSecret: claim.claim_secret,
      challengeId: challenge.challenge_id,
      code: email.latestCode(),
    })).rejects.toMatchObject({ code: 'CHALLENGE_LOCKED' });
  });

  it('同一次认领不会第二次显示明文凭证', async () => {
    const { claim, challenge } = await connectAgent();
    await expect(service.verifyClaim({
      claimId: claim.claim_id,
      claimSecret: claim.claim_secret,
      challengeId: challenge.challenge_id,
      code: email.latestCode(),
    })).rejects.toMatchObject({ code: 'CREDENTIAL_ALREADY_ISSUED' });
  });

  it('轮换凭证后旧凭证立即失效', async () => {
    const { issued } = await connectAgent();
    const oldToken = String(issued.access_token);
    const rotated = await service.rotateCredential(`Bearer ${oldToken}`);
    expect(rotated.access_token).toMatch(/^a2s_/);
    await expect(service.getMe(`Bearer ${oldToken}`))
      .rejects.toMatchObject({ code: 'AGENT_TOKEN_INVALID' });
    await expect(service.getMe(`Bearer ${rotated.access_token}`)).resolves.toMatchObject({
      agent_id: issued.agent_id,
    });
  });

  it('Agent 可以撤销自己的当前凭证', async () => {
    const { issued } = await connectAgent();
    const authorization = `Bearer ${issued.access_token}`;
    await expect(service.revokeCredential(authorization, 'device_removed')).resolves.toMatchObject({
      status: 'revoked',
    });
    await expect(service.getMe(authorization))
      .rejects.toMatchObject({ code: 'AGENT_TOKEN_INVALID' });
  });

  it('拒绝网站未开放的作用域', async () => {
    await expect(service.createClaim({
      email: 'scope@example.com',
      agentName: 'Agent',
      requestedScopes: ['admin:write'],
    })).rejects.toBeInstanceOf(IdentityError);
    await expect(service.createClaim({
      email: 'scope@example.com',
      agentName: 'Agent',
      requestedScopes: ['admin:write'],
    })).rejects.toMatchObject({ code: 'SCOPE_NOT_ALLOWED' });
  });

  it('身份和凭证保存在数据库中，可被新的服务实例继续认证', async () => {
    const { issued } = await connectAgent();
    const restarted = new IdentityService(database, new MemoryEmailSender(), {
      siteId: 'test-site',
      hashSecret: HASH_SECRET,
      allowedScopes: ['manifest:read', 'identity:read'],
      defaultScopes: ['manifest:read', 'identity:read'],
    });
    await expect(restarted.getMe(`Bearer ${issued.access_token}`)).resolves.toMatchObject({
      agent_id: issued.agent_id,
    });
  });
});
