# Security Policy — CreditLedger

## Supported Versions

Only the latest release on the `main` branch is actively supported with security updates.

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0.0 | :x:                |

---

## Security Architecture & Threat Model

CreditLedger implements a decentralized, non-custodial credit scoring and lending architecture built on the Stellar network with Soroban smart contracts:

1. **Non-Custodial Authorization**:
   - User actions (applying for loans, repaying loans, issuing community vouches, revoking vouches, updating alternative financial data) are signed directly by the user's Stellar wallet (e.g., Freighter) using their private key.
   - The backend service does not hold, access, or escrow user private keys.
   - Administrative keys (`STELLAR_ADMIN_SECRET`) are strictly constrained to administrative operations (`approve_loan`, `mark_default`) and are never used to impersonate borrowers.

2. **Replay & Impersonation Protection**:
   - Authentication challenges are cryptographically generated, tracked with single-use nonce consumption, and expired after a 5-minute time-to-live (TTL).
   - Signatures are verified directly against Ed25519 public keys using the Stellar SDK.
   - JWT sessions are signed with a high-entropy secret, scoped to the verified public key, and set to expire within 24 hours.

3. **Smart Contract Invariants**:
   - Scores operate strictly on a deterministic **0–100 scale**.
   - Loan eligibility enforces a minimum credit score of 50. Borrowers with scores below 60 require collateral.
   - Duplicate repayments, excess repayments beyond the outstanding balance, and repayments against non-active loans are rejected with explicit contract errors.
   - Vouch revocations dynamically trigger score recalculations in the credit scoring contract.

4. **Privacy & Data Minimization**:
   - Raw payment histories and savings records are submitted directly by users or verified through cryptographic state proofs.
   - Sensitive session data, internal database identifiers, and unhashed credentials are never logged to stdout or files.

---

## Reporting a Vulnerability

If you discover a potential security vulnerability within CreditLedger, please report it responsibly:

1. **Do not** create public GitHub issues or discussions for unpatched security vulnerabilities.
2. Email the maintainers at `security@creditledger.io` (or reach out via GitHub Security Advisories if enabled).
3. Include the following details:
   - Affected component (Smart Contract, Backend API, Frontend UI, Database Migration).
   - Step-by-step reproduction instructions or proof-of-concept.
   - Assessment of potential exploitability and financial/data impact.
4. The security team will acknowledge receipt within 48 hours and provide a remediation timeline.
