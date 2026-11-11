# Stellar Testnet End-to-End & Negative Verification Report — CreditLedger

> Independent live verification executed against Stellar Testnet Soroban RPC (`https://soroban-testnet.stellar.org`) and Horizon (`https://horizon-testnet.stellar.org`) via [`scripts/testnet-verify-existing.mjs`](scripts/testnet-verify-existing.mjs) at Horizon Ledger `#5681747` (`2026-11-11T21:28:58.164Z`), building on the canonical v2 deployment in [`TESTNET_DEPLOYMENT_EVIDENCE.md`](TESTNET_DEPLOYMENT_EVIDENCE.md) and [`contracts/deployed-testnet-hardened.json`](contracts/deployed-testnet-hardened.json).

---

## 1. On-Chain WASM Bytecode Hash & Legacy Preservation Verification

Queried Stellar Testnet `CONTRACT_INSTANCE` ledger entries directly (`getLedgerEntries`) and compared the deployed on-chain `executable.wasmHash` bytes against local `contracts/target/wasm32v1-none/release/*.wasm` SHA-256 digests:

| Contract | Canonical Hardened v2 Contract ID | Local WASM SHA-256 == On-Chain `wasmHash` | Preserved Legacy v1 Contract ID | Legacy On-Chain `wasmHash` |
| --- | --- | --- | --- | --- |
| `CreditScore` | `CAAPEEPQJH5ZQHOYOF3KVHQNUGZV5DVPUSE4KCAKJ3E3NQGEYQ53ZUTW` | `bcfa972318fe9b923650512190824453451c411a51efc9ec7e041d35bd5f0fca` (**EXACT MATCH**) | `CBYH6SQZBYC7MWH4QF6FRGCKH2SW5EQD24RLK3EKOTMM5EYSQB7J65BZ` | `ba5caca334d021757589c2bb36554630b927776abeddef970b17967b445edded` (Untouched) |
| `LoanManager` | `CB4KYCG62B62RNMIGHV2NP5GDCGPGE23XW5FQVOTBE266PFPKKB5NNXB` | `b27c238fd35905f23a74be63cd6edf2b9c5f62ab0ae277ea157b53ab19a0b363` (**EXACT MATCH**) | `CDO44SYFPU7SCP4BFTJTWFL2Z7BDB4MVOSSUSW6JUXSPB37ZIAZ7FHKA` | `c01cd49517841019c329352d2beabc61656d7dd1c01b5ab1a820ad362a776d5a` (Untouched) |
| `CommunityVouch` | `CAQSXBETHWHNXF5BJV37CVD2AI4D4JTVZ3J2S3YLTAPUF5V7BWFV444F` | `4999127b24c868c988b3bc7838d423932afdc7cdfdf9a7c643f768aa032c5f6e` (**EXACT MATCH**) | `CCZNGFWUX5YFTRP7Y2N7I4TFTNS6YV4243NZ62LLQXGSXLIQTB2XP552` | `34a4a298804b2e00a432c4fe5b5adae1d2c63f5aca9ba5869e9a64367db8c584` (Untouched) |
| Native XLM SAC | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` | Protocol Native Asset Contract (Testnet) | — | — |

---

## 2. Live Verification Against Existing Deployed Hardened v2 Contracts

Executed using freshly funded ephemeral Friendbot Testnet accounts (`actorA=GCIZJNANIJLA56VMOIYP4RJ4TPBQT7WBPIZWVIOWUJXY6OPBK4LYR4SL`, `actorB=GB4OEVN2GWIQFQ5YDG662MKW63KAIVC3BEKNYTUSBF6D32U37TYHYAJZ`) directly against `CAAPEEP...`, `CB4KYCG...`, and `CAQSXBE...`:

### A. Confirmed Live Transactions on `CAAPEEP...` / `CB4KYCG...` / `CAQSXBE...` (`5` Successes + `1` Rejected Security Probe)

| Action / Security Test | Result | Ledger | Full Transaction Hash |
| --- | --- | --- | --- |
| **Negative Auth Check**: Unauthorized `CreditScore.pause()` submitted by `actorA` | **REJECTED ON-CHAIN** | `#5681750` | `13624b211243daf5dd4f0b624ba882c891fd52d990d09d8706403b75088caf13` |
| `CreditScore.submit_self_reported_record` (`claimed_metric=100`, `amount=99.9 XLM`) -> `get_credit_score` stays **`0`** | **CONFIRMED** | `#5681751` | `3744a1910587c0b34a385db8b44fc3185a969414affacab13bebc1fc8ca84ce4` |
| `LoanManager.deposit_liquidity` (`120 XLM` = `1_200_000_000` stroops via Native XLM SAC) | **CONFIRMED** | `#5681752` | `99007284515592d052e97e541b7a34470d44c62e0e7d31bc03f9e96c4fc795f6` |
| `LoanManager.withdraw_liquidity` (`1,199,999,999` stroops redeemable share balance, postWithdraw `0`) | **CONFIRMED** | `#5681753` | `22dc60d3bba526734be85a90c74c186b5cacd718025112932d333624717398c9` |
| `CommunityVouch.create_vouch` (`actorA -> actorB`, `25 XLM` real XLM SAC escrow) | **CONFIRMED** | `#5681754` | `1c8f5efb54195eb6feda80e43f2b6daca9b8f87f6b4618a547dee98ceb8052f9` |
| `CommunityVouch.revoke_vouch` (full `25 XLM` escrow refund) | **CONFIRMED** | `#5681755` | `8db8464794c04c38e8d125a5c451debe8d55948c5bd87591e59f3070e27d7f33` |

> **Vault Share Rounding Observation on Live Pool (`CB4KYCG...`)**: Because `CB4KYCG...` had previously accrued borrower interest from earlier loans (`total_backing > total_shares`), depositing `1,200,000,000` stroops minted floor-rounded shares redeemable for `1,199,999,999` stroops (`get_lender_balance` = `1,199,999,999`). Attempting to withdraw `1,200,000,000` failed with `Error(Contract, #14 InsufficientLenderBalance)` while `1,199,999,999` succeeded cleanly — demonstrating real ERC-4626-style floor/ceiling share protection against 1-stroop rounding drains.

### B. Live RPC Preflight / Contract Rejection Checks on `CAAPEEP...` / `CB4KYCG...` / `CAQSXBE...`

| Negative Security Check | Observed Contract Error | Status |
| --- | --- | --- |
| Unverified borrower (`score = 0`) calling `LoanManager.create_loan` | `HostError: Error(Contract, #10)` (`InsufficientCreditScore`) | **REJECTED** |
| Lender withdrawing `500 XLM` above available balance/liquidity | `HostError: Error(Contract, #13)` (`InsufficientAvailableLiquidity`) | **REJECTED** |
| Non-depositor (`actorB`) attempting `LoanManager.withdraw_liquidity` | `HostError: Error(Contract, #14)` (`InsufficientLenderBalance`) | **REJECTED** |
| Self-vouch `CommunityVouch.create_vouch(actorA, actorA)` | `HostError: Error(Contract, #12)` (`SelfVouchNotAllowed`) | **REJECTED** |
| Duplicate active pair `CommunityVouch.create_vouch(actorA, actorB)` | `HostError: Error(Contract, #13)` (`DuplicateActiveVouch`) | **REJECTED** |
| Double escrow claim `withdraw_remaining_escrow` post-revoke | `HostError: Error(Contract, #11)` (`VouchAlreadyWithdrawn`) | **REJECTED** |

---

## 3. Admin-Gated Negative & Mandatory `50–59` Base-Tier Collateral Lifecycle (`Identical WASM`)

Because the canonical `CAAPEEP...` / `CB4KYCG...` / `CAQSXBE...` admin keypair was ephemeral and intentionally not retained in source control or environment files, admin-gated scenarios (issuer registration, invalid Ed25519 signature rejection, expired/replay attestations, `50–59` mandatory collateral lock/unlock, committed liquidity drain block, partial repayment & post-repay score increase) were additionally verified live on Testnet using an isolated verification triplet instantiated from the **exact identical uploaded WASM hashes** (`CreditScore`: `CCRKELCEC5AB2DOCWNLM7FSVZZ36V7DRIBOP52TYIPULIZTN4FHBBBT4`, `LoanManager`: `CDCW34DZB7J62B2D7DHIOB5TE32KJW4VMUSVBBHLI2RCTLMGF5AE6RB2`, `CommunityVouch`: `CAT376XSRWELJLCZMT2MFAEST5ZNDDCKXZ5YTEBQXCHD2AL57LYZGLD4`).

### A. Verified Negative Controls (Admin-Gated Suite)

| Security / Economic Check | Observed Contract / Host Response | Status |
| --- | --- | --- |
| Tampered Ed25519 signature on `submit_signed_attestation` | `HostError: Error(Crypto, InvalidInput)` (`failed ED25519 verification`) | **REJECTED** |
| Expired attestation (`expires_at <= now`) on `submit_signed_attestation` | `HostError: Error(Contract, #15)` (`AttestationExpired`) | **REJECTED** |
| Replayed `attestation_id` on `submit_signed_attestation` | `HostError: Error(Contract, #12)` (`DuplicateAttestation`) | **REJECTED** |
| Mandatory collateral check for borrower score `56 / 100` borrowing `40 XLM` | `get_required_collateral` returned `500,000,000` stroops (`50 XLM`, `125%`) | **VERIFIED** |
| Under-collateralized loan (`40 XLM` principal with `40 XLM` collateral `< 50 XLM`) | `HostError: Error(Contract, #11)` (`InsufficientCollateral`) | **REJECTED** |
| Lender `withdraw_liquidity(30 XLM)` when pool only holds `20 XLM` uncommitted cash | `HostError: Error(Contract, #13)` (`InsufficientAvailableLiquidity`) | **REJECTED** |
| Premature `mark_default` before loan maturity + grace period | `HostError: Error(Contract, #16)` (`LoanNotYetDue`) | **REJECTED** |

### B. Full Stateful Outcomes (`18` Live Confirmed Transactions, Ledgers `#5681761`–`#5681778`)

- **Credit Score Uplift Across Repayment**: Pre-loan score `56 / 100` (`submit_signed_payment_72` + `submit_signed_savings_68_3m`) -> partial `20 XLM` repay -> final repay -> **`postRepayScore = 61 / 100`**, **`repaid_loans = 1`**.
- **Loan Settlement & Collateral Release**: `collateralLoanId = 1`, **`finalLoanStatus = "Repaid"`**, **`collateralLockedAfterRepay = false`** (50 XLM collateral returned cleanly to borrower), **`poolAvailableCashAfter = 630,000,000` stroops** (`60 XLM` deposited + `3 XLM` scheduled 6m interest at 15% APR = `63 XLM`).

| Step | Ledger | Full Transaction Hash |
| --- | --- | --- |
| `instantiate_creditScore` | `5681761` | `4e60dce4559acad63aa883ea9cf6db30eb5d1ad5507a0650de078f591a802595` |
| `instantiate_loanManager` | `5681762` | `b5fe39462de525283c49e0921b1d927f9f73274b1e852f775695a9f9704c3aac` |
| `instantiate_communityVouch` | `5681763` | `b81a90044e8db82ed7ef5d7ac7f24e1bb15d3e3607be369c5b0404088508fd4f` |
| `credit_score.initialize` | `5681764` | `eeb1e8fd9069e5a84f525b5ebf93cfa241ec4ec3be719da52fcb0b12e548bd44` |
| `community_vouch.initialize` | `5681765` | `64c0040e41580a2af84ae7a92e8f55c7408113a7d5a3a6d907dbd877ea1c7aba` |
| `loan_manager.initialize` | `5681766` | `ca3361d0ff2af0a5365d397e6a1560e37d7588e583ec14dbdf2e353d727a2f13` |
| `wire_credit_to_loan` | `5681767` | `f4637902d91850f1db317a0b8ba2e789c1ad594db7ed18c276e957b15bd102a0` |
| `wire_credit_to_vouch` | `5681768` | `00bfd96683cbee8d585f18333ae29c774d2b5f05279e0fff52be952f809d6fe0` |
| `wire_vouch_to_loan` | `5681769` | `c9a67c4301fa750cfc294164c92b5fc0e8ccfac85882c579f978710badb435d6` |
| `wire_loan_to_vouch` | `5681770` | `a5269a34f22fd491d856bc1163065230f041bc4af1cd695a83b9d6f91da27e58` |
| `register_issuer` | `5681771` | `ce84ef0e66108d8b3a3d2b66990f211068088e844778bd91dc77faa4ccc8b19e` |
| `submit_signed_payment_72` | `5681772` | `5c4cd0ec08156d77d98cf22c20c7cbd538e356c5f8e3888c997e1a9bfdada6fe` |
| `submit_signed_savings_68_3m` | `5681773` | `82267056fa3f203ab1049edca10efd3a96284808d23929fec1e73a3383d103a6` |
| `deposit_pool_60XLM` | `5681774` | `f0e743e30daeaa727e5917279e5be353a71a114c008ff0143a6bf68d81e32f61` |
| `create_mandatory_collateral_loan_40XLM_50XLM_col` | `5681775` | `7b713d79545514be44d1a6e79e95c8bac9215020ea3e119cd8274f8aa712ce9a` |
| `approve_collateral_loan` | `5681776` | `e8dd6d09abf211b922f00b03eeeac388677a25a069ddd89aee99a5c26b84c339` |
| `partial_repay_20XLM` | `5681777` | `c04a40c9f642e1f8fa49b877710430b105318cef3d9c40e8baa8ca0f01adb855` |
| `final_repay_and_unlock_collateral` | `5681778` | `57f838b6e4d00f7dc71693f117126f2e260b21bd34f6ca65e599a16dcd8fadf0` |

---

## 4. Honest Remaining Testnet Constraint

- **Overdue Timestamp Liquidation**: Real-time Testnet wall clocks cannot fast-forward across a multi-month loan duration + `3-day` grace period, so live Testnet proves premature default rejection (`LoanNotYetDue`) while full overdue liquidation, 5% liquidation bonus math, collateral surplus refund, and bounded 50% vouch slashing are proved deterministically in local ledger-warped Soroban tests (`test_late_fee_default_liquidation_with_surplus_refund_and_vouch_slash` and `test_adversarial_loan_paths_and_randomized_accounting_invariants`).
