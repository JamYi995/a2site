import type { DatabaseMigration } from '@a2site/database';

export const IDENTITY_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS a2site_site_accounts (
  site_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(site_id,subject_id),
  UNIQUE(site_id,email)
);
CREATE TABLE IF NOT EXISTS a2site_agent_claims (
  id UUID PRIMARY KEY,
  site_id TEXT NOT NULL,
  email TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  client_type TEXT NOT NULL,
  requested_scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  claim_secret_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','token_issued','expired')),
  agent_identity_id UUID,
  expires_at TIMESTAMPTZ NOT NULL,
  token_issued_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_a2site_claims_email ON a2site_agent_claims(site_id,email,created_at DESC);
CREATE TABLE IF NOT EXISTS a2site_email_challenges (
  id UUID PRIMARY KEY,
  claim_id UUID NOT NULL REFERENCES a2site_agent_claims(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','consumed','replaced','delivery_failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_a2site_challenges_claim ON a2site_email_challenges(claim_id,created_at DESC);
CREATE TABLE IF NOT EXISTS a2site_agent_identities (
  id UUID PRIMARY KEY,
  site_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  origin_claim_id UUID NOT NULL UNIQUE REFERENCES a2site_agent_claims(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  client_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_a2site_agents_subject ON a2site_agent_identities(site_id,subject_id,created_at DESC);
ALTER TABLE a2site_agent_claims
  ADD CONSTRAINT a2site_claims_agent_identity_fk
  FOREIGN KEY(agent_identity_id) REFERENCES a2site_agent_identities(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_a2site_claims_agent_identity
  ON a2site_agent_claims(agent_identity_id) WHERE agent_identity_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS a2site_agent_credentials (
  id UUID PRIMARY KEY,
  agent_identity_id UUID NOT NULL REFERENCES a2site_agent_identities(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  token_hint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','rotated','revoked','expired')),
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  rotated_at TIMESTAMPTZ,
  rotated_from_id UUID REFERENCES a2site_agent_credentials(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_a2site_credentials_agent ON a2site_agent_credentials(agent_identity_id,created_at DESC);
CREATE TABLE IF NOT EXISTS a2site_identity_events (
  id UUID PRIMARY KEY,
  site_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  outcome TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_a2site_identity_events_resource ON a2site_identity_events(site_id,resource_type,resource_id,created_at DESC);
CREATE TABLE IF NOT EXISTS a2site_rate_limit_counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_a2site_rate_limits_expiry ON a2site_rate_limit_counters(expires_at);
`;

export const IDENTITY_MIGRATIONS: DatabaseMigration[] = [{
  id: '202608110100-identity',
  description: 'A2Site Agent identity, email challenge, credential and audit tables',
  sql: IDENTITY_MIGRATION_SQL,
}];
