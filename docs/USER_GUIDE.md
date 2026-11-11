# CreditLedger User & Reviewer Guide

## 1. Prerequisites for Local Evaluation

- **Stellar Network**: Strictly **Stellar Testnet** (`Test SDF Network ; September 2015`). Do **not** use Mainnet keys or real funds.
- **Wallet**: Install the Freighter browser extension, switch Freighter to **Testnet**, and fund the Testnet account via [Stellar Friendbot](https://friendbot.stellar.org).
- **Local Services**:
  - Contracts: Rust toolchain with `wasm32v1-none` target (`rustup target add wasm32v1-none`)
  - Backend/Frontend: Node.js `>= 20` (CI uses Node `22`), PostgreSQL `15`, Redis `7` (optional for backend unit tests via in-memory fallback, required for `TEST_REQUIRE_DB=1` and production mode).

---

## 2. Role Workflows in the DApp

### A. Connecting Your Wallet (`/login`)
1. Open the app and navigate to **Connect Wallet**.
2. Choose your primary UI mode (`borrower` or `lender`; privileged `admin` and `issuer` capabilities are assigned strictly on the backend allowlist `ADMIN_PUBLIC_KEYS` / `ISSUER_PUBLIC_KEYS`).
3. Click **Connect & Sign with Freighter** and approve the `signMessage` prompt in Freighter.
4. If you decline signing in Freighter, login aborts immediately and an accessible error alert appears without issuing a session token.

### B. Checking Credit Score, Attestations & Privacy (`/credit-score`)
1. View your **Model v2** breakdown (`0–100`) across the 5 weighted pillars (`35% Payment History`, `25% Savings`, `20% Loan Repayment`, `10% Community Vouching`, `10% Verified Activity`) and any `-25/default` penalties.
2. **Supplementary Self-Reports**: Optionally anchor a self-reported receipt hash on-chain. The UI clearly marks this as **0% authoritative score weight**.
3. **Selective Disclosure**: Enter a verifier's Stellar public key (`G...`) and approved non-PII claim fields to generate a scoped consent grant (`Grant Selective Consent`) or revoke it immediately (`Revoke Latest Grant`). Sensitive PII (`ssn`, `accountNumber`, `email`) is stripped server-side.
4. **Right to Erasure**: Click **Erase Off-Chain Private Data** and confirm to permanently purge encrypted off-chain evidence rows from PostgreSQL while keeping non-PII on-chain commitments untouched.

### C. Borrowing & Collateral (`/loans`)
1. Enter your loan amount (`XLM`), term (`1–60 months`), and collateral amount.
2. Click **Check Eligibility & LTV Collateral**:
   - Score `< 50`: **Ineligible**.
   - Score `50–59`: **Base Tier (`15% APR`)** — must lock **>= 125%** collateral (`MAX_LTV_BPS = 8000`) in SEP-41 XLM.
   - Score `60–79` / `80+`: Uncollateralized **Standard (`12%` / `10% APR`)** or **Prime (`8% APR`)** up to tier debt cap.
3. Click **Prepare & Sign Loan Application** and sign the Soroban transaction in Freighter. You may cancel `pending` loans anytime to refund locked collateral, or repay active loans incrementally/in full.

### D. Lending Liquidity (`/lender`)
1. Review pool `Available Cash`, `Outstanding Principal`, and cumulative `Interest Earned`.
2. Deposit or withdraw XLM into/from the shared Soroban pool (`Withdraw Liquidity` cannot exceed uncommitted `Available Cash` or your redeemable pool share balance).

### E. Escrowed Community Vouching (`/vouch`)
1. Stake real XLM escrow behind another borrower (`G...`). You cannot choose the trust score manually; trust weight (`<= 100`) is enforced by on-chain policy and decays linearly over the vouch lifetime.
2. Revoke an active vouch after cooldown or reclaim any remaining unslashed escrow if a borrower defaults.

### F. Admin & Attestation Issuer Portal (`/admin`)
- Accessible solely to allowlisted `admin` and `issuer` wallets (`403` and UI notice otherwise).
- Admins approve pending loans (disbursing pool cash), trigger overdue defaults (once `due_date + 3 days` grace expires), reconcile pending Stellar transactions, and manage the authorized issuer registry.
- Issuers generate domain-separated `CREDITLEDGER-ATTEST-V1` payloads for borrowers to relay non-custodially via `submit_signed_attestation`.
