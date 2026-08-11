import {
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { z } from 'zod';
import type { A2SiteDatabase, SqlClient } from '@a2site/database';

const emailSchema = z.string().trim().email().max(254).transform((value) => value.toLowerCase());
const nameSchema = z.string().trim().min(1).max(80);
const siteIdSchema = z.string().trim().min(1).max(64).regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/);
const clientTypeSchema = z.string().trim().min(1).max(50).regex(/^[a-z0-9._-]+$/i);
const scopeSchema = z.string().trim().min(3).max(100).regex(/^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$/);
const uuidSchema = z.string().uuid();
const otpSchema = z.string().regex(/^\d{6}$/);

export class IdentityError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'IdentityError';
  }
}

export interface OtpEmail {
  challengeId: string;
  recipient: string;
  code: string;
  expiresAt: Date;
  siteId: string;
}

export interface EmailSender {
  readonly deliveryKind: string;
  sendOtp(input: OtpEmail): Promise<void>;
}

export class ConsoleEmailSender implements EmailSender {
  readonly deliveryKind = 'host_console';

  async sendOtp(input: OtpEmail): Promise<void> {
    const [local = '', domain = ''] = input.recipient.split('@');
    const masked = `${local.slice(0, 2)}***@${domain}`;
    console.warn(`[A2Site 本地验证码] ${masked} code=${input.code} challenge=${input.challengeId}`);
  }
}

export class MemoryEmailSender implements EmailSender {
  readonly deliveryKind = 'test_memory';
  readonly messages: OtpEmail[] = [];

  async sendOtp(input: OtpEmail): Promise<void> {
    this.messages.push(input);
  }

  latestCode(): string {
    const message = this.messages.at(-1);
    if (!message) throw new Error('没有测试验证码');
    return message.code;
  }
}

export interface VerifiedAccount {
  subjectId: string;
}

export interface SiteAccountAdapter {
  resolveVerifiedEmail(
    client: SqlClient,
    input: { siteId: string; email: string },
  ): Promise<VerifiedAccount>;
}

export class DatabaseSiteAccountAdapter implements SiteAccountAdapter {
  async resolveVerifiedEmail(
    client: SqlClient,
    input: { siteId: string; email: string },
  ): Promise<VerifiedAccount> {
    const rows = await client.query<{ subject_id: string }>(
      `INSERT INTO a2site_site_accounts(site_id,subject_id,email)
       VALUES($1,$2,$3)
       ON CONFLICT(site_id,email) DO UPDATE SET updated_at=NOW()
       RETURNING subject_id`,
      [input.siteId, randomUUID(), input.email],
    );
    const row = rows[0];
    if (!row) throw new IdentityError(500, 'ACCOUNT_RESOLUTION_FAILED', '网站账号解析失败');
    return { subjectId: row.subject_id };
  }
}

export interface IdentityServiceOptions {
  siteId: string;
  hashSecret: string;
  allowedScopes: string[];
  defaultScopes: string[];
  claimTtlMinutes?: number;
  otpTtlMinutes?: number;
  credentialTtlDays?: number;
  maxOtpAttempts?: number;
  accountAdapter?: SiteAccountAdapter;
}

export interface AgentCredential {
  credentialId: string;
  agentId: string;
  siteId: string;
  subjectId: string;
  agentName: string;
  clientType: string;
  scopes: string[];
  expiresAt: Date;
}

interface ClaimRow extends Record<string, unknown> {
  id: string;
  site_id: string;
  email: string;
  agent_name: string;
  client_type: string;
  requested_scopes: unknown;
  claim_secret_hash: string;
  status: string;
  agent_identity_id: string | null;
  expires_at: Date | string;
}

interface ChallengeRow extends Record<string, unknown> {
  id: string;
  claim_id: string;
  code_hash: string;
  status: string;
  attempts: number;
  max_attempts: number;
  expires_at: Date | string;
}

interface CredentialRow extends Record<string, unknown> {
  credential_id: string;
  agent_id: string;
  site_id: string;
  subject_id: string;
  agent_name: string;
  client_type: string;
  scopes: unknown;
  expires_at: Date | string;
  credential_status: string;
  agent_status: string;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function stringArray(value: unknown): string[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class IdentityService {
  private readonly siteId: string;
  private readonly hashSecret: string;
  private readonly allowedScopes: Set<string>;
  private readonly defaultScopes: string[];
  private readonly claimTtlMinutes: number;
  private readonly otpTtlMinutes: number;
  private readonly credentialTtlDays: number;
  private readonly maxOtpAttempts: number;
  private readonly accountAdapter: SiteAccountAdapter;

  constructor(
    private readonly database: A2SiteDatabase,
    private readonly emailSender: EmailSender,
    options: IdentityServiceOptions,
  ) {
    this.siteId = siteIdSchema.parse(options.siteId);
    if (Buffer.byteLength(options.hashSecret) < 32) {
      throw new Error('A2Site 身份哈希密钥至少需要 32 字节');
    }
    this.hashSecret = options.hashSecret;
    this.allowedScopes = new Set(options.allowedScopes.map((scope) => scopeSchema.parse(scope)));
    this.defaultScopes = options.defaultScopes.map((scope) => scopeSchema.parse(scope));
    if (this.defaultScopes.some((scope) => !this.allowedScopes.has(scope))) {
      throw new Error('默认作用域必须包含在允许作用域中');
    }
    this.claimTtlMinutes = options.claimTtlMinutes ?? 30;
    this.otpTtlMinutes = options.otpTtlMinutes ?? 10;
    this.credentialTtlDays = options.credentialTtlDays ?? 30;
    this.maxOtpAttempts = options.maxOtpAttempts ?? 5;
    this.accountAdapter = options.accountAdapter ?? new DatabaseSiteAccountAdapter();
  }

  async createClaim(input: {
    email: unknown;
    agentName: unknown;
    clientType?: unknown;
    requestedScopes?: unknown;
    remoteAddress?: string;
  }): Promise<Record<string, unknown>> {
    const email = this.parse(emailSchema, input.email, 'INVALID_EMAIL', '请输入有效邮箱');
    const agentName = this.parse(nameSchema, input.agentName, 'INVALID_AGENT_NAME', 'Agent 名称无效');
    const clientType = this.parse(clientTypeSchema, input.clientType ?? 'generic', 'INVALID_CLIENT_TYPE', 'Agent 客户端类型无效').toLowerCase();
    const scopes = this.resolveScopes(input.requestedScopes);
    const source = this.source(input.remoteAddress);
    await this.consumeRateLimit(`claim:email:${email}`, 10, 3_600);
    await this.consumeRateLimit(`claim:ip:${source}`, 60, 3_600);

    const claimId = randomUUID();
    const claimSecret = `a2c_${randomBytes(24).toString('base64url')}`;
    const expiresAt = new Date(Date.now() + this.claimTtlMinutes * 60_000);
    await this.database.query(
      `INSERT INTO a2site_agent_claims(
         id,site_id,email,agent_name,client_type,requested_scopes,claim_secret_hash,expires_at
       ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
      [claimId, this.siteId, email, agentName, clientType, JSON.stringify(scopes), this.hash('claim', claimSecret), expiresAt],
    );
    await this.audit('agent_claim', claimId, 'claim.create', 'agent_claim', claimId, 'success', { scopes });

    return {
      claim_id: claimId,
      claim_secret: claimSecret,
      status: 'pending',
      expires_at: expiresAt,
      next: {
        method: 'POST',
        endpoint: `/api/a2site/v1/identity/claims/${claimId}/challenges`,
        claim_secret_header: 'X-A2Site-Claim-Secret',
      },
      message: '认领密钥只返回一次，请由 Agent 临时安全保存',
    };
  }

  async sendChallenge(input: {
    claimId: unknown;
    claimSecret: unknown;
    remoteAddress?: string;
  }): Promise<Record<string, unknown>> {
    const claim = await this.requireClaim(input.claimId, input.claimSecret);
    this.assertClaimPending(claim);
    const source = this.source(input.remoteAddress);
    await this.consumeRateLimit(`otp:claim:${claim.id}`, 3, 3_600);
    await this.consumeRateLimit(`otp:email:${claim.email}`, 5, 3_600);
    await this.consumeRateLimit(`otp:ip:${source}`, 30, 3_600);

    const challengeId = randomUUID();
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const expiresAt = new Date(Date.now() + this.otpTtlMinutes * 60_000);
    await this.database.transaction(async (client) => {
      await client.query(
        `UPDATE a2site_email_challenges SET status='replaced'
         WHERE claim_id=$1 AND status='pending'`,
        [claim.id],
      );
      await client.query(
        `INSERT INTO a2site_email_challenges(
           id,claim_id,code_hash,max_attempts,expires_at
         ) VALUES($1,$2,$3,$4,$5)`,
        [challengeId, claim.id, this.hash(`otp:${challengeId}`, code), this.maxOtpAttempts, expiresAt],
      );
    });

    try {
      await this.emailSender.sendOtp({
        challengeId,
        recipient: claim.email,
        code,
        expiresAt,
        siteId: this.siteId,
      });
    } catch (error) {
      await this.database.query(
        `UPDATE a2site_email_challenges SET status='delivery_failed'
         WHERE id=$1 AND status='pending'`,
        [challengeId],
      );
      throw new IdentityError(503, 'EMAIL_DELIVERY_FAILED', '验证码暂时无法发送，请稍后重试');
    }

    await this.audit('agent_claim', claim.id, 'otp.send', 'email_challenge', challengeId, 'success');
    return {
      challenge_id: challengeId,
      expires_at: expiresAt,
      delivery: this.emailSender.deliveryKind,
      message: `验证码已发送，${this.otpTtlMinutes} 分钟内有效；验证码必须由 Agent 提交`,
    };
  }

  async verifyClaim(input: {
    claimId: unknown;
    claimSecret: unknown;
    challengeId: unknown;
    code: unknown;
    remoteAddress?: string;
  }): Promise<Record<string, unknown>> {
    const claim = await this.requireClaim(input.claimId, input.claimSecret);
    this.assertClaimPending(claim);
    const challengeId = this.parse(uuidSchema, input.challengeId, 'INVALID_CHALLENGE_ID', '验证码编号无效');
    const code = this.parse(otpSchema, input.code, 'INVALID_OTP_FORMAT', '验证码必须是六位数字');
    const source = this.source(input.remoteAddress);
    await this.consumeRateLimit(`otp:verify:email:${claim.email}`, 20, 3_600);
    await this.consumeRateLimit(`otp:verify:ip:${source}`, 60, 3_600);

    const accessToken = `a2s_${randomBytes(32).toString('base64url')}`;
    const tokenHash = this.hash('credential', accessToken);
    const expiresAt = new Date(Date.now() + this.credentialTtlDays * 86_400_000);
    const result = await this.database.transaction(async (client) => {
      const claims = await client.query<ClaimRow>(
        'SELECT * FROM a2site_agent_claims WHERE id=$1 AND site_id=$2 FOR UPDATE',
        [claim.id, this.siteId],
      );
      const lockedClaim = claims[0];
      if (!lockedClaim) throw new IdentityError(404, 'CLAIM_NOT_FOUND', '没有找到这次 Agent 认领');
      this.assertClaimPending(lockedClaim);

      const challenges = await client.query<ChallengeRow>(
        'SELECT * FROM a2site_email_challenges WHERE id=$1 AND claim_id=$2 FOR UPDATE',
        [challengeId, lockedClaim.id],
      );
      const challenge = challenges[0];
      if (!challenge) throw new IdentityError(404, 'CHALLENGE_NOT_FOUND', '验证码请求不存在');
      if (challenge.status !== 'pending') {
        throw new IdentityError(409, 'CHALLENGE_NOT_ACTIVE', '验证码已经使用、被替换或发送失败');
      }
      if (asDate(challenge.expires_at).getTime() <= Date.now()) {
        throw new IdentityError(410, 'CHALLENGE_EXPIRED', '验证码已经过期，请重新发送');
      }
      if (challenge.attempts >= challenge.max_attempts) {
        throw new IdentityError(429, 'CHALLENGE_LOCKED', '验证码尝试次数已用完，请重新发送');
      }

      const expected = this.hash(`otp:${challenge.id}`, code);
      if (!secureEqual(challenge.code_hash, expected)) {
        const updated = await client.query<{ attempts: number; max_attempts: number }>(
          `UPDATE a2site_email_challenges SET attempts=attempts+1
           WHERE id=$1 RETURNING attempts,max_attempts`,
          [challenge.id],
        );
        const attempts = updated[0]?.attempts ?? challenge.max_attempts;
        return {
          invalidOtp: true as const,
          remaining: Math.max(0, challenge.max_attempts - attempts),
        };
      }

      const account = await this.accountAdapter.resolveVerifiedEmail(client, {
        siteId: this.siteId,
        email: lockedClaim.email,
      });
      const agentId = randomUUID();
      const credentialId = randomUUID();
      await client.query(
        `INSERT INTO a2site_agent_identities(
           id,site_id,subject_id,origin_claim_id,name,client_type
         ) VALUES($1,$2,$3,$4,$5,$6)`,
        [agentId, this.siteId, account.subjectId, lockedClaim.id, lockedClaim.agent_name, lockedClaim.client_type],
      );
      await client.query(
        `INSERT INTO a2site_agent_credentials(
           id,agent_identity_id,token_hash,token_hint,scopes,expires_at
         ) VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
        [credentialId, agentId, tokenHash, accessToken.slice(0, 12), JSON.stringify(stringArray(lockedClaim.requested_scopes)), expiresAt],
      );
      await client.query(
        `UPDATE a2site_email_challenges SET status='consumed',consumed_at=NOW()
         WHERE id=$1`,
        [challenge.id],
      );
      await client.query(
        `UPDATE a2site_agent_claims
         SET status='token_issued',agent_identity_id=$1,token_issued_at=NOW(),updated_at=NOW()
         WHERE id=$2`,
        [agentId, lockedClaim.id],
      );
      await this.auditWith(client, 'agent_claim', agentId, 'credential.issue', 'agent_credential', credentialId, 'success', {
        scopes: stringArray(lockedClaim.requested_scopes),
      });
      return {
        invalidOtp: false as const,
        agentId,
        credentialId,
        subjectId: account.subjectId,
        scopes: stringArray(lockedClaim.requested_scopes),
      };
    });

    if (result.invalidOtp) {
      throw new IdentityError(
        result.remaining === 0 ? 429 : 400,
        result.remaining === 0 ? 'CHALLENGE_LOCKED' : 'INVALID_OTP',
        result.remaining === 0 ? '验证码尝试次数已用完，请重新发送' : `验证码不正确，还可尝试 ${result.remaining} 次`,
      );
    }

    return {
      claim_id: claim.id,
      status: 'token_issued',
      agent_id: result.agentId,
      credential_id: result.credentialId,
      subject_id: result.subjectId,
      token_type: 'Bearer',
      access_token: accessToken,
      scopes: result.scopes,
      expires_at: expiresAt,
      message: '请立即以 0600 权限保存凭证，系统不会再次显示明文',
    };
  }

  async authenticateAgent(authorization: unknown): Promise<AgentCredential> {
    const header = typeof authorization === 'string' ? authorization.trim() : '';
    const match = /^Bearer\s+(a2s_[A-Za-z0-9_-]+)$/i.exec(header);
    if (!match?.[1]) throw new IdentityError(401, 'AGENT_TOKEN_REQUIRED', '需要有效的 Agent Bearer 凭证');
    const rows = await this.database.query<CredentialRow>(
      `SELECT c.id AS credential_id,a.id AS agent_id,a.site_id,a.subject_id,
              a.name AS agent_name,a.client_type,c.scopes,c.expires_at,
              c.status AS credential_status,a.status AS agent_status
       FROM a2site_agent_credentials c
       JOIN a2site_agent_identities a ON a.id=c.agent_identity_id
       WHERE c.token_hash=$1 AND a.site_id=$2`,
      [this.hash('credential', match[1]), this.siteId],
    );
    const row = rows[0];
    if (!row || row.credential_status !== 'active' || row.agent_status !== 'active') {
      throw new IdentityError(401, 'AGENT_TOKEN_INVALID', 'Agent 凭证无效或已经撤销');
    }
    if (asDate(row.expires_at).getTime() <= Date.now()) {
      await this.database.query(
        `UPDATE a2site_agent_credentials SET status='expired'
         WHERE id=$1 AND status='active'`,
        [row.credential_id],
      );
      throw new IdentityError(401, 'AGENT_TOKEN_EXPIRED', 'Agent 凭证已经过期');
    }
    await this.database.query(
      'UPDATE a2site_agent_credentials SET last_used_at=NOW() WHERE id=$1',
      [row.credential_id],
    );
    return {
      credentialId: row.credential_id,
      agentId: row.agent_id,
      siteId: row.site_id,
      subjectId: row.subject_id,
      agentName: row.agent_name,
      clientType: row.client_type,
      scopes: stringArray(row.scopes),
      expiresAt: asDate(row.expires_at),
    };
  }

  async getMe(authorization: unknown): Promise<Record<string, unknown>> {
    const credential = await this.authenticateAgent(authorization);
    return {
      agent_id: credential.agentId,
      credential_id: credential.credentialId,
      site_id: credential.siteId,
      subject_id: credential.subjectId,
      agent_name: credential.agentName,
      client_type: credential.clientType,
      scopes: credential.scopes,
      expires_at: credential.expiresAt,
    };
  }

  async rotateCredential(authorization: unknown): Promise<Record<string, unknown>> {
    const current = await this.authenticateAgent(authorization);
    const accessToken = `a2s_${randomBytes(32).toString('base64url')}`;
    const credentialId = randomUUID();
    const expiresAt = new Date(Date.now() + this.credentialTtlDays * 86_400_000);
    await this.database.transaction(async (client) => {
      const locked = await client.query<{ id: string; status: string }>(
        'SELECT id,status FROM a2site_agent_credentials WHERE id=$1 FOR UPDATE',
        [current.credentialId],
      );
      if (locked[0]?.status !== 'active') {
        throw new IdentityError(409, 'CREDENTIAL_NOT_ACTIVE', '当前凭证已经轮换或撤销');
      }
      await client.query(
        `INSERT INTO a2site_agent_credentials(
           id,agent_identity_id,token_hash,token_hint,scopes,expires_at,rotated_from_id
         ) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`,
        [credentialId, current.agentId, this.hash('credential', accessToken), accessToken.slice(0, 12), JSON.stringify(current.scopes), expiresAt, current.credentialId],
      );
      await client.query(
        `UPDATE a2site_agent_credentials SET status='rotated',rotated_at=NOW()
         WHERE id=$1`,
        [current.credentialId],
      );
      await this.auditWith(client, 'agent', current.agentId, 'credential.rotate', 'agent_credential', credentialId, 'success', {
        rotated_from_id: current.credentialId,
      });
    });
    return {
      credential_id: credentialId,
      token_type: 'Bearer',
      access_token: accessToken,
      scopes: current.scopes,
      expires_at: expiresAt,
      message: '新凭证只显示一次；保存成功后删除旧凭证',
    };
  }

  async revokeCredential(authorization: unknown, reasonValue?: unknown): Promise<Record<string, unknown>> {
    const current = await this.authenticateAgent(authorization);
    const reason = typeof reasonValue === 'string' && reasonValue.trim()
      ? reasonValue.trim().slice(0, 300)
      : 'self_revoked';
    await this.database.transaction(async (client) => {
      const updated = await client.query<{ id: string }>(
        `UPDATE a2site_agent_credentials
         SET status='revoked',revoked_at=NOW(),revoked_reason=$2
         WHERE id=$1 AND status='active' RETURNING id`,
        [current.credentialId, reason],
      );
      if (!updated[0]) throw new IdentityError(409, 'CREDENTIAL_NOT_ACTIVE', '当前凭证已经轮换或撤销');
      await this.auditWith(client, 'agent', current.agentId, 'credential.revoke', 'agent_credential', current.credentialId, 'success', { reason });
    });
    return { credential_id: current.credentialId, status: 'revoked' };
  }

  requireScope(credential: AgentCredential, scope: string): void {
    if (!credential.scopes.includes(scope)) {
      throw new IdentityError(403, 'AGENT_SCOPE_REQUIRED', `需要 Agent 权限：${scope}`);
    }
  }

  private async requireClaim(claimIdValue: unknown, claimSecretValue: unknown): Promise<ClaimRow> {
    const claimId = this.parse(uuidSchema, claimIdValue, 'INVALID_CLAIM_ID', '认领编号无效');
    const claimSecret = typeof claimSecretValue === 'string' ? claimSecretValue.trim() : '';
    if (!/^a2c_[A-Za-z0-9_-]{20,}$/.test(claimSecret)) {
      throw new IdentityError(401, 'INVALID_CLAIM_SECRET', '认领密钥无效');
    }
    const rows = await this.database.query<ClaimRow>(
      'SELECT * FROM a2site_agent_claims WHERE id=$1 AND site_id=$2',
      [claimId, this.siteId],
    );
    const claim = rows[0];
    if (!claim) throw new IdentityError(404, 'CLAIM_NOT_FOUND', '没有找到这次 Agent 认领');
    if (!secureEqual(claim.claim_secret_hash, this.hash('claim', claimSecret))) {
      throw new IdentityError(401, 'INVALID_CLAIM_SECRET', '认领密钥无效');
    }
    if (claim.status === 'pending' && asDate(claim.expires_at).getTime() <= Date.now()) {
      await this.database.query(
        `UPDATE a2site_agent_claims SET status='expired',updated_at=NOW()
         WHERE id=$1 AND status='pending'`,
        [claim.id],
      );
      claim.status = 'expired';
    }
    return claim;
  }

  private assertClaimPending(claim: ClaimRow): void {
    if (asDate(claim.expires_at).getTime() <= Date.now()) {
      throw new IdentityError(410, 'CLAIM_EXPIRED', 'Agent 认领已经过期');
    }
    if (claim.status === 'token_issued') {
      throw new IdentityError(409, 'CREDENTIAL_ALREADY_ISSUED', '凭证已经签发，明文不会再次显示');
    }
    if (claim.status !== 'pending') {
      throw new IdentityError(409, 'CLAIM_NOT_PENDING', '当前 Agent 认领不能继续');
    }
  }

  private resolveScopes(value: unknown): string[] {
    let requested: string[];
    if (value === undefined) {
      requested = [...this.defaultScopes];
    } else {
      const parsed = z.array(scopeSchema).min(1).max(30).safeParse(value);
      if (!parsed.success) {
        throw new IdentityError(400, 'INVALID_SCOPES', 'Agent 请求的权限格式无效');
      }
      requested = parsed.data;
    }
    const unique = [...new Set(requested)];
    const forbidden = unique.filter((scope) => !this.allowedScopes.has(scope));
    if (forbidden.length > 0) {
      throw new IdentityError(403, 'SCOPE_NOT_ALLOWED', '网站没有开放所请求的 Agent 权限', { forbidden_scopes: forbidden });
    }
    return unique;
  }

  private parse<T>(schema: z.ZodType<T>, value: unknown, code: string, message: string): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new IdentityError(400, code, message);
    return parsed.data;
  }

  private source(value?: string): string {
    return value?.trim().slice(0, 200) || 'unknown';
  }

  private hash(purpose: string, value: string): string {
    return createHmac('sha256', this.hashSecret).update(`${purpose}:${value}`).digest('hex');
  }

  private async consumeRateLimit(key: string, limit: number, windowSeconds: number): Promise<void> {
    const now = Date.now();
    const bucket = Math.floor(now / (windowSeconds * 1000));
    const counterKey = `${this.siteId}:${key}:${bucket}`;
    const expiresAt = new Date((bucket + 2) * windowSeconds * 1000);
    const rows = await this.database.query<{ value: number }>(
      `INSERT INTO a2site_rate_limit_counters(key,value,expires_at)
       VALUES($1,1,$2)
       ON CONFLICT(key) DO UPDATE SET value=a2site_rate_limit_counters.value+1,updated_at=NOW()
       RETURNING value`,
      [counterKey, expiresAt],
    );
    if ((rows[0]?.value ?? limit + 1) > limit) {
      throw new IdentityError(429, 'RATE_LIMITED', '请求过于频繁，请稍后重试', {
        retry_after_seconds: Math.max(1, Math.ceil(((bucket + 1) * windowSeconds * 1000 - now) / 1000)),
      });
    }
  }

  private audit(
    actorType: string,
    actorId: string,
    action: string,
    resourceType: string,
    resourceId: string,
    outcome: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    return this.auditWith(this.database, actorType, actorId, action, resourceType, resourceId, outcome, metadata);
  }

  private async auditWith(
    client: SqlClient,
    actorType: string,
    actorId: string,
    action: string,
    resourceType: string,
    resourceId: string,
    outcome: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await client.query(
      `INSERT INTO a2site_identity_events(
         id,site_id,actor_type,actor_id,action,resource_type,resource_id,outcome,metadata
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [randomUUID(), this.siteId, actorType, actorId, action, resourceType, resourceId, outcome, JSON.stringify(metadata)],
    );
  }
}
