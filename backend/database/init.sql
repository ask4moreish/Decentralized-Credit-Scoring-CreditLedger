-- CreditLedger database schema
-- Run automatically by Docker on first start via docker-entrypoint-initdb.d

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users (mirrors on-chain identities)
CREATE TABLE IF NOT EXISTS users (
    public_key      VARCHAR(56) PRIMARY KEY,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cached credit scores (source of truth is on-chain; this is a read cache)
CREATE TABLE IF NOT EXISTS credit_score_cache (
    public_key              VARCHAR(56) PRIMARY KEY REFERENCES users(public_key) ON DELETE CASCADE,
    score                   INTEGER NOT NULL DEFAULT 0,
    payment_history_score   INTEGER NOT NULL DEFAULT 0,
    savings_score           INTEGER NOT NULL DEFAULT 0,
    community_score         INTEGER NOT NULL DEFAULT 0,
    activity_score          INTEGER NOT NULL DEFAULT 0,
    last_updated            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Loan records (mirrors on-chain state)
CREATE TABLE IF NOT EXISTS loans (
    id                  BIGINT PRIMARY KEY,
    borrower_public_key VARCHAR(56) NOT NULL REFERENCES users(public_key),
    amount              NUMERIC(30, 7) NOT NULL,
    interest_rate       INTEGER NOT NULL,
    duration_months     INTEGER NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'pending',
    credit_score_used   INTEGER NOT NULL DEFAULT 0,
    repaid_amount       NUMERIC(30, 7) NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    due_date            TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loans_borrower ON loans(borrower_public_key);
CREATE INDEX IF NOT EXISTS idx_loans_status   ON loans(status);

-- Vouch records (mirrors on-chain state)
CREATE TABLE IF NOT EXISTS vouches (
    id              BIGINT PRIMARY KEY,
    voucher_key     VARCHAR(56) NOT NULL REFERENCES users(public_key),
    vouchee_key     VARCHAR(56) NOT NULL REFERENCES users(public_key),
    amount          NUMERIC(30, 7) NOT NULL,
    trust_score     INTEGER NOT NULL,
    reason          TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expiration_date TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_vouches_voucher ON vouches(voucher_key);
CREATE INDEX IF NOT EXISTS idx_vouches_vouchee ON vouches(vouchee_key);
