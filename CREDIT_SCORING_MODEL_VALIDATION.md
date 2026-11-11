# Credit Scoring Model Validation (`Model v2`)

> Audit, mathematical formulation, synthetic borrower profile validation, and sensitivity analysis for [`contracts/credit_score/src/lib.rs`](contracts/credit_score/src/lib.rs) and [`contracts/credit_score/src/types.rs`](contracts/credit_score/src/types.rs).

---

## 1. Status & Integrity Controls

- **Model Version**: `SCORING_MODEL_VERSION = 2` ([`contracts/credit_score/src/types.rs`](contracts/credit_score/src/types.rs))
- **Authoritative Input Gate**: Authoritative scores (`get_credit_score`, `get_score_breakdown`) compute dynamically against `env.ledger().timestamp()` from three trusted on-chain sources:
  1. **Issuer-Attested Financial Records** submitted either directly by an authorized issuer (`submit_attestation`, `batch_submit_attestations`) or non-custodially with an on-chain verified Ed25519 signature (`submit_signed_attestation` via `env.crypto().ed25519_verify` over domain-separated payload `CREDITLEDGER-ATTEST-V1 || contract || attestation_id || subject || issuer || kind || record_commitment || metric_score || amount_units || duration_months || issued_at || expires_at`).
  2. **Loan Outcomes** recorded solely by the configured `LoanManagerContract` (`record_loan_outcome`).
  3. **Escrowed Community Vouches** synced solely by the configured `CommunityVouchContract` (`add_community_vouch`, `remove_community_vouch`).
- **Self-Reported Isolation**: `submit_self_reported_record` stores non-authoritative metadata commitments (`UserSelfReportAt`) for optional manual inspection only and contributes **0%** weight to authoritative scores (`self_reported_count` is exposed transparently in `ScoreBreakdown`).

---

## 2. Five-Pillar Weighted Scoring Formula

Let $P \in [0, 100]$ (`payment_history_score`), $S \in [0, 100]$ (`savings_score`), $R \in [0, 100]$ (`repayment_score`), $C \in [0, 100]$ (`community_score`), and $A \in [0, 100]$ (`activity_score`):

$$\text{weighted\_raw} = \frac{35 P + 25 S + 20 R + 10 C + 10 A}{100}$$
$$\text{default\_penalty} = \min(100,\; 25 \times \text{defaulted\_count})$$
$$\text{final\_score} = \max(0,\; \text{weighted\_raw} - \text{default\_penalty})$$

### Pillar Computations
- **Payment History (35%)**: Recency-weighted mean of active, non-revoked, non-expired `ATTESTATION_KIND_PAYMENT` attestations from issuers with `!revoked_for_cause` (`<= 180d` weight `100`, `181d–365d` weight `75`, `> 365d` weight `50`), plus breadth bonus (`>= 3`: `+5`, `>= 6`: `+10`, `>= 12`: `+15`), capped at `100`.
- **Savings Reserves (25%)**: Recency-weighted mean of active `ATTESTATION_KIND_SAVINGS` attestations plus average duration bonus (`>= 3m`: `+5`, `>= 6m`: `+10`, `>= 12m`: `+20`), capped at `100`.
- **Loan Repayment History (20%)**: `50 + 12 * on_time_count + 3 * late_count` capped at `100`, minus `50 * defaulted_count` (saturating at `0`). Borrowers with verified attestations and zero closed loans start neutral at `50`; accounts with zero verified records start at `0`.
- **Community Vouching (10%)**: Mean policy-derived `trust_score` across active, non-expired `UserVouchEntry` items plus escrowed stake bonus (`>= 100_000`: `+5`, `>= 500_000`: `+10`, `>= 1_000_000`: `+15` stroops), capped at `100`.
- **Activity & Diversity (10%)**: Tiers on `verified_activity_items` (`0 -> 0`, `1..2 -> 30`, `3..5 -> 60`, `6..10 -> 85`, `11+ -> 100`).

---

## 3. Synthetic Borrower Profile Benchmark Suite (Deterministic Verification)

Executed directly against the Soroban Rust contract in [`test_synthetic_borrower_profiles_matrix_and_sensitivity`](contracts/credit_score/src/tests.rs) (`11 passed; 0 failed` in `credit_score` unit suite):

| Synthetic Profile | Key Verified Inputs | Pillar Scores `(P, S, R, C, A)` | Penalty | Exact Final Score | Loan Tier Outcome |
| --- | --- | --- | --- | --- | --- |
| **1. Excellent** | 6 recent payments (92), 12m savings (88), 3 on-time loans, 1M-stroop vouch (90) | `(100, 100, 86, 100, 100)` | `0` | **`97 / 100`** | **Prime (`8% APR`, uncollateralized)** |
| **2. Average** | 3 recent payments (74), 6m savings (70), 1 on-time loan | `(79, 80, 62, 0, 60)` | `0` | **`66 / 100`** | **Standard (`12% APR`, uncollateralized)** |
| **3. High-Risk** | 2 weak payments (55, 50), 2m savings (45), 1 late + 1 default | `(52, 45, 3, 0, 60)` | `-25` | **`11 / 100`** | **Ineligible (`< 50`)** |
| **4. Limited History** | 1 payment (72), 3m savings (68), 0 loans, 0 vouches | `(72, 73, 50, 0, 30)` | `0` | **`56 / 100`** | **Base (`15% APR`, >=125% collateral req.)** |
| **5. Inconsistent Repayment** | Volatile payments `[95, 42, 92, 46]`, 4m savings (60), 2 late repayments | `(73, 65, 56, 0, 85)` | `0` | **`61 / 100`** | **Standard (`12% APR`)** |
| **6. Community-Backed** | Same financial signals as #4 (`72`, `68/3m`) + 2 active vouches (`1.2M` escrow, trust `85`) | `(72, 73, 50, 100, 60)` | `0` | **`69 / 100`** | **Standard (`+13` lift vs Limited History)** |
| **7. Defaulted Strong History** | Pre-default (`78`: 4x88 pay, 12m 82 sav, 1 on-time) -> +1 `defaulted` event | `(93, 100, 12, 0, 85)` | `-25` | **`43 / 100`** | **Ineligible (`-35` point drop)** |
| **8a. Zero / Missing Data** | Unattested fresh wallet | `(0, 0, 0, 0, 0)` | `0` | **`0 / 100`** | **Ineligible (`< 50`)** |
| **8b. Self-Reported Spam Only** | Self-submitted receipt claiming amount `99,999,999` & metric `100` | `(0, 0, 0, 0, 0)` | `0` | **`0 / 100`** | **Ineligible (0% weight verified)** |

---

## 4. Sensitivity, False-Positive / False-Negative Analysis & Limitations

### Observed Sensitivity Findings
1. **Default Sensitivity**: A single on-chain default cuts the repayment pillar by `50` points (`-10` raw impact) AND subtracts `25` flat default penalty points (`-35` total score drop on profile #7 from `78 -> 43`), immediately locking out uncollateralized & base-tier borrowing.
2. **Expiry Sensitivity**: Advancing ledger time past `expires_at` (`now + 400d`) dynamically reduces `p_limited` from `56 -> 0` inside `get_credit_score` without requiring a keeper transaction.
3. **Self-Report / Sybil Immunity**: Self-reports yield `0 / 100` identically to empty wallets (`p_self_only == p_empty == 0`).
4. **Community Uplift Bounds**: Adding maximal escrowed community vouches (`C=100` + `activity` bump) yields `+13` points (`56 -> 69` on `p_limited -> p_community`) — enough to help thin-file borrowers with verified baseline cashflows cross the `60` threshold, but insufficient by itself (`10% * 100 + 10% * 30 = 13`) for a zero-history attacker to reach the minimum borrowing threshold (`50`).

### Honest Trade-Offs, Bias Risks & Uncalibrated Limitations
- **False-Negative Risk (Thin-File / Issuer Dependency)**: Honest borrowers in regions without an onboarded authorized attestation issuer score `0` until at least one issuer verifies their payment/savings records or escrowed history builds up.
- **False-Positive / Activity Count Interaction (Profile #5 vs #2)**: Notice Profile #5 (*Inconsistent Repayment*, `61`) sits near Profile #2 (*Average*, `66`) even with 2 late repayments because `verified_activity_items = 7` lifted `activity_score` from `60 -> 85`. Although `61 < 66` and `12%` APR applies correctly, rewarding total completed transactions alongside volatility metrics can partially mask variance unless volatility penalties are introduced in a future `Model v3`.
- **Non-Predictive Empirical Calibration Disclaimer**: Weights (`35/25/20/10/10`) are deterministic heuristic risk policies audited for monotonicity and abuse resistance — they are **not** empirically trained or backtested against real historical default/loss-given-default datasets. Production deployment requires statistical calibration (ROC-AUC / KS / Brier tracking) once real borrower cohort outcomes exist.

---

## 5. Verification Status Table

| Requirement | Status | Evidence |
| --- | --- | --- |
| Deterministic 5-pillar formula & `Model v2` bounds `[0, 100]` | **COMPLETED AND VERIFIED** | `test_synthetic_borrower_profiles_matrix_and_sensitivity` (exact equality across all 8 profiles) |
| Zero-weight self-reported isolation | **COMPLETED AND VERIFIED** | `test_self_reported_records_never_inflate_credit_score` + Testnet live tx `submit_self_reported_record` |
| On-chain Ed25519 signature, replay block, & time expiry | **COMPLETED AND VERIFIED** | `test_signed_attestation_ed25519_verification_replay_and_tamper_resistance`, `test_adversarial_attestation_and_cross_contract_guards` |
| Issuer revocation for cause vs key rotation | **COMPLETED AND VERIFIED** | `test_issuer_revocation_and_attestation_expiry_and_loan_defaults`, `test_issuer_rotation_...` |
| Empirical production PD/LGD calibration | **NOT IMPLEMENTED** | Requires real historical lending cohort outcome dataset (out of scope for synthetic Testnet phase) |
