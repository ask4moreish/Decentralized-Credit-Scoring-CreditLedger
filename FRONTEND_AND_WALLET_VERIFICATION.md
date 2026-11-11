# Governance, Frontend & Freighter Wallet Verification — CreditLedger

> Covers on-chain/backend governance controls, Freighter challenge-auth & transaction signing edge cases, accessible UI error reporting, Vitest tests, and separated Playwright browser E2E verification.

---

## 1. Governance Assessment

| Governance Control | Implementation Location | Current State | Verification & Constraints |
| --- | --- | --- | --- |
| **Two-Step Contract Admin Handover** | `propose_admin` -> `accept_admin` across `CreditScore`, `LoanManager`, `CommunityVouch` | **COMPLETED AND VERIFIED** | Proven in Rust tests (`test_two_step_admin_handover_and_old_admin_revocation`, `test_initialize_requires_auth_and_single_run_and_admin_handover`) |
| **Emergency Circuit Breaker** | `pause()` / `unpause()` across all 3 contracts | **COMPLETED AND VERIFIED** | Blocks mutations until unpaused; Testnet unauthorized `pause()` submission failed on ledger `#5681750` (`13624b211243...`) |
| **Server RBAC Allowlist & Audit Trail** | `ADMIN_PUBLIC_KEYS`, `ISSUER_PUBLIC_KEYS`, `audit_logs` table, `AdminPage` UI | **COMPLETED AND VERIFIED** | Borrowers/lenders blocked (`403` backend + UI restriction notice in [`AdminPage.tsx`](frontend/src/pages/AdminPage.tsx)); `audit_logs` records admin/erasure actions in PostgreSQL |
| **Multisig / Hardware Custody & Time-Lock** | Operational Mainnet Deployment Key | **NOT IMPLEMENTED** *(Testnet uses single ephemeral/env key)* | Testnet admin is single Ed25519 key; Mainnet **must** assign an `M-of-N` multisig via `propose_admin` -> `accept_admin`. No proxy `update_wasm` exists intentionally. |
| **Collateral Oracle Pricing Governance** | `LoanManager::set_collateral_pricing` (`CollateralPriceE7`) | **IMPLEMENTED BUT NOT FULLY VERIFIED** | Supports admin-configured pricing ratio; currently assumes homogeneous XLM collateral/loan pricing until a decentralized Mainnet oracle is integrated. |

---

## 2. Wallet, Session & UI Edge-Case Matrix

| Edge Case / Negative Flow | Handling Verified | Layer Tested |
| --- | --- | --- |
| **User declines Freighter auth `signMessage`** | `useWalletStore.connect()` aborts immediately prior to `POST /auth/login`; surfaces `<div role="alert">` on [`LoginPage.tsx`](frontend/src/pages/LoginPage.tsx); leaves `isConnected = false`, `token = null` | Vitest (`walletStore.test.ts`) + Playwright (`negative-edges.spec.ts`) |
| **User declines Freighter `signTransaction` on Soroban XDR** | `executeSignedTx()` sets `txState = { stage: 'error', message }`, skips `/submit` call entirely, renders `<TxStatusBanner role="alert" data-stage="error">`, and keeps wallet session cleanly active | Vitest (`walletStore.test.ts`) + Playwright (`negative-edges.spec.ts`) |
| **Access JWT expiry (`401`) -> Automatic refresh rotation** | [`api.ts`](frontend/src/services/api.ts) invokes single-flight `tryRefreshSession()` (`POST /auth/refresh`), updates tokens atomically in Zustand store, and transparently retries the failed API request | Vitest (`walletStore.test.ts`) |
| **Refresh expiry / token reuse (`401` on `/auth/refresh`)** | Clears Zustand + `sessionStorage` state (`isConnected: false`, `publicKey: null`, `isAdmin: false`) and routes protected views back to `/login` cleanly | Vitest (`walletStore.test.ts`) + Playwright (`negative-edges.spec.ts`) |
| **Explicit Disconnect / Wallet Switch Cleanup** | Posts `POST /api/auth/logout` to blocklist active JWT `jti` + revoke refresh sessions and resets `walletStore` state cleanly | Vitest (`walletStore.test.ts`) + `auth.test.ts` |
| **Standard borrower accessing `/admin`** | Navigation hides `Admin / Issuer` link; direct `/admin` route renders restricted banner without admin governance buttons (`403` enforced server-side) | Vitest (`workflows.test.tsx`) + Playwright (`negative-edges.spec.ts`) + Backend `middleware.test.ts` |
| **Under-collateralized / failed prepare error handling** | Inline `<div role="alert">` surfaces exact API/validation reason (e.g., `125% collateral`) alongside error `TxStatusBanner` (`role="alert"`) | Vitest (`workflows.test.tsx`) |

---

## 3. Clean Separation of Test Layers

1. **Unit & Component Tests (`frontend/src/__tests__/`)** — Mocked `fetch` & Freighter bridge tests verifying store transitions, XLM/stroop formatting (`stellar.test.ts`), spinner states, UI forms, declines, and refresh/session expiry:
   - `npm run lint`: **`0` warnings, `0` errors**
   - `npm test -- --run`: **`4` files passed (`19` tests passed, `0` failed)**
2. **Production Bundle Compilation** — `tsc && vite build`: **`67` modules transformed**, compiled to `frontend/dist/`.
3. **Playwright Full-Stack E2E (`frontend/e2e/creditledger.spec.ts`)** — Executes in real headless Chromium/Edge against the compiled Express test server (`backend/scripts/e2e-test-server.cjs`) with real cryptographic `Keypair` Ed25519 challenge signatures across all user roles (`borrower`, `lender`, `admin`, `issuer`).
4. **Playwright Negative Edge E2E (`frontend/e2e/negative-edges.spec.ts`)** — Exercises real browser navigation against mocked Freighter signature rejections and simulated `401` refresh failures alongside real RBAC route blocking:
   - `npm run test:e2e`: **`3 passed (44.3s)`** (`1` compiled full-stack workflow + `2` negative edge-case specs).
5. **Live Blockchain Execution**: Covered separately without UI mocks directly against Stellar Testnet Soroban RPC in [`TESTNET_END_TO_END_VERIFICATION.md`](TESTNET_END_TO_END_VERIFICATION.md).
