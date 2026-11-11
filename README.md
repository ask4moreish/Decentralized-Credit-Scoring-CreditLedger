# CreditLedger — Decentralized Credit Scoring & Non-Custodial Lending on Stellar Soroban

CreditLedger is an attestation-backed decentralized credit scoring, SEP-41 liquidity pool lending, LTV-collateralized borrowing, and escrowed community vouching platform built on **Stellar Soroban**.

## Architecture Highlights

1. **Verifiable On-Chain Credit Scoring (`Model v2`)**:
   - Computes `0..=100` scores from Ed25519-signed/issuer-attested payment and savings records (`35% / 25%`), on-chain Soroban loan outcomes (`20%` minus `-25` per default), escrowed community vouches (`10%`), and verified activity breadth (`10%`).
   - Isolates self-reported user submissions (`submit_self_reported_record`) at **0% authoritative weight**.
2. **Real SEP-41 Token Lending & Fair Liquidation (`LoanManager`)**:
   - Lenders deposit/withdraw real tokens (`Native XLM SAC` / SEP-41) via proportional pool share accounting.
   - Base-tier loans (scores `50–59`) require `>= 125%` collateralization (`MAX_LTV_BPS = 8000`); prime/standard/growth tiers (`60+`) qualify for uncollateralized borrowing at `8% / 10% / 12% / 15%` APR.
   - Repayments amortize late fees and scheduled interest prior to principal; defaults liquidate collateral up to debt + `5%` buffer (`LIQUIDATION_BONUS_BPS = 500`), refunding any surplus and triggering bounded default slashing on active vouches.
3. **Escrowed Community Vouching (`CommunityVouch`)**:
   - Holds real SEP-41 escrow tokens per vouch, calculates trust weights on-chain from policy rather than caller inputs, applies linear time decay, enforces Checks-Effects-Interactions anti-double-withdraw, and caps slashing at `50%` per default.
4. **Non-Custodial API & Selective Privacy (`backend/`)**:
   - Ed25519 challenge-response authentication (supporting raw signatures and Freighter SEP-0053) with atomic Redis `GETDEL` / Lua nonces and fail-closed production guards.
   - 15-minute `HS256` JWTs + rotating single-use refresh tokens with reuse-attack family revocation, `jti` blocklisting, and RBAC (`borrower`, `lender`, `issuer`, `admin`).
   - `AES-256-GCM` encryption at rest for private evidence commitments, owner-managed selective disclosure consent grants, and log redaction.
5. **Non-Custodial React + Freighter DApp (`frontend/`)**:
   - Unsigned Soroban transactions built via `rpc.prepareTransaction` and signed exclusively client-side in Freighter across Borrower Loans, Lender Pool, Credit Score & Privacy, Community Vouch, and Admin/Issuer governance workflows.

---

## Stellar Testnet Deployments

- **Hardened v2 Deployment**: [`TESTNET_DEPLOYMENT_EVIDENCE.md`](TESTNET_DEPLOYMENT_EVIDENCE.md) & [`contracts/deployed-testnet-hardened.json`](contracts/deployed-testnet-hardened.json)
  - `CreditScore`: `CAAPEEPQJH5ZQHOYOF3KVHQNUGZV5DVPUSE4KCAKJ3E3NQGEYQ53ZUTW`
  - `LoanManager`: `CB4KYCG62B62RNMIGHV2NP5GDCGPGE23XW5FQVOTBE266PFPKKB5NNXB`
  - `CommunityVouch`: `CAQSXBETHWHNXF5BJV37CVD2AI4D4JTVZ3J2S3YLTAPUF5V7BWFV444F`
  - `Native XLM SAC`: `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`
- **Legacy v1 Prototype (Preserved Untouched)**:
  - `CBYH6SQZBYC7MWH4QF6FRGCKH2SW5EQD24RLK3EKOTMM5EYSQB7J65BZ`, `CDO44SYFPU7SCP4BFTJTWFL2Z7BDB4MVOSSUSW6JUXSPB37ZIAZ7FHKA`, `CCZNGFWUX5YFTRP7Y2N7I4TFTNS6YV4243NZ62LLQXGSXLIQTB2XP552`

---

## Quick Verification Commands

```bash
# Smart contracts
cd contracts && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test && cargo build --target wasm32v1-none --release

# Backend API
cd backend && npm run build && npm run lint && npm test -- --ci --forceExit

# Frontend & Browser E2E
cd frontend && npm run lint && npm test -- --run && npm run build && npm run test:e2e

# Non-mutating Testnet verification check
node scripts/testnet-deploy-and-verify.mjs
```

---

## Developer & Reviewer Guides

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — System & sequence Mermaid diagrams, cross-contract boundaries, and design constraints
- [`docs/API.md`](docs/API.md) — Complete authenticated & non-custodial REST endpoint reference
- [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) — Borrower, Lender, Community Voucher, Issuer, and Admin workflows
- [`DEPLOYMENT.md`](DEPLOYMENT.md) | [`SECURITY.md`](SECURITY.md)

## Audit, Verification & Hardening Documentation

- [`INITIAL_SECURITY_AND_ARCHITECTURE_AUDIT.md`](INITIAL_SECURITY_AND_ARCHITECTURE_AUDIT.md)
- [`INDEPENDENT_SMART_CONTRACT_SECURITY_REVIEW.md`](INDEPENDENT_SMART_CONTRACT_SECURITY_REVIEW.md) *(internal adversarial review)*
- [`CREDIT_SCORING_MODEL_VALIDATION.md`](CREDIT_SCORING_MODEL_VALIDATION.md)
- [`FINANCIAL_INTEGRATION_REPORT.md`](FINANCIAL_INTEGRATION_REPORT.md)
- [`TESTNET_DEPLOYMENT_EVIDENCE.md`](TESTNET_DEPLOYMENT_EVIDENCE.md)
- [`TESTNET_END_TO_END_VERIFICATION.md`](TESTNET_END_TO_END_VERIFICATION.md)
- [`INFRASTRUCTURE_AND_PRIVACY_VERIFICATION.md`](INFRASTRUCTURE_AND_PRIVACY_VERIFICATION.md)
- [`FRONTEND_AND_WALLET_VERIFICATION.md`](FRONTEND_AND_WALLET_VERIFICATION.md)
- [`CI_CD_AND_DEPENDENCY_SECURITY_REPORT.md`](CI_CD_AND_DEPENDENCY_SECURITY_REPORT.md)
- [`FINAL_TECHNICAL_IMPROVEMENT_REPORT.md`](FINAL_TECHNICAL_IMPROVEMENT_REPORT.md)
- [`PRODUCTION_READINESS_ASSESSMENT.md`](PRODUCTION_READINESS_ASSESSMENT.md)
- [`CREDITLEDGER_COMPLETE_PROJECT_HARDENING_REPORT.md`](CREDITLEDGER_COMPLETE_PROJECT_HARDENING_REPORT.md)
