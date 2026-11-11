# Credit Scoring Model Validation (`Model v2`)

> Audit and validation summary of [`contracts/credit_score/src/lib.rs`](contracts/credit_score/src/lib.rs) and [`contracts/credit_score/src/types.rs`](contracts/credit_score/src/types.rs).

## 1. Status & Integrity Controls

- **Model Version**: `SCORING_MODEL_VERSION = 2` ([`contracts/credit_score/src/types.rs`](contracts/credit_score/src/types.rs))
- **Authoritative Input Gate**: Authoritative scores (`get_credit_score`, `get_score_breakdown`) compute strictly from:
  1. **Issuer-Attested Financial Records** submitted either directly by an authorized issuer (`submit_attestation`, `batch_submit_attestations`) or submitted non-custodially with an on-chain verified Ed25519 signature (`submit_signed_attestation` invoking `env.crypto().ed25519_verify` over domain-separated payload `CREDITLEDGER-ATTEST-V1 || contract || attestation_id || subject || issuer || kind || record_commitment || metric_score || amount_units || duration_months || issued_at || expires_at`).
  2. **Loan Outcomes** recorded only by the configured `LoanManagerContract` (`record_loan_outcome`).
  3. **Escrowed Community Vouches** synced only by the configured `CommunityVouchContract` (`add_community_vouch`, `remove_community_vouch`).
- **Self-Reported Isolation**: `submit_self_reported_record` stores non-authoritative metadata commitments (`UserSelfReportAt`) solely for manual off-chain inspection. Self-reported records contribute **0%** weight to authoritative scores (`self_reported_count` is reported separately in `ScoreBreakdown`).

## 2. Five-Pillar Weighted Scoring Formula

Let $P \in [0, 100]$ (`payment_history_score`), $S \in [0, 100]$ (`savings_score`), $R \in [0, 100]$ (`repayment_score`), $C \in [0, 100]$ (`community_score`), and $A \in [0, 100]$ (`activity_score`):

$$\text{weighted\_raw} = \frac{35 P + 25 S + 20 R + 10 C + 10 A}{100}$$
$$\text{default\_penalty} = \min(100,\; 25 \times \text{defaulted\_count})$$
$$\text{final\_score} = \max(0,\; \text{weighted\_raw} - \text{default\_penalty})$$

### Pillar Computations & Protections
- **Payment History (35%)**: Recency-weighted mean of active non-revoked, non-expired `ATTESTATION_KIND_PAYMENT` attestations (`<= 180d` weight `100`, `181d–365d` weight `75`, `> 365d` weight `50`) plus breadth bonus (`>= 3`: `+5`, `>= 6`: `+10`, `>= 12`: `+15`), capped at `100`.
- **Savings Reserves (25%)**: Recency-weighted mean of active `ATTESTATION_KIND_SAVINGS` attestations plus average duration bonus (`>= 3m`: `+5`, `>= 6m`: `+10`, `>= 12m`: `+20`), capped at `100`.
- **Loan Repayment History (20%)**: `50 + 12 * on_time_count + 3 * late_count` capped at `100`, minus `50 * defaulted_count` (saturating at `0`). Users with verified financial attestations and zero closed loans start neutral at `50`; unverified accounts start at `0`.
- **Community Vouching (10%)**: Mean policy-derived `trust_score` across active, non-expired `UserVouchEntry` items plus total escrowed stake bonus (`>= 100_000`: `+5`, `>= 500_000`: `+10`, `>= 1_000_000`: `+15`), capped at `100`.
- **Activity & Diversity (10%)**: Tiers on `verified_activity_items` (`0 -> 0`, `1..2 -> 30`, `3..5 -> 60`, `6..10 -> 85`, `11+ -> 100`).

## 3. Abuse, Sybil & Key Compromise Defenses

- **Replay Resistance**: Each attestation carries a unique 32-byte `attestation_id` persisted under `DataKey::Attestation(id)`; duplicate submissions fail with `DuplicateAttestation`.
- **Expiry Enforcement**: `issued_at <= now + 300s` (`MAX_FUTURE_DRIFT_SECS`) and `expires_at > now` enforced both at admission and dynamically inside `compute_breakdown`.
- **Revocation for Cause & Key Rotation**:
  - `revoke_issuer(issuer)` sets `authorized = false` and `revoked_for_cause = true`, immediately discounting prior attestations from that compromised issuer during `compute_breakdown`.
  - `rotate_issuer_key(old_issuer, new_issuer, new_vk)` requires dual authorization (`admin.require_auth()` + `new_issuer.require_auth()`), deactivates the old key without setting `revoked_for_cause` so historical legitimate attestations remain valid, and blocks future submissions under the old key.
- **Individual Attestation Revocation**: `revoke_attestation(attestation_id)` allows either the issuing institution or contract admin to invalidate a specific attestation.

## 4. Verification Status

| Requirement | Status | Evidence |
| --- | --- | --- |
| Zero-weight self-reported isolation | **IMPLEMENTED AND VERIFIED** | [`contracts/credit_score/src/tests.rs`](contracts/credit_score/src/tests.rs) + Testnet live tx `submit_self_reported_record` |
| On-chain Ed25519 signed attestation & replay block | **IMPLEMENTED AND VERIFIED** | `test_signed_attestation_ed25519_verification_replay_and_tamper_resistance` |
| Issuer key rotation & revocation for cause | **IMPLEMENTED AND VERIFIED** | `test_issuer_rotation_...`, `test_issuer_revocation_...` |
| Batch size (`<= 25`), pagination (`<= 50`), TTL bump | **IMPLEMENTED AND VERIFIED** | `test_batch_limits_pagination_and_ttl_extension` |
