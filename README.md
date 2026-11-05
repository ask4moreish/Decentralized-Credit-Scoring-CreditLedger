# CreditLedger — Decentralized Credit Scoring & Lending Protocol

CreditLedger is a decentralized finance (DeFi) protocol on the Stellar network that calculates transparent, on-chain credit scores from alternative financial data—including payment consistency, savings longevity, and community vouches. It enables underbanked individuals and Web3 participants to access under-collateralized borrowing based on verifiable reputation.

---

## Key Features

- **Deterministic Credit Scoring (0–100 Scale)**: Credit scores are calculated on-chain using a transparent, multi-factor algorithm bounded strictly between 0 and 100.
- **Non-Custodial Lending**: Borrowers interact directly through Freighter wallet authorization. No custodial escrow or backend private key custody.
- **Community Vouching Network**: Trusted peers vouch for each other with locked capital and trust ratings. Vouch revocations dynamically propagate to adjust credit scores.
- **Alternative Data Ingestion**: Accounts build credit reputation from recurring payments and savings behavior without requiring traditional credit bureau history.
- **PostgreSQL & Redis Architecture**: High-performance persistent storage with Knex migrations and Redis read-through caching.
- **Soroban Smart Contracts**: Rust-based contracts compiled to `wasm32-unknown-unknown` running natively on the Stellar Soroban runtime.

---

## Protocol Architecture

```
                  +-----------------------------------+
                  |         Freighter Wallet          |
                  |  (Client-side Ed25519 Signing)   |
                  +-----------------+-----------------+
                                    |
            1. Sign Tx (XDR)        |   2. Direct Submission / Prepare Tx
                                    v
+------------------------+  REST   +--------------------------+  RPC /   +--------------------------+
|  React 18 / Vite UI    |<------->|    Node.js / Express     |<-------->|  Stellar Soroban Network |
|  - 0-100 Score Display |         |    - Knex / PostgreSQL   |  Horizon |  - CreditScore (0-100)   |
|  - Loan Manager        |         |    - Redis Caching       |          |  - LoanManager           |
|  - Community Vouching  |         |    - Nonce Auth Exchange |          |  - CommunityVouch        |
+------------------------+         +--------------------------+          +--------------------------+
```

### Smart Contracts (`contracts/`)
1. **`credit_score`**: Computes weighted scores (`0..=100`) from payment history, savings duration, and active community vouches. Includes dynamic recalculation on vouch revocation (`remove_community_vouch`).
2. **`loan_manager`**: Handles loan origination, risk-tier APR assignment, collateral checks, and repayment accounting with overpayment prevention.
3. **`community_vouch`**: Manages peer-to-peer vouches, expiration dates, and cross-contract score synchronization.

### Scoring Methodology (0–100 Scale)

The credit score is computed deterministically with integer precision using four weighted pillars:

$$\text{Credit Score} = (0.40 \times \text{Payment}) + (0.30 \times \text{Savings}) + (0.20 \times \text{Community}) + (0.10 \times \text{Activity})$$

| Component | Weight | Criteria & Factors |
| :--- | :---: | :--- |
| **Payment History** | **40%** | Payment consistency score (0–100) and recurring frequency |
| **Savings Behavior**| **30%** | Savings duration in months and deposit regularity |
| **Community Vouches**| **20%** | Active vouches, voucher trust ratings, and vouched volume |
| **Account Activity**| **10%** | On-chain longevity and platform engagement metrics |

### Borrowing Tiers & Collateral Rules

| Score Range | Tier Classification | Interest Rate (APR) | Collateral Requirement |
| :---: | :---: | :---: | :---: |
| **80 – 100** | Prime | **8%** | **0% (Unsecured)** |
| **70 – 79** | Preferred | **10%** | **0% (Unsecured)** |
| **60 – 69** | Standard | **12%** | **0% (Unsecured)** |
| **50 – 59** | Base | **15%** | **Collateral Required** |
| **< 50** | Ineligible | N/A | **Application Rejected** |

---

## Quick Start

### Prerequisites
- [Rust](https://www.rust-lang.org/) `stable` with `wasm32-unknown-unknown` target
- [Node.js](https://nodejs.org/) `v20.x` or later
- [Docker](https://www.docker.com/) and Docker Compose
- [Freighter Wallet](https://www.freighter.app/) extension

### 1. Run with Docker Compose
```bash
# Clone the repository
git clone https://github.com/ask4moreish/Decentralized-Credit-Scoring-CreditLedger.git
cd Decentralized-Credit-Scoring-CreditLedger

# Start PostgreSQL, Redis, Backend, and Frontend
docker-compose up -d

# Verify service health
docker-compose ps
```

- **Frontend Application**: [http://localhost:3000](http://localhost:3000)
- **Backend API**: [http://localhost:3001](http://localhost:3001)
- **Health Endpoint**: [http://localhost:3001/health](http://localhost:3001/health)

### 2. Manual Development Setup

#### Smart Contracts
```bash
cd contracts
cargo test
cargo build --target wasm32-unknown-unknown --release
```

#### Backend API
```bash
cd backend
cp .env.example .env
npm ci
npx knex migrate:latest
npm run build
npm test
npm run dev
```

#### Frontend Application
```bash
cd frontend
cp .env.example .env
npm ci
npm test -- --run
npm run build
npm run dev
```

---

## API Specification

### Authentication & Nonces
- `GET  /api/auth/challenge` — Generates a cryptographically random, single-use challenge nonce (5 min TTL).
- `POST /api/auth/login` — Verifies Ed25519 signature of the challenge nonce and issues a JWT token.

### Credit Score
- `GET  /api/credit-score/:userPublicKey` — Retrieves cached or on-chain credit score (0–100 scale).
- `GET  /api/credit-score/:userPublicKey/breakdown` — Returns component score breakdown and factor weights.
- `GET  /api/credit-score/:userPublicKey/trends` — Returns empirical trend history and projections.
- `POST /api/credit-score/prepare-payment-history` — Generates unsigned XDR for payment history updates.
- `POST /api/credit-score/prepare-savings-data` — Generates unsigned XDR for savings data updates.
- `POST /api/credit-score/submit-transaction` — Submits client-signed XDR to the Stellar network.

### Loans
- `POST /api/loans/prepare-apply` — Validates score eligibility and returns unsigned loan creation XDR.
- `POST /api/loans/prepare-repay` — Verifies borrower ownership and returns unsigned repayment XDR.
- `POST /api/loans/submit` — Submits signed loan XDR, updates PostgreSQL, and clears cache.
- `GET  /api/loans/:loanId` — Retrieves loan details and status.
- `GET  /api/loans/user/:userPublicKey` — Retrieves paginated loan portfolio for a borrower.
- `POST /api/loans/:loanId/approve` — (*Admin only*) Approves a pending loan.
- `POST /api/loans/:loanId/default` — (*Admin only*) Marks a defaulted loan.

### Community Vouching
- `POST /api/vouch/prepare-create` — Generates unsigned XDR for vouch creation.
- `POST /api/vouch/:vouchId/prepare-revoke` — Generates unsigned XDR for vouch revocation.
- `POST /api/vouch/submit` — Submits signed vouch XDR to the network.
- `GET  /api/vouch/user/:userPublicKey` — Returns all vouches given or received by a user.

---

## Security & Verification

- **Smart Contract Test Suite**: 34 unit and integration tests passing (`cargo test`).
- **Backend Test Suite**: 32 unit and integration tests passing across 5 suites (`jest`).
- **Frontend Test Suite**: 14 tests passing across 3 test files (`vitest`).
- **WASM Verification**: Clean release builds for `credit_score.wasm`, `loan_manager.wasm`, and `community_vouch.wasm`.
- **Zero-Knowledge Roadmap**: The current protocol uses verifiable, pseudonymous public blockchain state. Cryptographic ZK proof verification circuits (e.g., proving $\text{score} \ge 70$ without disclosing exact transaction data) are planned for future Soroban zero-knowledge curve upgrades.

---

## License

This project is licensed under the [MIT License](LICENSE).
