# CI/CD & Dependency Security Audit Report — CreditLedger

> Covers post-remediation `npm audit --omit=dev --json` and full `npm audit --json` across `backend/` and `frontend/`, Cargo/Soroban checks, and GitHub Actions pipelines ([`.github/workflows/ci.yml`](.github/workflows/ci.yml), [`.github/workflows/deploy-testnet.yml`](.github/workflows/deploy-testnet.yml)).

---

## 1. Executive Dependency Summary (Post-Remediation)

| Package Workspace | Production Deps (`--omit=dev`) | All Deps (Incl. `devDependencies`) | Production Advisories Fixed in Phase 2 |
| --- | --- | --- | --- |
| `backend/` | `0 critical`, `2 high`, `0 moderate`, `0 low` (**2 total**) | `0 critical`, `8 high`, `1 moderate`, `7 low` (**16 total**) | Resolved both `qs` (`express 4.22.2 -> 4.22.3`, `qs 6.15.4 -> 6.16.2`) moderate prod advisories via `npm audit fix` |
| `frontend/` | `0 critical`, `2 high`, `0 moderate`, `0 low` (**2 total**) | `3 critical`, `9 high`, `1 moderate`, `0 low` (**13 total**) | Resolved `zod < 4.6.6` (`3.25.76 -> 4.6.7`, high) and both `react-router` / `react-router-dom < 7.18.0` (`6.15 -> 7.18.5`, moderate) without `--force` |
| `contracts/` (Rust) | `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `wasm32v1-none` release | — | Clean (25 / 25 contract tests passing) |

---

## 2. Remaining Production Advisories (`--omit=dev`) & Exposure Analysis

### `@stellar/stellar-sdk@13.3.0` -> `toml@3.0.0` (`2 high`, `backend/` & `frontend/`)
- **Advisories**: `toml <= 5.0.0` / `toml-node < 4.2.0` (`GHSA-82x6-q7mm-w9cf`, `GHSA-v5mp-jgw5-2x6j`, `GHSA-4qx8-w7c3-pj3p`, `GHSA-9j65-hcg3-gc64`, `GHSA-9qmh-m7c6-f92p`, `GHSA-h895-cgqg-jf52`) affecting `toml.parse()`.
- **Upgrade Constraint (`fixAvailable: @stellar/stellar-sdk@17.4.0, isSemVerMajor: true`)**: Upgrading `@stellar/stellar-sdk` across four major versions (`13 -> 17`) breaks Soroban RPC / XDR types cleanly tested against Stellar Testnet Protocol 23. Per Phase 2 policy, no forced breaking SDK jump was performed.
- **Reachability / Exposure**: **Low Practical Risk** — CreditLedger never calls `toml.parse()` or `StellarToml.Resolver` on untrusted/HTTP input; only `Keypair`, `Address`, `TransactionBuilder`, `Operation`, `rpc.Server`, and `xdr` codecs are used.
- **Remediation Path**: Schedule `@stellar/stellar-sdk@17.x` migration and Testnet RPC regression suite prior to Mainnet launch.

---

## 3. Remaining Development-Only Advisories (`devDependencies`)

- **`frontend/` `vitest@0.34.6` / `@vitest/ui@0.34.4` / `tinypool` (`3 critical`) & `vite@4.5.14` / `esbuild@0.18.20` (`1 high` + `1 moderate`)**:
  - `tinypool <= 2.1.1` RCE advisories (`GHSA-5gmw-xhrv-c9v3`, `GHSA-85c8-ppgw-ccpr`) and `@vitest/ui <= 3.2.5` arbitrary file read apply strictly to `vitest <= 4.0.0-beta.19`.
  - Registry `peerDependencies` verify `vitest >= 4.1.0` / `5.1.0` requires `vite >= 6.0.0 / 6.4.0` (`vite 4 -> 6/8` major build pipeline jump + Rollup 4 + `@vitejs/plugin-react` upgrade).
  - None of `vitest`, `@vitest/ui`, `tinypool`, `vite` dev middleware, or `esbuild` are included in the compiled production bundle (`frontend/dist/` served via Nginx). Keep `vitest --ui` disabled / local-only and schedule `vite@6+` + `vitest@4/5` tooling upgrade as a dedicated build-system PR.
- **`backend/` & `frontend/` `@typescript-eslint/*@6` -> `minimatch@9.0.3` / `eslint@8` (`high`), `backend/` `nodemon@3.1.14` -> `minimatch` (`moderate`), `jest@29.7.0` -> `deepmerge` (`low`)**:
  - Dev-only lint, watch, and Jest runner tools not shipped in runtime `npm ci --omit=dev` images; `@typescript-eslint` v6->v8 / `jest@29->30` require major config migrations.

---

## 4. Verification After Dependency Remediations

1. **`backend/`** (`express@4.22.3`, `qs@6.16.2`):
   - `npm run build` (`tsc`): passed
   - `npm run lint`: passed
   - `npm test -- --ci --forceExit`: **`9 passed, 35 tests passed; 1 suite / 4 tests skipped` (`postgresRedis.integration.test.ts`, requires `TEST_REQUIRE_DB=1`)**
2. **`frontend/`** (`zod@4.6.7`, `react-router-dom@7.18.5`):
   - `npm run lint` (`eslint --max-warnings 0`): passed
   - `npm test -- --run`: **`4 passed (4)`, `19 passed (19)`**
   - `npm run build`: **`74` modules compiled**
   - `npm run test:e2e`: **`3 passed` (`creditledger.spec.ts` + `negative-edges.spec.ts`)**

---

## 5. GitHub Actions CI Reconciliation

- **Existing Remote Run `43096988463` (Triggered on `ed4e5f9` at `2026-11-11T20:35:54Z`)**: Stranded in `status: "queued"` with `jobs: []` during the confirmed GitHub Actions `major_outage` (`2026-11-11T20:48:25Z` on `www.githubstatus.com`). GitHub Status later recovered to `All Systems Operational`.
- **Pipeline Readiness**: [`.github/workflows/ci.yml`](.github/workflows/ci.yml) now includes `TEST_REQUIRE_DB=1 npx jest src/__tests__/postgresRedis.integration.test.ts --ci --forceExit` backed by `postgres:15-alpine` and `redis:7-alpine` health-checked containers. Pending user push authorization to trigger fresh full-matrix CI verification on GitHub.
