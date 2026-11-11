# Infrastructure, Database, Decimal Precision & Privacy Verification — CreditLedger

> Covers PostgreSQL Knex migrations, Redis atomic state, 7-decimal Stellar stroop precision, AES-256-GCM data encryption, selective disclosure, erasure, log redaction, and Docker/container readiness.

---

## 1. Local Infrastructure Availability Check

Executed locally on the Windows verification host (`Test-NetConnection` & `Get-Command`):
- **Docker / Compose**: Not installed / unavailable on this workstation (`Get-Command docker` empty).
- **Local PostgreSQL (`127.0.0.1:5432`)**: Not running (`TcpTestSucceeded = False`).
- **Local Redis (`127.0.0.1:6379`)**: Not running (`TcpTestSucceeded = False`).

### Consequences & Honest Verification Scope
- **Local `docker compose up -d --build` & live container restoration**: **`BLOCKED BY EXTERNAL REQUIREMENT` locally** due to absence of a local Docker engine.
- **PostgreSQL & Redis CI Pipeline**: Configured cleanly in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) with `postgres:15-alpine` and `redis:7-alpine` health-checked service containers running:
  1. Reversible migration verification: `npx knex migrate:latest && npx knex migrate:rollback && npx knex migrate:latest`
  2. Live infrastructure integration suite: `TEST_REQUIRE_DB=1 npx jest src/__tests__/postgresRedis.integration.test.ts --ci --forceExit` ([`backend/src/__tests__/postgresRedis.integration.test.ts`](backend/src/__tests__/postgresRedis.integration.test.ts)).
  - **Note on Remote CI Status**: Prior CI push run `43096988463` on `ed4e5f9` was created during an active GitHub Actions `major_outage` (`2026-11-11T20:48:25Z` on `www.githubstatus.com`) and stayed `queued` with `0` jobs scheduled; therefore live remote Postgres 15 / Redis 7 CI execution of the new `TEST_REQUIRE_DB=1` suite remains **`IMPLEMENTED BUT NOT FULLY VERIFIED`** until CI runs post-push.

---

## 2. Database Schema & Persistence Integrity

All 12 schema tables and constraints across [`20261104000000_create_credit_ledger_tables.ts`](backend/migrations/20261104000000_create_credit_ledger_tables.ts) and [`20261111000000_harden_credit_ledger_platform.ts`](backend/migrations/20261111000000_harden_credit_ledger_platform.ts) compile cleanly under `tsc`:

- Core domain & caching: `users`, `credit_score_cache`, `score_snapshots`, `loans`, `lender_positions`, `vouches`
- Security & ops: `user_sessions` (single-use refresh hashes + token family revocation), `idempotency_keys` (payload hash + cached HTTP replay / `409 Conflict`), `stellar_transactions` (pending / confirmed / failed ledger reconciliation), `audit_logs`
- Privacy & consent: `encrypted_financial_records` (AES-256-GCM ciphertext, IV, 128-bit GCM authTag, SHA-256 commitment), `consent_grants` (grantee key, allowed claim scope, expiry, active/revoked status)

---

## 3. Financial Precision (`7`-Decimal Stellar Stroops)

Verified cleanly in [`backend/src/__tests__/amounts.test.ts`](backend/src/__tests__/amounts.test.ts) (`parseDecimalToStroops`, `parseNonNegativeStroops`, `parseRawU128String`, `formatStroopsToDecimal`):
- **Exact String-Split Fixed Point**: Avoids IEEE-754 floating-point errors (`parseDecimalToStroops('100.5') === '1005000000'`, `'0.0000001' === '1'`).
- **Validation Guards**: Rejects zero, negatives (`-10`), scientific notation (`1e5`), and precision past 7 decimals (`1.00000001`).
- **On-Chain `u128` Parity**: Backend serializes amounts to Soroban `u128` (`nativeToScVal(BigInt(stroops), { type: 'u128' })`), matching Soroban contract precision identically.

---

## 4. Cryptography, Privacy, Selective Disclosure & Erasure

Verified in [`backend/src/__tests__/privacyService.test.ts`](backend/src/__tests__/privacyService.test.ts) and [`backend/src/__tests__/creditScore.test.ts`](backend/src/__tests__/creditScore.test.ts):
1. **Encryption at Rest**: Private financial evidence submitted via `POST /api/credit-score/attestations/prepare` is encrypted using **AES-256-GCM** (`DATA_ENCRYPTION_KEY`, mandatory fail-closed in `NODE_ENV=production`) and verified on auth-tag tamper rejection; ciphertext never contains PII plaintext.
2. **Deterministic Commitments**: `canonicalJson` sorts keys prior to SHA-256 hashing so `record_commitment` matches deterministically across key orders.
3. **Selective Disclosure & PII Stripping**: `filterDisclosedClaims` strips sensitive PII fields (`ssn`, `accountNumber`, `email`, `fullName`) even if explicitly requested in `scope`, and `POST /consent` -> `POST /consent/:id/revoke` immediately enforces `403` after revocation and blocks unrelated grantee IDs (`403`).
4. **Right to Erasure (`DELETE /api/credit-score/:userPublicKey/privacy`)**: Permanently removes off-chain `encrypted_financial_records` for the owner and records a `private_records_erased` audit log entry (`audit_logs`), leaving only non-PII SHA-256 hashes/metrics on Soroban.
5. **Log Redaction**: `redactSensitiveForLogs` masks Stellar secret seeds (`S...`), Bearer JWTs, passwords, `signedXdr`, and nested `refreshToken` fields cleanly.
6. **Production Fail-Closed Guards (`auth.test.ts` + `middleware.test.ts`)**: Production mode returns `503` if Redis is unavailable for challenge nonce consumption, blocks missing `JWT_SECRET` / `DATA_ENCRYPTION_KEY`, enforces 15m JWT expiry + `jti` blocklist, and revokes entire refresh token families upon replay.

---

## 5. Verification Status Matrix

| Control Area | Status | Notes |
| --- | --- | --- |
| 7-decimal stroop math, AES-256-GCM, PII filtering, redaction, RBAC, session family revocation | **COMPLETED AND VERIFIED** | Proven by backend Jest suites (`amounts`, `auth`, `creditScore`, `idempotency`, `loan`, `middleware`, `nonCustodial`, `privacyService`, `reconciliation`) |
| Live PostgreSQL & Redis integration suite & CI service wiring | **IMPLEMENTED BUT NOT FULLY VERIFIED** | [`postgresRedis.integration.test.ts`](backend/src/__tests__/postgresRedis.integration.test.ts) & `.github/workflows/ci.yml` ready; awaits CI runner or container host with `TEST_REQUIRE_DB=1` |
| Local `docker compose` / live `pg_dump` backup-restore execution | **BLOCKED BY EXTERNAL REQUIREMENT** | No Docker engine, PostgreSQL, or Redis installed on local Windows verification machine |
