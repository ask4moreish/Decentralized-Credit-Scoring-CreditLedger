# Contributing to CreditLedger

Thank you for your interest in contributing to CreditLedger! This document provides guidelines for local development, testing, coding standards, and submitting pull requests.

---

## Prerequisites

- **Rust**: `stable` toolchain with target `wasm32-unknown-unknown`
  ```bash
  rustup target add wasm32-unknown-unknown
  ```
- **Node.js**: `v20.x` or later and `npm`
- **PostgreSQL**: `15.x` or later (or run via Docker Compose)
- **Redis**: `7.x` or later (or run via Docker Compose)
- **Stellar CLI**: (Optional, for deploying Soroban WASM to Testnet)

---

## Development Setup

### 1. Smart Contracts (Soroban)

Navigate to the `contracts` directory:
```bash
cd contracts

# Run all unit and integration tests (34 tests)
cargo test

# Compile release WASM artifacts
cargo build --target wasm32-unknown-unknown --release
```

Compiled WASM artifacts will be generated in `contracts/target/wasm32-unknown-unknown/release/`.

### 2. Backend Service

Navigate to the `backend` directory:
```bash
cd backend

# Install dependencies
npm ci

# Configure environment variables
cp .env.example .env

# Run database migrations
npx knex migrate:latest

# Compile TypeScript
npm run build

# Run test suites (Jest)
npm test
```

### 3. Frontend Application

Navigate to the `frontend` directory:
```bash
cd frontend

# Install dependencies
npm ci

# Configure environment variables
cp .env.example .env

# Run unit and integration tests (Vitest)
npm test -- --run

# Build production bundle
npm run build
```

---

## Coding Standards

### Smart Contracts (Rust / Soroban)
- Every contract crate must include `#![no_std]` at the root of `src/lib.rs`.
- All financial state calculations and credit score weights must use integer arithmetic bounded within `0..=100`.
- Do not introduce arbitrary FICO conversions or unverified external dependencies.
- Every state transition must perform explicit authorization checks (`require_auth`).

### Backend (Node.js / TypeScript)
- Use strong typing across all services and route handlers without `any` where possible.
- All protected endpoints must verify JWT tokens and enforce resource ownership.
- Database operations must be routed through Knex (`DbService`) with migrations for schema changes.
- Transaction preparation endpoints must return unsigned base64 XDR for user wallet authorization.

### Frontend (React / TypeScript / Tailwind CSS)
- Maintain strict type safety without suppression flags.
- Connect wallet actions via `@stellar/freighter-api`.
- Display credit scores exclusively on the 0–100 scale.
- Include proper loading, error, empty, and disabled states on all interactive controls.

---

## Pull Request Guidelines

1. Fork the repository and create a feature branch (`git checkout -b feature/my-improvement`).
2. Verify that all tests and builds pass cleanly:
   - `cargo test` in `contracts/`
   - `cargo build --target wasm32-unknown-unknown --release` in `contracts/`
   - `npm run build && npm test` in `backend/`
   - `npm run build && npm test -- --run` in `frontend/`
3. Commit with clear, descriptive commit messages.
4. Ensure no secret keys, `.env` files, or build artifacts (`target/`, `dist/`, `node_modules/`) are committed.
5. Open a Pull Request against `main`.
