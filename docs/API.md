# CreditLedger REST API Reference

Base URL: `/api` (health check exposed at `GET /health`).
Protected endpoints require `Authorization: Bearer <jwt>` or the `cl_access` HTTP-only cookie, plus `Idempotency-Key` headers on retry-sensitive state mutations.

---

## 1. Health & Authentication (`/api/auth`)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | Public | Liveness and PostgreSQL/Redis readiness probe |
| `GET` | `/api/auth/challenge` | Public | Generates single-use 256-bit challenge nonce stored in Redis (`5m` TTL) |
| `POST` | `/api/auth/login` | Public | Verifies Ed25519 signature (raw or SEP-0053), consumes challenge via atomic `GETDEL`/Lua, issues 15m JWT + rotating refresh token |
| `POST` | `/api/auth/refresh` | Cookie/Body | Rotates single-use refresh token and revokes token family on replay reuse |
| `POST` | `/api/auth/logout` | User JWT | Revokes active `jti` blocklist entry & user refresh session family |

---

## 2. Credit Scoring, Attestations & Privacy (`/api/credit-score`)

| Method | Path | Auth / Role | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/credit-score/issuer/register` | Admin | Registers an authorized financial issuer & Ed25519 key on Soroban |
| `POST` | `/api/credit-score/issuer/revoke` | Admin | Revokes issuer (`revoked_for_cause = true`) on Soroban |
| `POST` | `/api/credit-score/issuer/build-message` | Issuer / Admin | Builds domain-separated `CREDITLEDGER-ATTEST-V1` payload hex for off-chain Ed25519 signing |
| `POST` | `/api/credit-score/attestations/prepare` | Owner JWT | Encrypts private financial metadata with `AES-256-GCM` in PostgreSQL & prepares unsigned Soroban `submit_signed_attestation` XDR |
| `POST` | `/api/credit-score/prepare-supplementary` | Owner JWT | Prepares unsigned `submit_self_reported_record` XDR (strictly **0% score weight**) |
| `POST` | `/api/credit-score/submit-transaction` | Owner JWT | Submits Freighter-signed CreditScore XDR and records `stellar_transactions` ledger receipt |
| `GET` | `/api/credit-score/:userPublicKey` | Owner / Admin | Queries authoritative on-chain score and updates `score_snapshots` |
| `GET` | `/api/credit-score/:userPublicKey/breakdown` | Owner / Admin | Returns itemized `Model v2` pillar scores (`35/25/20/10/10`) and penalty breakdown |
| `GET` | `/api/credit-score/:userPublicKey/records` | Owner JWT | Decrypts owner's off-chain private evidence commitments |
| `GET` | `/api/credit-score/:userPublicKey/trends` | Owner / Admin | Returns persisted historical score snapshots from PostgreSQL |
| `POST` | `/api/credit-score/:userPublicKey/consent` | Owner JWT | Grants scoped selective disclosure consent to an authorized verifier |
| `POST` | `/api/credit-score/:userPublicKey/consent/:grantId/revoke` | Owner JWT | Revokes an active selective disclosure grant |
| `GET` | `/api/credit-score/:userPublicKey/disclose/:grantId` | Grantee JWT | Retrieves permitted non-PII claims (`ssn`, `accountNumber`, `email`, etc. strictly stripped) |
| `DELETE` | `/api/credit-score/:userPublicKey/privacy` | Owner JWT | Deletes owner's off-chain encrypted financial records and logs audit erasure event |

---

## 3. Non-Custodial Loans & Lender Liquidity Pool (`/api/loans`)

| Method | Path | Auth / Role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/loans/pool` | User JWT | Reads live Soroban liquidity pool cash, outstanding principal, total shares, and earned interest |
| `GET` | `/api/loans/lender/:lenderPublicKey` | Owner / Admin | Reads lender's redeemable pool balance in stroops & XLM |
| `POST` | `/api/loans/check-eligibility` | User JWT | Checks authoritative on-chain credit score (`>= 50`), tier limit, and mandatory collateral (`125%` if score `50..59`) |
| `POST` | `/api/loans/prepare-deposit` | Lender Role (`403` otherwise) | Prepares unsigned Soroban `deposit_liquidity` XDR (`7`-decimal stroops validated) |
| `POST` | `/api/loans/prepare-withdraw` | Lender Role | Prepares unsigned Soroban `withdraw_liquidity` XDR |
| `POST` | `/api/loans/prepare-apply` | Owner JWT | Validates eligibility/collateral LTV and prepares unsigned `create_loan` XDR |
| `POST` | `/api/loans/prepare-cancel` | Owner JWT | Prepares unsigned `cancel_loan` XDR for pending loans (refunds locked collateral) |
| `POST` | `/api/loans/prepare-repay` | Owner JWT | Prepares unsigned `repay_loan` XDR |
| `POST` | `/api/loans/submit` | Owner JWT + `Idempotency-Key` | Submits signed `LoanManager` XDR, confirms on Soroban, updates `loans` / `lender_positions` |
| `GET` | `/api/loans/user/:userPublicKey` | Owner / Admin | Lists user's loans |
| `GET` | `/api/loans/:loanId` | Owner / Admin | Reads loan details & schedule |
| `GET` | `/api/loans/admin/active` | Admin | Lists pending & active loans governance queue |
| `GET` | `/api/loans/admin/statistics` | Admin | Fetches on-chain loan counters & pool stats |
| `POST` | `/api/loans/admin/reconcile` | Admin | Reconciles `pending` `stellar_transactions` against Soroban RPC |
| `POST` | `/api/loans/:loanId/approve` | Admin + `Idempotency-Key` | Disburses pool cash for pending loan |
| `POST` | `/api/loans/:loanId/default` | Admin + `Idempotency-Key` | Executes overdue `mark_default` liquidation & vouch slashing (`LoanNotYetDue` prior to due date + grace) |

---

## 4. Escrowed Community Vouching (`/api/vouch`) & User Summary (`/api/users`)

| Method | Path | Auth / Role | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/vouch/prepare-create` | Owner JWT | Prepares unsigned `create_vouch` SEP-41 escrow XDR (policy trust calculated on-chain) |
| `POST` | `/api/vouch/:vouchId/prepare-revoke` | Owner JWT | Prepares unsigned `revoke_vouch` escrow refund XDR |
| `POST` | `/api/vouch/:vouchId/prepare-expire` | Owner / Admin | Prepares unsigned `expire_vouch` XDR once `expiration_date` passes |
| `POST` | `/api/vouch/:vouchId/prepare-withdraw` | Owner JWT | Prepares unsigned `withdraw_remaining_escrow` CEI reclaim XDR |
| `POST` | `/api/vouch/submit` | Owner JWT + `Idempotency-Key` | Submits Freighter-signed vouch XDR and syncs `vouches` state |
| `GET` | `/api/vouch/user/:userPublicKey` | Owner / Admin | Lists given and received vouches |
| `GET` | `/api/users/:publicKey/profile` | Owner / Admin | Returns authenticated profile metadata |
| `GET` | `/api/users/:publicKey/summary` | Owner / Admin | Returns unified dashboard score, active loans, pool, and vouch summary |
