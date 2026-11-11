# Security Policy & Threat Model

## 1. Reporting Vulnerabilities

If you discover a security vulnerability in CreditLedger, do **not** open a public issue with exploit details before triage. Report findings privately via GitHub Security Advisories or direct maintainer security contact.

---

## 2. Implemented Security Controls

### Smart Contracts (`contracts/`)
- **Authenticated Single Initialization & Two-Step Admin Transfer**: `initialize(...)` requires `admin.require_auth()` and rejects re-initialization (`AlreadyInitialized`). Ownership rotation requires `propose_admin` (current admin) followed by explicit `accept_admin` (pending admin).
- **Pause Emergency Circuit Breaker**: `pause` / `unpause` halts value-transferring or state-mutating paths across `CreditScore`, `LoanManager`, and `CommunityVouch`.
- **Cryptographic Attestation Integrity**: Authoritative credit score inputs require either an authorized issuer address (`require_auth()`) or an on-chain verified Ed25519 signature (`env.crypto().ed25519_verify`) bound to contract address, subject, `attestation_id`, and `record_commitment`.
- **Self-Report Isolation**: `submit_self_reported_record` carries **0%** scoring weight and cannot bypass verification.
- **Issuer Compromise Recovery**: `revoke_issuer` invalidates attestations from compromised issuers (`revoked_for_cause = true`); dual-signed `rotate_issuer_key` replaces compromised keys while preserving valid historical attestations.
- **Escrow & Lending Custody Invariants**:
  - `LoanManager` executes real SEP-41 token transfers, tracks committed cash vs uncommitted `available_cash`, amortizes interest/fees prior to principal, and enforces bounded liquidation (`+5%` buffer) with surplus collateral refunds.
  - `CommunityVouch` enforces real SEP-41 token escrow, derives trust weight strictly on-chain, prevents duplicate active pairs, applies Checks-Effects-Interactions (`escrowed_balance = 0`, `withdrawn = true`) before external transfers, and caps borrower-default slashing at `50%` (`MAX_SLASH_BPS = 5_000`).

### Backend & Privacy (`backend/`)
- **Challenge Replay Resistance**: Single-use 256-bit challenges stored in Redis and consumed atomically via `GETDEL` / Lua script (`consumeChallengeNonce`). Fails closed (`503`) in production if Redis is offline.
- **Freighter Wallet Signatures (Raw & SEP-0053)**: Verifies Ed25519 signatures over raw challenge bytes and Stellar SEP-0053 prefixed SHA-256 digests without any bypass fallback.
- **Session Rotation & Revocation**: 15-minute `HS256` JWTs (`issuer: 'creditledger-api'`) with JTI revocation on logout/rotation plus single-use rotating refresh tokens with reuse-attack family revocation (`revokeSessionFamily`).
- **Role-Based Access Control & IDOR Prevention**: Privileged routes enforce `requireAdmin` or `requireRoles('issuer', 'admin')` from server-side `ADMIN_PUBLIC_KEYS` / `ISSUER_PUBLIC_KEYS` allowlists; user routes enforce owner-or-admin checks (`403`).
- **Fail-Closed Secret Validation**: Production startup throws if `JWT_SECRET`, `DATA_ENCRYPTION_KEY`, or a non-default `DB_PASSWORD` is missing.
- **At-Rest Privacy & Selective Disclosure**: Off-chain financial payloads are encrypted via `AES-256-GCM`, stripped of forbidden PII keys (`ssn`, `iban`, `accountNumber`, `phoneNumber`, `email`, `fullName`, `address`) during selective disclosure, erasable via `DELETE /api/credit-score/:key/privacy`, and scrubbed from logs (`redactSensitiveForLogs`).
- **Idempotency & Reconciliation**: Mutating preparation/submission endpoints honor `Idempotency-Key` with SHA-256 payload conflict detection (`409`); `reconcilePendingTransactions` synchronizes PostgreSQL `stellar_transactions` against Soroban RPC.

### Frontend & Infrastructure
- **Strictly Non-Custodial Wallet Signing**: Unsigned XDRs are built via `rpc.prepareTransaction` and signed only client-side in Freighter (`signTransaction`).
- **Strict Secret Hygiene & Headers**: `.env` files are excluded via `.gitignore`; `docker-compose.yml` requires explicit environment variables without default weak credentials; `frontend/nginx.conf` enforces strict `Content-Security-Policy` (no `http:` connect sources), `X-Frame-Options: DENY`, and `frame-ancestors 'none'`.

---

## 3. Production Security Boundaries & Preconditions

CreditLedger has completed automated unit, integration, browser E2E, and Stellar Testnet contract verification, **not** an independent third-party smart contract audit. Before any Stellar Mainnet deployment:
1. Obtain a formal third-party audit of all three Soroban Rust crates.
2. Replace any hot backend `STELLAR_ADMIN_SECRET` with multisig / HSM / KMS governance custody.
3. Enforce TLS termination at ingress/load balancer and configure automated encrypted PostgreSQL PITR backups.
