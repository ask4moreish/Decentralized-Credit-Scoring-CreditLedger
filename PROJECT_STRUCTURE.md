# CreditLedger — Project Architecture & Codebase Structure

## Overview
CreditLedger is a decentralized alternative credit scoring and lending protocol built natively for the Stellar network using Soroban smart contracts, a Node.js/Express backend with PostgreSQL and Redis, and a React 18 frontend with Freighter wallet integration.

---

## Actual Codebase Structure

```
Decentralized-Credit-Scoring-CreditLedger/
├── contracts/                                # Stellar Soroban Smart Contracts (Rust)
│   ├── Cargo.toml                            # Workspace configuration
│   ├── Cargo.lock                            # Pinned dependencies (ed25519-dalek 2.2.0)
│   ├── credit_score/                         # CreditScore Contract crate
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs                        # Deterministic 0-100 scoring algorithm (#![no_std])
│   │       └── test.rs                       # Unit and integration test suite
│   ├── loan_manager/                         # LoanManager Contract crate
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs                        # Origination, 0-100 tier thresholds, overpayment checks
│   │       └── test.rs                       # Test suite with configurable mock credit scoring
│   ├── community_vouch/                      # CommunityVouch Contract crate
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs                        # Social trust network & revocation propagation
│   │       └── test.rs                       # Revocation and expiration test suite
│   └── target/wasm32-unknown-unknown/release/ # Compiled release WASM binaries
│       ├── credit_score.wasm
│       ├── loan_manager.wasm
│       └── community_vouch.wasm
│
├── backend/                                  # Backend API & Database Service (TypeScript)
│   ├── package.json                          # Dependencies (@stellar/stellar-sdk 13.x, knex, redis)
│   ├── tsconfig.json                         # TypeScript build configuration
│   ├── knexfile.ts                           # Knex PostgreSQL connection settings
│   ├── Dockerfile                            # Multi-stage production container build
│   ├── healthcheck.js                        # Healthcheck monitor for Docker
│   ├── database/
│   │   └── init.sql                          # Initial PostgreSQL schema definition
│   ├── migrations/                           # Knex database migrations
│   │   └── 20261104000000_create_credit_ledger_tables.ts
│   └── src/
│       ├── index.ts                          # Express server entrypoint & graceful shutdown
│       ├── config/
│       │   ├── database.ts                   # Knex PostgreSQL client
│       │   └── redis.ts                      # Redis client with in-memory fallback
│       ├── services/
│       │   ├── dbService.ts                  # Persistent PostgreSQL database operations
│       │   └── stellarService.ts             # Horizon / Soroban RPC & non-custodial tx preparation
│       ├── controllers/
│       │   ├── auth.ts                       # Cryptographic challenge nonce & JWT sessions
│       │   ├── creditScore.ts                # 0-100 score caching, trends, and non-custodial prep
│       │   ├── loan.ts                       # Loan application, repayment, and admin endpoints
│       │   ├── vouch.ts                      # Vouch creation, revocation, and queries
│       │   └── user.ts                       # User profile and financial summary
│       ├── middleware/
│       │   ├── auth.ts                       # JWT verification and resource authorization
│       │   ├── errorHandler.ts               # Global error handler
│       │   └── rateLimiter.ts                # Request rate limiting
│       ├── utils/
│       │   └── logger.ts                     # Winston structured logging
│       └── __tests__/                        # Backend Jest test suites
│           ├── auth.test.ts
│           ├── creditScore.test.ts
│           ├── loan.test.ts
│           ├── middleware.test.ts
│           └── nonCustodial.test.ts          # Non-custodial transaction prep & submission tests
│
├── frontend/                                 # Frontend Web Application (React 18 + Vite)
│   ├── package.json                          # Dependencies (@stellar/freighter-api, zustand)
│   ├── tsconfig.json                         # TypeScript configuration with Vitest types
│   ├── vite.config.ts                        # Vite configuration & proxy
│   ├── Dockerfile                            # Production Nginx multi-stage container
│   ├── nginx.conf                            # Nginx reverse proxy and caching configuration
│   └── src/
│       ├── main.tsx                          # React DOM entrypoint
│       ├── App.tsx                           # App shell and routing
│       ├── config/
│       │   └── stellar.ts                    # Network settings & passphrases
│       ├── store/
│       │   └── walletStore.ts                # Freighter wallet connection & JWT exchange
│       ├── components/
│       │   ├── Layout.tsx                    # Navigation & responsive layout wrapper
│       │   ├── LoadingSpinner.tsx            # Loading indicator component
│       │   ├── Button.tsx                    # Polymorphic UI Button component
│       │   └── Card.tsx                      # Reusable UI Card container
│       ├── pages/
│       │   ├── HomePage.tsx                  # Protocol landing page & feature overview
│       │   ├── DashboardPage.tsx             # User navigation overview
│       │   ├── CreditScorePage.tsx           # Authoritative 0-100 score display & breakdown
│       │   ├── LoansPage.tsx                 # Non-custodial loan application & repayment
│       │   ├── VouchPage.tsx                 # Community vouch creation & revocation
│       │   ├── ProfilePage.tsx               # Stellar account details & session controls
│       │   └── LoginPage.tsx                 # Freighter wallet authentication
│       └── __tests__/                        # Frontend Vitest test suites
│           ├── setup.ts
│           ├── LoadingSpinner.test.tsx
│           ├── stellar.test.ts
│           └── walletStore.test.ts
│
├── .github/
│   └── workflows/
│       └── ci.yml                            # GitHub Actions CI matrix (Contracts, Backend, Frontend)
├── docker-compose.yml                        # Docker Compose multi-service orchestrator
├── .env.example                              # Root environment variables template
├── LICENSE                                   # MIT License
├── SECURITY.md                               # Security policy and disclosure instructions
├── CONTRIBUTING.md                           # Contributor guidelines and workflow
├── DEPLOYMENT.md                             # Testnet & production deployment instructions
└── README.md                                 # Primary project documentation
```

---

## Component Status Matrix

| Component | Technology | Primary File(s) | Status | Test Coverage |
| :--- | :--- | :--- | :---: | :---: |
| **CreditScore Contract** | Rust (Soroban) | `contracts/credit_score/src/lib.rs` | **Verified** | 8 tests passing |
| **LoanManager Contract** | Rust (Soroban) | `contracts/loan_manager/src/lib.rs` | **Verified** | 16 tests passing |
| **CommunityVouch Contract**| Rust (Soroban) | `contracts/community_vouch/src/lib.rs` | **Verified** | 10 tests passing |
| **Backend REST API** | Express / TS | `backend/src/index.ts` | **Verified** | 32 tests passing |
| **Database Persistence** | PostgreSQL / Knex| `backend/src/services/dbService.ts` | **Verified** | Integrated |
| **Cache & Sessions** | Redis | `backend/src/config/redis.ts` | **Verified** | Integrated |
| **Frontend UI** | React 18 / Vite | `frontend/src/App.tsx` | **Verified** | 14 tests passing |
| **Wallet Signing** | Freighter API | `frontend/src/store/walletStore.ts` | **Verified** | Integrated |
| **Containerization** | Docker / Compose | `docker-compose.yml` | **Verified** | Multi-stage |
| **CI / CD Pipeline** | GitHub Actions | `.github/workflows/ci.yml` | **Verified** | Full CI Matrix |
