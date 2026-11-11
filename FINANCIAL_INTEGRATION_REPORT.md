# Financial & SEP-41 Token Integration Report

> Validation of real asset custody, lending pool share accounting, LTV collateral enforcement, repayment amortization, liquidation mechanics, and escrowed community vouching across [`contracts/loan_manager/`](contracts/loan_manager/src/lib.rs) and [`contracts/community_vouch/`](contracts/community_vouch/src/lib.rs).

## 1. Real Asset Transfers (SEP-41 / SAC)

Both `LoanManager` and `CommunityVouch` invoke `soroban_sdk::token::Client` against configured Stellar Asset Contracts / SEP-41 tokens:
- **`LoanManager::deposit_liquidity` / `withdraw_liquidity`**: Moves `loan_token` between lender and contract, minting/burning proportional pool shares (`shares = amount * total_shares / (available_cash + outstanding_principal)`) and refusing redemptions exceeding uncommitted `available_cash` (`InsufficientAvailableLiquidity`).
- **`LoanManager::create_loan` / `cancel_loan`**: Transfers `collateral_token` into contract custody when required (`score < 60`) or optionally provided; refunds locked collateral in full if a `Pending` loan is cancelled.
- **`LoanManager::approve_loan`**: Atomically debits `available_cash`, increases `outstanding_principal`, and transfers `loan_token` principal to `loan.borrower`.
- **`LoanManager::repay_loan`**: Pulls `loan_token` from `borrower`, computes overdue late fees (after 3-day `GRACE_PERIOD_SECS = 259_200` at `200 bps` per 30d period, capped at `2_500 bps` / 25% of principal), allocates repayments strictly **interest/fees first -> principal second**, releases locked collateral upon full settlement, and reports `on_time` vs late completion to `CreditScore`.

## 2. Underwriting Tiers, APR Schedule & Collateral LTV

`LoanManager` aligns its interest schedule cleanly with backend & frontend tiers:

| Verified Score Band | Tier | APR | Collateral Requirement | Max Single-User Active Exposure |
| --- | --- | --- | --- | --- |
| `80..=100` | Prime | `8%` | Uncollateralized | `100,000,000,000` stroops (10,000 units @ 7 decimals) |
| `70..=79` | Standard | `10%` | Uncollateralized | `50,000,000,000` stroops |
| `60..=69` | Growth | `12%` | Uncollateralized | `25,000,000,000` stroops |
| `50..=59` | Collateralized Base | `15%` | `MAX_LTV_BPS = 8_000` (`>= 125%` collateral value) | `10,000,000,000` stroops |
| `< 50` | Ineligible | Rejected (`InsufficientCreditScore`) | — | `0` |

## 3. Default Liquidation & Fair Surplus Refund

Upon `mark_default` after `due_date`:
1. Computes total owed debt (`remaining_principal + remaining_interest + accrued_late_fee`).
2. Values locked collateral using `CollateralPriceE7` (default 1:1 `10_000_000`) and caps seizure at `debt_owed * (10_000 + 500) / 10_000` (`LIQUIDATION_BONUS_BPS = 500`, 5% buffer).
3. Same-asset collateral directly recapitalizes `pool.available_cash`; distinct collateral transfers seized units to `LiquidationVault`. Any excess collateral above the capped debt seizure (`surplus`) is refunded back to the borrower.
4. Any remaining `uncovered_loss` invokes `CommunityVouch::slash_vouches_on_default`, capped at `MAX_SLASH_BPS = 5_000` (50% per active vouch) and transferred to the lending pool.

## 4. Escrowed Community Vouching Invariants

- **No Self-Declared Weight**: `create_vouch` does NOT accept caller `trust_score`; weight is computed deterministically (`0.70 * min(score, 100) + stake_bonus`).
- **Time Decay**: `get_effective_vouch_trust` decays linearly after half the vouch duration down to a `50%` floor prior to expiration, then `0`.
- **Anti-Double-Withdraw CEI**: `release_escrow_transfer` sets `vouch.escrowed_balance = 0` and `vouch.withdrawn = true` BEFORE calling `token::Client.transfer`, preventing re-withdrawal after revocation, expiration, or partial default slashing (`withdraw_remaining_escrow`).

## 5. Verification Matrix

| Flow | Status | Evidence |
| --- | --- | --- |
| Lending pool share minting, lock & interest yield withdrawal | **IMPLEMENTED AND VERIFIED** | `test_lender_liquidity_pool_lock_disbursement_and_repayment_interest_yield` + live Testnet txs |
| Base-tier LTV enforcement, collateral lock & release | **IMPLEMENTED AND VERIFIED** | `test_collateralized_base_tier_ltv_enforcement_lock_and_release`, `test_pause_cancel_collateral_refund_limits_and_pagination` |
| Stroop-scale (7 decimals) 100 XLM borrow & repay | **IMPLEMENTED AND VERIFIED** | `test_stroop_scale_real_asset_limits_prime_tier` |
| Overdue late fees, fair surplus refund & 50% vouch slashing | **IMPLEMENTED AND VERIFIED** | `test_late_fee_default_liquidation_with_surplus_refund_and_vouch_slash` (local Soroban time-warp) |
| Non-custodial 7-decimal stroop parsing & XDR preparation | **IMPLEMENTED AND VERIFIED** | `backend/src/__tests__/amounts.test.ts`, `loan.test.ts`, `nonCustodial.test.ts` |
