# CreditLedger Deployment & Operations Runbook

## 1. Contract Deployments on Stellar Testnet

CreditLedger preserves the legacy prototype contract instances unmodified for historical reference while deploying hardened v2 WASM builds (`wasm32v1-none`) separately. See [`TESTNET_DEPLOYMENT_EVIDENCE.md`](TESTNET_DEPLOYMENT_EVIDENCE.md) and [`contracts/deployed-testnet-hardened.json`](contracts/deployed-testnet-hardened.json) for deployed Testnet addresses, WASM SHA-256 checksums, and confirmed transaction hashes.

### Preserved Legacy Contracts (Unmodified Historical Evidence)
- `CreditScore` (Legacy): `CBYH6SQZBYC7MWH4QF6FRGCKH2SW5EQD24RLK3EKOTMM5EYSQB7J65BZ`
- `LoanManager` (Legacy): `CDO44SYFPU7SCP4BFTJTWFL2Z7BDB4MVOSSUSW6JUXSPB37ZIAZ7FHKA`
- `CommunityVouch` (Legacy): `CCZNGFWUX5YFTRP7Y2N7I4TFTNS6YV4243NZ62LLQXGSXLIQTB2XP552`

---

## 2. Building & Testing Locally

### Soroban Smart Contracts
```bash
cd contracts
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build --target wasm32v1-none --release
```

### Backend API & Migrations
```bash
cd backend
npm ci
cp .env.example .env   # Configure DB_PASSWORD, REDIS_URL, JWT_SECRET, DATA_ENCRYPTION_KEY
npx knex migrate:latest
npm run build
npm run lint
npm test -- --ci --forceExit
```

Verify reversible migrations and backup/restore cleanly:
```bash
cd backend
bash scripts/verify-migrations-and-backup.sh
```

### Frontend & Playwright E2E
```bash
cd frontend
npm ci
cp .env.example .env
npm run lint
npm test -- --run
npm run build
npm run test:e2e
```

---

## 3. Reproducible Stellar Testnet Deployment

Always run a safe non-mutating check first (`--dry-run` default):
```bash
node scripts/testnet-deploy-and-verify.mjs
```

To execute a gated Testnet deployment (creates separate contract IDs, never Mainnet, never touches legacy contracts):
```bash
# Option A: ephemeral Friendbot test accounts (no persistent secrets required)
ALLOW_EPHEMERAL_KEYS=1 CONFIRM_TESTNET_DEPLOY=1 node scripts/testnet-deploy-and-verify.mjs --execute

# Option B: caller-supplied funded Testnet admin secret (never commit to VCS)
STELLAR_ADMIN_SECRET=S... CONFIRM_TESTNET_DEPLOY=1 node scripts/testnet-deploy-and-verify.mjs --execute
```

GitHub Actions manual workflow: [`.github/workflows/deploy-testnet.yml`](.github/workflows/deploy-testnet.yml) (`workflow_dispatch` with explicit `confirm_testnet=TESTNET` gate).

---

## 4. Docker Compose Stack

Populate a strong `.env` from [`.env.example`](.env.example) (`POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `JWT_SECRET`, `DATA_ENCRYPTION_KEY`, `CORS_ORIGINS`, `ADMIN_PUBLIC_KEYS`):
```bash
docker compose up -d --build
docker compose ps
```
`postgres` (`5432`) and `redis` (`6379`) are exposed **only** on the internal `credit_ledger_internal` bridge network. Terminate HTTPS in front of `127.0.0.1:3000` (Nginx container) using your cloud ingress, Load Balancer, or Caddy/Certbot before exposing publicly.

---

## 5. Stellar Mainnet Readiness Checklist (NOT Executed)

Do **not** deploy to Stellar Mainnet until every gate below is satisfied:
1. Independent third-party security audit signed off on `credit_score`, `loan_manager`, and `community_vouch`.
2. Multisig (`M-of-N`) / hardware custody assigned as Soroban contract `admin` via two-step `propose_admin` -> `accept_admin`.
3. Collateral oracle pricing governance (`set_collateral_pricing`) verified against production price feeds.
4. Load & failover testing of PostgreSQL PITR backups, Redis AOF persistence, and Soroban RPC transaction reconciliation worker.
5. Incident response & emergency `pause()` operational drill completed.
