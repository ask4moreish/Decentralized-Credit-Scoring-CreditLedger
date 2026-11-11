-- CreditLedger PostgreSQL Baseline Schema (Synchronized with Knex Migrations 20261104 & 20261111)

CREATE TABLE IF NOT EXISTS users (
  public_key VARCHAR(56) PRIMARY KEY,
  role VARCHAR(24) NOT NULL DEFAULT 'borrower',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS credit_score_cache (
  public_key VARCHAR(56) PRIMARY KEY REFERENCES users(public_key) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  payment_history_score INTEGER DEFAULT 0,
  savings_score INTEGER DEFAULT 0,
  repayment_score INTEGER NOT NULL DEFAULT 0,
  community_score INTEGER DEFAULT 0,
  activity_score INTEGER DEFAULT 0,
  model_version INTEGER NOT NULL DEFAULT 2,
  last_updated TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY,
  borrower_public_key VARCHAR(56) NOT NULL REFERENCES users(public_key) ON DELETE CASCADE,
  amount VARCHAR(40) NOT NULL,
  interest_rate INTEGER NOT NULL,
  duration_months INTEGER NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  repaid_amount VARCHAR(40) DEFAULT '0',
  credit_score_used INTEGER DEFAULT 0,
  collateral_amount VARCHAR(40) NOT NULL DEFAULT '0',
  collateral_locked BOOLEAN NOT NULL DEFAULT FALSE,
  principal_repaid VARCHAR(40) NOT NULL DEFAULT '0',
  interest_repaid VARCHAR(40) NOT NULL DEFAULT '0',
  scheduled_interest VARCHAR(40) NOT NULL DEFAULT '0',
  tx_hash VARCHAR(64),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vouches (
  id INTEGER PRIMARY KEY,
  voucher_key VARCHAR(56) NOT NULL REFERENCES users(public_key) ON DELETE CASCADE,
  vouchee_key VARCHAR(56) NOT NULL REFERENCES users(public_key) ON DELETE CASCADE,
  amount VARCHAR(40) NOT NULL,
  escrowed_balance VARCHAR(40) NOT NULL DEFAULT '0',
  slashed_amount VARCHAR(40) NOT NULL DEFAULT '0',
  trust_score INTEGER NOT NULL,
  reason TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  withdrawn BOOLEAN NOT NULL DEFAULT FALSE,
  tx_hash VARCHAR(64),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id VARCHAR(64) PRIMARY KEY,
  family_id VARCHAR(64) NOT NULL,
  public_key VARCHAR(56) NOT NULL REFERENCES users(public_key) ON DELETE CASCADE,
  role VARCHAR(24) NOT NULL DEFAULT 'borrower',
  refresh_token_hash VARCHAR(64) NOT NULL UNIQUE,
  access_jti VARCHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  replaced_by_session_id VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_family ON user_sessions(public_key, family_id);

CREATE TABLE IF NOT EXISTS encrypted_financial_records (
  id VARCHAR(64) PRIMARY KEY,
  owner_public_key VARCHAR(56) NOT NULL REFERENCES users(public_key) ON DELETE CASCADE,
  issuer_public_key VARCHAR(56),
  attestation_id VARCHAR(64),
  record_kind VARCHAR(24) NOT NULL,
  record_commitment VARCHAR(64) NOT NULL,
  ciphertext TEXT NOT NULL,
  iv VARCHAR(32) NOT NULL,
  auth_tag VARCHAR(32) NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_enc_records_owner ON encrypted_financial_records(owner_public_key, verified);

CREATE TABLE IF NOT EXISTS consent_grants (
  id VARCHAR(64) PRIMARY KEY,
  owner_public_key VARCHAR(56) NOT NULL REFERENCES users(public_key) ON DELETE CASCADE,
  grantee_public_key VARCHAR(56) NOT NULL,
  scope_json TEXT NOT NULL,
  record_ids_json TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_consent_pair ON consent_grants(owner_public_key, grantee_public_key);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id SERIAL PRIMARY KEY,
  idempotency_key VARCHAR(128) NOT NULL,
  actor_public_key VARCHAR(56) NOT NULL,
  route VARCHAR(128) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  status_code INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT uq_idempotency_actor_route_key UNIQUE (actor_public_key, route, idempotency_key)
);

CREATE TABLE IF NOT EXISTS stellar_transactions (
  tx_hash VARCHAR(64) PRIMARY KEY,
  operation_type VARCHAR(48) NOT NULL,
  actor_public_key VARCHAR(56) NOT NULL,
  contract_id VARCHAR(56),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  ledger_sequence BIGINT,
  amount_stroops VARCHAR(40) NOT NULL DEFAULT '0',
  metadata_json TEXT,
  reconciled_at TIMESTAMPTZ,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_stellar_tx_status ON stellar_transactions(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_stellar_tx_actor ON stellar_transactions(actor_public_key);

CREATE TABLE IF NOT EXISTS score_snapshots (
  id SERIAL PRIMARY KEY,
  public_key VARCHAR(56) NOT NULL REFERENCES users(public_key) ON DELETE CASCADE,
  model_version INTEGER NOT NULL DEFAULT 2,
  score INTEGER NOT NULL,
  payment_history_score INTEGER NOT NULL DEFAULT 0,
  savings_score INTEGER NOT NULL DEFAULT 0,
  repayment_score INTEGER NOT NULL DEFAULT 0,
  community_score INTEGER NOT NULL DEFAULT 0,
  activity_score INTEGER NOT NULL DEFAULT 0,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_score_snapshots_user_time ON score_snapshots(public_key, recorded_at);

CREATE TABLE IF NOT EXISTS lender_positions (
  lender_public_key VARCHAR(56) PRIMARY KEY REFERENCES users(public_key) ON DELETE CASCADE,
  shares_stroops VARCHAR(40) NOT NULL DEFAULT '0',
  deposited_stroops VARCHAR(40) NOT NULL DEFAULT '0',
  withdrawn_stroops VARCHAR(40) NOT NULL DEFAULT '0',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  actor_public_key VARCHAR(56),
  action VARCHAR(64) NOT NULL,
  resource_type VARCHAR(48),
  resource_id VARCHAR(128),
  status VARCHAR(24) NOT NULL,
  details_json TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_action_time ON audit_logs(action, created_at);
