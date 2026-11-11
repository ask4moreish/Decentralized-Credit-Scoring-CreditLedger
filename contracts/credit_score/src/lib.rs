#![no_std]

mod errors;
mod types;

pub use errors::CreditScoreError;
pub use types::{
    AttestationInput, CreditScoreData, FinancialAttestation, IssuerInfo, LoanOutcomeStats,
    ScoreBreakdown, SelfReportInput, SelfReportedRecord, VouchSummary, ATTESTATION_KIND_PAYMENT,
    ATTESTATION_KIND_SAVINGS, MAX_BATCH_SIZE, MAX_PAGE_SIZE, MAX_SCORE, SCORING_MODEL_VERSION,
};

use soroban_sdk::{
    contract, contractimpl, panic_with_error, symbol_short, xdr::ToXdr, Address, Bytes, BytesN,
    Env, String, Vec,
};
use types::{
    DataKey, INSTANCE_TTL_EXTEND, INSTANCE_TTL_THRESHOLD, MAX_FUTURE_DRIFT_SECS, MID_WINDOW_SECS,
    PERSISTENT_TTL_EXTEND, PERSISTENT_TTL_THRESHOLD, RECENT_WINDOW_SECS,
};

#[contract]
pub struct CreditScoreContract;

#[contractimpl]
impl CreditScoreContract {
    // ── Initialization & Governance ───────────────────────────────────────────

    pub fn initialize(env: Env, admin: Address) -> Result<(), CreditScoreError> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(CreditScoreError::AlreadyInitialized);
        }
        admin.require_auth();

        env.storage().instance().set(&DataKey::Initialized, &true);
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().set(&DataKey::IssuerCount, &0u32);
        Self::bump_instance(&env);

        env.events().publish((symbol_short!("init"),), admin);
        Ok(())
    }

    pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), CreditScoreError> {
        Self::require_initialized(&env)?;
        let admin = Self::require_admin(&env)?;
        if new_admin == admin || new_admin == env.current_contract_address() {
            return Err(CreditScoreError::SameAdmin);
        }
        env.storage()
            .instance()
            .set(&DataKey::PendingAdmin, &new_admin);
        Self::bump_instance(&env);
        env.events()
            .publish((symbol_short!("adm_prop"), admin), new_admin);
        Ok(())
    }

    pub fn accept_admin(env: Env) -> Result<(), CreditScoreError> {
        Self::require_initialized(&env)?;
        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .ok_or(CreditScoreError::NoPendingAdmin)?;
        pending.require_auth();

        env.storage().instance().set(&DataKey::Admin, &pending);
        env.storage().instance().remove(&DataKey::PendingAdmin);
        Self::bump_instance(&env);
        env.events().publish((symbol_short!("adm_acc"),), pending);
        Ok(())
    }

    pub fn pause(env: Env) -> Result<(), CreditScoreError> {
        Self::require_initialized(&env)?;
        let admin = Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &true);
        Self::bump_instance(&env);
        env.events().publish((symbol_short!("paused"),), admin);
        Ok(())
    }

    pub fn unpause(env: Env) -> Result<(), CreditScoreError> {
        Self::require_initialized(&env)?;
        let admin = Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &false);
        Self::bump_instance(&env);
        env.events().publish((symbol_short!("unpaused"),), admin);
        Ok(())
    }

    pub fn get_admin(env: Env) -> Result<Address, CreditScoreError> {
        Self::require_initialized(&env)?;
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(CreditScoreError::NotInitialized)
    }

    pub fn get_pending_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::PendingAdmin)
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    pub fn get_model_version(_env: Env) -> u32 {
        SCORING_MODEL_VERSION
    }

    pub fn set_community_vouch_contract(
        env: Env,
        community_vouch_contract: Address,
    ) -> Result<(), CreditScoreError> {
        Self::require_initialized(&env)?;
        Self::require_admin(&env)?;
        if community_vouch_contract == env.current_contract_address() {
            return Err(CreditScoreError::InvalidInput);
        }
        env.storage()
            .instance()
            .set(&DataKey::CommunityVouchContract, &community_vouch_contract);
        Self::bump_instance(&env);
        Ok(())
    }

    pub fn set_loan_manager_contract(
        env: Env,
        loan_manager_contract: Address,
    ) -> Result<(), CreditScoreError> {
        Self::require_initialized(&env)?;
        Self::require_admin(&env)?;
        if loan_manager_contract == env.current_contract_address() {
            return Err(CreditScoreError::InvalidInput);
        }
        env.storage()
            .instance()
            .set(&DataKey::LoanManagerContract, &loan_manager_contract);
        Self::bump_instance(&env);
        Ok(())
    }

    // ── Trusted Attestation Issuer Registry ───────────────────────────────────

    pub fn register_issuer(
        env: Env,
        issuer: Address,
        verification_key: BytesN<32>,
        category: u32,
        name: String,
        metadata_uri: String,
    ) -> Result<(), CreditScoreError> {
        Self::require_initialized(&env)?;
        Self::require_not_paused(&env)?;
        Self::require_admin(&env)?;

        if issuer == env.current_contract_address()
            || Self::is_zero_bytes32(&verification_key)
            || !(1..=4).contains(&category)
            || name.is_empty()
            || name.len() > 96
            || metadata_uri.len() > 200
        {
            return Err(CreditScoreError::InvalidInput);
        }

        let key = DataKey::Issuer(issuer.clone());
        let existing: Option<IssuerInfo> = env.storage().persistent().get(&key);
        if let Some(prev) = existing {
            if prev.authorized {
                return Err(CreditScoreError::IssuerAlreadyExists);
            }
        } else {
            let count: u32 = env
                .storage()
                .instance()
                .get(&DataKey::IssuerCount)
                .unwrap_or(0);
            env.storage()
                .persistent()
                .set(&DataKey::IssuerAt(count), &issuer);
            Self::bump_persistent(&env, &DataKey::IssuerAt(count));
            env.storage()
                .instance()
                .set(&DataKey::IssuerCount, &(count + 1));
        }

        let info = IssuerInfo {
            issuer: issuer.clone(),
            verification_key,
            category,
            name,
            metadata_uri,
            authorized: true,
            revoked_for_cause: false,
            registered_at: env.ledger().timestamp(),
            revoked_at: 0,
        };
        env.storage().persistent().set(&key, &info);
        Self::bump_persistent(&env, &key);
        Self::bump_instance(&env);

        env.events().publish((symbol_short!("iss_reg"),), issuer);
        Ok(())
    }

    pub fn revoke_issuer(env: Env, issuer: Address) -> Result<(), CreditScoreError> {
        Self::require_initialized(&env)?;
        Self::require_admin(&env)?;

        let key = DataKey::Issuer(issuer.clone());
        let mut info: IssuerInfo = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(CreditScoreError::IssuerNotAuthorized)?;
        info.authorized = false;
        info.revoked_for_cause = true;
        info.revoked_at = env.ledger().timestamp();
        env.storage().persistent().set(&key, &info);
        Self::bump_persistent(&env, &key);
        Self::bump_instance(&env);

        env.events().publish((symbol_short!("iss_rev"),), issuer);
        Ok(())
    }

    /// Dual-authorized institutional key rotation: requires both current admin AND incoming issuer key.
    pub fn rotate_issuer_key(
        env: Env,
        old_issuer: Address,
        new_issuer: Address,
        new_verification_key: BytesN<32>,
    ) -> Result<(), CreditScoreError> {
        Self::require_initialized(&env)?;
        Self::require_not_paused(&env)?;
        Self::require_admin(&env)?;
        new_issuer.require_auth();

        if new_issuer == old_issuer
            || new_issuer == env.current_contract_address()
            || Self::is_zero_bytes32(&new_verification_key)
        {
            return Err(CreditScoreError::InvalidInput);
        }

        let old_key = DataKey::Issuer(old_issuer.clone());
        let mut old_info: IssuerInfo = env
            .storage()
            .persistent()
            .get(&old_key)
            .ok_or(CreditScoreError::IssuerNotAuthorized)?;
        if !old_info.authorized {
            return Err(CreditScoreError::IssuerNotAuthorized);
        }

        let new_key = DataKey::Issuer(new_issuer.clone());
        if let Some(prev_new) = env.storage().persistent().get::<_, IssuerInfo>(&new_key) {
            if prev_new.authorized {
                return Err(CreditScoreError::IssuerAlreadyExists);
            }
        } else {
            let count: u32 = env
                .storage()
                .instance()
                .get(&DataKey::IssuerCount)
                .unwrap_or(0);
            env.storage()
                .persistent()
                .set(&DataKey::IssuerAt(count), &new_issuer);
            Self::bump_persistent(&env, &DataKey::IssuerAt(count));
            env.storage()
                .instance()
                .set(&DataKey::IssuerCount, &(count + 1));
        }

        let now = env.ledger().timestamp();
        old_info.authorized = false;
        old_info.revoked_at = now;
        env.storage().persistent().set(&old_key, &old_info);
        Self::bump_persistent(&env, &old_key);

        let new_info = IssuerInfo {
            issuer: new_issuer.clone(),
            verification_key: new_verification_key,
            category: old_info.category,
            name: old_info.name,
            metadata_uri: old_info.metadata_uri,
            authorized: true,
            revoked_for_cause: false,
            registered_at: now,
            revoked_at: 0,
        };
        env.storage().persistent().set(&new_key, &new_info);
        Self::bump_persistent(&env, &new_key);
        Self::bump_instance(&env);

        env.events()
            .publish((symbol_short!("iss_rot"), old_issuer), new_issuer);
        Ok(())
    }

    pub fn get_issuer(env: Env, issuer: Address) -> Option<IssuerInfo> {
        env.storage().persistent().get(&DataKey::Issuer(issuer))
    }

    pub fn is_issuer_authorized(env: Env, issuer: Address) -> bool {
        env.storage()
            .persistent()
            .get::<_, IssuerInfo>(&DataKey::Issuer(issuer))
            .map(|i| i.authorized)
            .unwrap_or(false)
    }

    // ── Verified Financial Attestations ───────────────────────────────────────

    /// Direct submission by an actively authorized institutional issuer.
    pub fn submit_attestation(
        env: Env,
        issuer: Address,
        input: AttestationInput,
    ) -> Result<(), CreditScoreError> {
        Self::require_initialized(&env)?;
        Self::require_not_paused(&env)?;
        issuer.require_auth();

        let issuer_info = Self::require_active_issuer(&env, &issuer)?;
        let _ = issuer_info;

        Self::store_verified_attestation(&env, &issuer, &input)?;
        Self::recalculate_credit_score(&env, &input.subject);
        Ok(())
    }

    /// Bounded batch issuance by an authorized issuer (max MAX_BATCH_SIZE = 25). Atomic rollback on any invalid item.
    pub fn batch_submit_attestations(
        env: Env,
        issuer: Address,
        inputs: Vec<AttestationInput>,
    ) -> Result<u32, CreditScoreError> {
        Self::require_initialized(&env)?;
        Self::require_not_paused(&env)?;
        issuer.require_auth();

        Self::require_active_issuer(&env, &issuer)?;

        let len = inputs.len();
        if len == 0 || len > MAX_BATCH_SIZE {
            return Err(CreditScoreError::BatchTooLarge);
        }

        for input in inputs.iter() {
            Self::store_verified_attestation(&env, &issuer, &input)?;
            Self::recalculate_credit_score(&env, &input.subject);
        }

        Ok(len)
    }

    /// Non-custodial user-relayed attestation verified on-chain with the registered issuer's Ed25519 signature.
    pub fn submit_signed_attestation(
        env: Env,
        subject: Address,
        issuer: Address,
        input: AttestationInput,
        signature: BytesN<64>,
    ) -> Result<(), CreditScoreError> {
        Self::require_initialized(&env)?;
        Self::require_not_paused(&env)?;
        subject.require_auth();

        if input.subject != subject {
            return Err(CreditScoreError::Unauthorized);
        }

        let issuer_info = Self::require_active_issuer(&env, &issuer)?;
        let message = Self::build_attestation_message(env.clone(), issuer.clone(), input.clone());
        env.crypto()
            .ed25519_verify(&issuer_info.verification_key, &message, &signature);

        Self::store_verified_attestation(&env, &issuer, &input)?;
        Self::recalculate_credit_score(&env, &input.subject);
        Ok(())
    }

    /// Revokes an existing attestation (only callable by its issuer or contract admin). Immediately recalculates score.
    pub fn revoke_attestation(
        env: Env,
        caller: Address,
        attestation_id: BytesN<32>,
    ) -> Result<(), CreditScoreError> {
        Self::require_initialized(&env)?;
        caller.require_auth();

        let admin = Self::get_admin_unchecked(&env)?;
        let key = DataKey::Attestation(attestation_id.clone());
        let mut att: FinancialAttestation = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(CreditScoreError::AttestationNotFound)?;

        if caller != admin && caller != att.issuer {
            return Err(CreditScoreError::Unauthorized);
        }
        if att.revoked {
            return Err(CreditScoreError::AttestationRevoked);
        }

        att.revoked = true;
        att.revoked_at = env.ledger().timestamp();
        env.storage().persistent().set(&key, &att);
        Self::bump_persistent(&env, &key);

        Self::recalculate_credit_score(&env, &att.subject);
        env.events()
            .publish((symbol_short!("att_rev"),), attestation_id);
        Ok(())
    }

    // ── Supplementary Self-Reported Records (Non-Authoritative, Zero Weight) ──

    /// Allows users to anchor optional self-reported financial receipts as supplementary metadata only.
    /// Does NOT affect credit score or eligibility thresholds.
    pub fn submit_self_reported_record(
        env: Env,
        user: Address,
        input: SelfReportInput,
    ) -> Result<(), CreditScoreError> {
        Self::require_initialized(&env)?;
        Self::require_not_paused(&env)?;
        user.require_auth();

        if !(1..=2).contains(&input.kind)
            || Self::is_zero_bytes32(&input.record_commitment)
            || input.claimed_amount == 0
            || input.claimed_metric > MAX_SCORE
            || input.timestamp == 0
            || input.timestamp
                > env
                    .ledger()
                    .timestamp()
                    .saturating_add(MAX_FUTURE_DRIFT_SECS)
        {
            return Err(CreditScoreError::InvalidInput);
        }
        if input.kind == ATTESTATION_KIND_SAVINGS
            && (input.duration_months == 0 || input.duration_months > 120)
        {
            return Err(CreditScoreError::InvalidInput);
        }

        let count_key = DataKey::UserSelfReportCount(user.clone());
        let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
        let item_key = DataKey::UserSelfReportAt(user.clone(), count);
        let record = SelfReportedRecord {
            record_commitment: input.record_commitment,
            kind: input.kind,
            claimed_amount: input.claimed_amount,
            claimed_metric: input.claimed_metric,
            duration_months: input.duration_months,
            timestamp: input.timestamp,
            verified: false,
        };
        env.storage().persistent().set(&item_key, &record);
        env.storage().persistent().set(&count_key, &(count + 1));
        Self::bump_persistent(&env, &item_key);
        Self::bump_persistent(&env, &count_key);

        // Intentionally does NOT reward CreditScoreData.score; only updates snapshot safely.
        Self::recalculate_credit_score(&env, &user);
        Ok(())
    }

    // ── Cross-Contract Hooks (CommunityVouch & LoanManager) ───────────────────

    pub fn add_community_vouch(
        env: Env,
        vouch_id: u64,
        user: Address,
        voucher: Address,
        escrowed_amount: u128,
        trust_score: u32,
        expires_at: u64,
    ) -> Result<(), CreditScoreError> {
        Self::require_initialized(&env)?;
        let cv_contract: Address = env
            .storage()
            .instance()
            .get(&DataKey::CommunityVouchContract)
            .ok_or(CreditScoreError::Unauthorized)?;
        cv_contract.require_auth();

        if vouch_id == 0 || escrowed_amount == 0 || trust_score > MAX_SCORE || user == voucher {
            return Err(CreditScoreError::InvalidInput);
        }

        let entry = VouchSummary {
            vouch_id,
            voucher,
            escrowed_amount,
            trust_score,
            expires_at,
            updated_at: env.ledger().timestamp(),
        };

        let entry_key = DataKey::UserVouchEntry(user.clone(), vouch_id);
        let pos_key = DataKey::UserVouchPos(user.clone(), vouch_id);
        if !env.storage().persistent().has(&pos_key) {
            let count_key = DataKey::UserActiveVouchCount(user.clone());
            let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
            env.storage().persistent().set(
                &DataKey::UserActiveVouchIdAt(user.clone(), count),
                &vouch_id,
            );
            Self::bump_persistent(&env, &DataKey::UserActiveVouchIdAt(user.clone(), count));
            env.storage().persistent().set(&pos_key, &count);
            Self::bump_persistent(&env, &pos_key);
            env.storage().persistent().set(&count_key, &(count + 1));
            Self::bump_persistent(&env, &count_key);
        }
        env.storage().persistent().set(&entry_key, &entry);
        Self::bump_persistent(&env, &entry_key);

        Self::recalculate_credit_score(&env, &user);
        Ok(())
    }

    pub fn remove_community_vouch(
        env: Env,
        user: Address,
        vouch_id: u64,
    ) -> Result<(), CreditScoreError> {
        Self::require_initialized(&env)?;
        let cv_contract: Address = env
            .storage()
            .instance()
            .get(&DataKey::CommunityVouchContract)
            .ok_or(CreditScoreError::Unauthorized)?;
        cv_contract.require_auth();

        let pos_key = DataKey::UserVouchPos(user.clone(), vouch_id);
        let pos_opt: Option<u32> = env.storage().persistent().get(&pos_key);
        if let Some(pos) = pos_opt {
            let count_key = DataKey::UserActiveVouchCount(user.clone());
            let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
            if count > 0 {
                let last_idx = count - 1;
                if pos != last_idx {
                    let last_id: u64 = env
                        .storage()
                        .persistent()
                        .get(&DataKey::UserActiveVouchIdAt(user.clone(), last_idx))
                        .unwrap();
                    env.storage()
                        .persistent()
                        .set(&DataKey::UserActiveVouchIdAt(user.clone(), pos), &last_id);
                    Self::bump_persistent(&env, &DataKey::UserActiveVouchIdAt(user.clone(), pos));
                    env.storage()
                        .persistent()
                        .set(&DataKey::UserVouchPos(user.clone(), last_id), &pos);
                    Self::bump_persistent(&env, &DataKey::UserVouchPos(user.clone(), last_id));
                }
                env.storage()
                    .persistent()
                    .remove(&DataKey::UserActiveVouchIdAt(user.clone(), last_idx));
                env.storage().persistent().set(&count_key, &last_idx);
                Self::bump_persistent(&env, &count_key);
            }
            env.storage().persistent().remove(&pos_key);
            env.storage()
                .persistent()
                .remove(&DataKey::UserVouchEntry(user.clone(), vouch_id));

            Self::recalculate_credit_score(&env, &user);
        }
        Ok(())
    }

    pub fn record_loan_outcome(
        env: Env,
        borrower: Address,
        on_time: bool,
        defaulted: bool,
    ) -> Result<(), CreditScoreError> {
        Self::require_initialized(&env)?;
        let lm_contract: Address = env
            .storage()
            .instance()
            .get(&DataKey::LoanManagerContract)
            .ok_or(CreditScoreError::Unauthorized)?;
        lm_contract.require_auth();

        let key = DataKey::UserLoanStats(borrower.clone());
        let mut stats: LoanOutcomeStats =
            env.storage()
                .persistent()
                .get(&key)
                .unwrap_or(LoanOutcomeStats {
                    repaid_count: 0,
                    on_time_count: 0,
                    late_count: 0,
                    defaulted_count: 0,
                    last_event_at: 0,
                });

        if defaulted {
            stats.defaulted_count = stats.defaulted_count.saturating_add(1);
        } else {
            stats.repaid_count = stats.repaid_count.saturating_add(1);
            if on_time {
                stats.on_time_count = stats.on_time_count.saturating_add(1);
            } else {
                stats.late_count = stats.late_count.saturating_add(1);
            }
        }
        stats.last_event_at = env.ledger().timestamp();
        env.storage().persistent().set(&key, &stats);
        Self::bump_persistent(&env, &key);

        Self::recalculate_credit_score(&env, &borrower);
        Ok(())
    }

    // ── Read & Bounded Paginated Views ────────────────────────────────────────

    /// Returns the deterministic 0..=100 score evaluated dynamically against current ledger timestamp
    /// so expired attestations and expired vouches lose weight immediately.
    pub fn get_credit_score(env: Env, user: Address) -> CreditScoreData {
        let breakdown = Self::compute_breakdown(&env, &user);
        CreditScoreData {
            score: breakdown.score,
            last_updated: breakdown.last_updated,
            payment_history_score: breakdown.payment_history_score,
            savings_score: breakdown.savings_score,
            community_score: breakdown.community_score,
            activity_score: breakdown.activity_score,
        }
    }

    pub fn get_score_breakdown(env: Env, user: Address) -> ScoreBreakdown {
        Self::compute_breakdown(&env, &user)
    }

    pub fn refresh_credit_score(
        env: Env,
        user: Address,
    ) -> Result<CreditScoreData, CreditScoreError> {
        Self::require_initialized(&env)?;
        Ok(Self::recalculate_credit_score(&env, &user))
    }

    pub fn is_creditworthy(env: Env, user: Address, min_score: u32) -> bool {
        Self::get_credit_score(env, user).score >= min_score
    }

    pub fn get_attestation(env: Env, attestation_id: BytesN<32>) -> Option<FinancialAttestation> {
        env.storage()
            .persistent()
            .get(&DataKey::Attestation(attestation_id))
    }

    pub fn get_user_attestations_page(
        env: Env,
        user: Address,
        cursor: u32,
        limit: u32,
    ) -> Result<Vec<FinancialAttestation>, CreditScoreError> {
        if limit == 0 || limit > MAX_PAGE_SIZE {
            return Err(CreditScoreError::InvalidPageLimit);
        }
        let count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::UserAttestationCount(user.clone()))
            .unwrap_or(0);
        let mut out = Vec::new(&env);
        let end = cursor.saturating_add(limit).min(count);
        let mut idx = cursor;
        while idx < end {
            if let Some(id) = env
                .storage()
                .persistent()
                .get::<_, BytesN<32>>(&DataKey::UserAttestationIdAt(user.clone(), idx))
            {
                if let Some(att) = env
                    .storage()
                    .persistent()
                    .get::<_, FinancialAttestation>(&DataKey::Attestation(id))
                {
                    out.push_back(att);
                }
            }
            idx += 1;
        }
        Ok(out)
    }

    pub fn get_self_reported_page(
        env: Env,
        user: Address,
        cursor: u32,
        limit: u32,
    ) -> Result<Vec<SelfReportedRecord>, CreditScoreError> {
        if limit == 0 || limit > MAX_PAGE_SIZE {
            return Err(CreditScoreError::InvalidPageLimit);
        }
        let count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::UserSelfReportCount(user.clone()))
            .unwrap_or(0);
        let mut out = Vec::new(&env);
        let end = cursor.saturating_add(limit).min(count);
        let mut idx = cursor;
        while idx < end {
            if let Some(rec) = env
                .storage()
                .persistent()
                .get::<_, SelfReportedRecord>(&DataKey::UserSelfReportAt(user.clone(), idx))
            {
                out.push_back(rec);
            }
            idx += 1;
        }
        Ok(out)
    }

    /// Permissionless keeper maintenance method to extend TTL for inactive accounts before archival.
    pub fn extend_user_ttl(
        env: Env,
        user: Address,
        max_items: u32,
    ) -> Result<u32, CreditScoreError> {
        Self::require_initialized(&env)?;
        Self::bump_instance(&env);

        let mut extended = 0u32;
        for key in [
            DataKey::UserCreditScore(user.clone()),
            DataKey::UserLoanStats(user.clone()),
            DataKey::UserAttestationCount(user.clone()),
            DataKey::UserActiveVouchCount(user.clone()),
            DataKey::UserSelfReportCount(user.clone()),
        ] {
            if env.storage().persistent().has(&key) {
                Self::bump_persistent(&env, &key);
                extended += 1;
            }
        }

        let att_count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::UserAttestationCount(user.clone()))
            .unwrap_or(0)
            .min(max_items);
        let mut idx = 0u32;
        while idx < att_count {
            let idx_key = DataKey::UserAttestationIdAt(user.clone(), idx);
            if let Some(id) = env.storage().persistent().get::<_, BytesN<32>>(&idx_key) {
                Self::bump_persistent(&env, &idx_key);
                let att_key = DataKey::Attestation(id);
                if env.storage().persistent().has(&att_key) {
                    Self::bump_persistent(&env, &att_key);
                }
                extended += 1;
            }
            idx += 1;
        }
        Ok(extended)
    }

    /// Exposes the exact domain-separated attestation message that issuers sign off-chain.
    pub fn build_attestation_message(env: Env, issuer: Address, input: AttestationInput) -> Bytes {
        let mut msg = Bytes::from_slice(&env, b"CREDITLEDGER-ATTEST-V1");
        msg.append(&env.current_contract_address().to_xdr(&env));
        msg.append(&Bytes::from_slice(&env, &input.attestation_id.to_array()));
        msg.append(&input.subject.to_xdr(&env));
        msg.append(&issuer.to_xdr(&env));
        msg.append(&Bytes::from_slice(&env, &input.kind.to_be_bytes()));
        msg.append(&Bytes::from_slice(
            &env,
            &input.record_commitment.to_array(),
        ));
        msg.append(&Bytes::from_slice(&env, &input.metric_score.to_be_bytes()));
        msg.append(&Bytes::from_slice(&env, &input.amount_units.to_be_bytes()));
        msg.append(&Bytes::from_slice(
            &env,
            &input.duration_months.to_be_bytes(),
        ));
        msg.append(&Bytes::from_slice(&env, &input.issued_at.to_be_bytes()));
        msg.append(&Bytes::from_slice(&env, &input.expires_at.to_be_bytes()));
        msg
    }

    // ── Internal Helpers ──────────────────────────────────────────────────────

    fn store_verified_attestation(
        env: &Env,
        issuer: &Address,
        input: &AttestationInput,
    ) -> Result<(), CreditScoreError> {
        let now = env.ledger().timestamp();

        if Self::is_zero_bytes32(&input.attestation_id)
            || Self::is_zero_bytes32(&input.record_commitment)
            || !(1..=2).contains(&input.kind)
            || input.amount_units == 0
            || input.subject == env.current_contract_address()
            || input.subject == *issuer
        {
            return Err(CreditScoreError::InvalidInput);
        }
        if input.metric_score > MAX_SCORE {
            return Err(CreditScoreError::InvalidScoreRange);
        }
        if input.kind == ATTESTATION_KIND_SAVINGS
            && (input.duration_months == 0 || input.duration_months > 120)
        {
            return Err(CreditScoreError::InvalidInput);
        }
        if input.issued_at == 0
            || input.issued_at > now.saturating_add(MAX_FUTURE_DRIFT_SECS)
            || input.expires_at <= input.issued_at
        {
            return Err(CreditScoreError::InvalidTimestamp);
        }
        if input.expires_at <= now {
            return Err(CreditScoreError::AttestationExpired);
        }

        let att_key = DataKey::Attestation(input.attestation_id.clone());
        if env.storage().persistent().has(&att_key) {
            return Err(CreditScoreError::DuplicateAttestation);
        }

        let record = FinancialAttestation {
            attestation_id: input.attestation_id.clone(),
            subject: input.subject.clone(),
            issuer: issuer.clone(),
            kind: input.kind,
            record_commitment: input.record_commitment.clone(),
            metric_score: input.metric_score,
            amount_units: input.amount_units,
            duration_months: input.duration_months,
            issued_at: input.issued_at,
            expires_at: input.expires_at,
            revoked: false,
            revoked_at: 0,
        };
        env.storage().persistent().set(&att_key, &record);
        Self::bump_persistent(env, &att_key);

        let count_key = DataKey::UserAttestationCount(input.subject.clone());
        let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
        let idx_key = DataKey::UserAttestationIdAt(input.subject.clone(), count);
        env.storage()
            .persistent()
            .set(&idx_key, &input.attestation_id);
        env.storage().persistent().set(&count_key, &(count + 1));
        Self::bump_persistent(env, &idx_key);
        Self::bump_persistent(env, &count_key);

        env.events().publish(
            (symbol_short!("att_add"), input.subject.clone()),
            input.attestation_id.clone(),
        );
        Ok(())
    }

    fn recalculate_credit_score(env: &Env, user: &Address) -> CreditScoreData {
        let breakdown = Self::compute_breakdown(env, user);
        let summary = CreditScoreData {
            score: breakdown.score,
            last_updated: breakdown.last_updated,
            payment_history_score: breakdown.payment_history_score,
            savings_score: breakdown.savings_score,
            community_score: breakdown.community_score,
            activity_score: breakdown.activity_score,
        };
        let key = DataKey::UserCreditScore(user.clone());
        env.storage().persistent().set(&key, &summary);
        Self::bump_persistent(env, &key);
        summary
    }

    fn compute_breakdown(env: &Env, user: &Address) -> ScoreBreakdown {
        let now = env.ledger().timestamp();
        let att_count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::UserAttestationCount(user.clone()))
            .unwrap_or(0);

        let mut pay_weighted_sum: u64 = 0;
        let mut pay_weight_total: u64 = 0;
        let mut valid_pay_count: u32 = 0;

        let mut sav_weighted_sum: u64 = 0;
        let mut sav_weight_total: u64 = 0;
        let mut sav_duration_sum: u64 = 0;
        let mut valid_sav_count: u32 = 0;

        // Scan most recent MAX_PAGE_SIZE * 2 attestations if a user ever accumulated many records
        let start = att_count.saturating_sub(100);
        let mut i = start;
        while i < att_count {
            if let Some(id) = env
                .storage()
                .persistent()
                .get::<_, BytesN<32>>(&DataKey::UserAttestationIdAt(user.clone(), i))
            {
                if let Some(att) = env
                    .storage()
                    .persistent()
                    .get::<_, FinancialAttestation>(&DataKey::Attestation(id))
                {
                    let issuer_trusted = env
                        .storage()
                        .persistent()
                        .get::<_, IssuerInfo>(&DataKey::Issuer(att.issuer.clone()))
                        .map(|iss| !iss.revoked_for_cause)
                        .unwrap_or(false);
                    if !att.revoked && issuer_trusted && att.expires_at > now {
                        let age = now.saturating_sub(att.issued_at);
                        let recency_w: u64 = if age <= RECENT_WINDOW_SECS {
                            100
                        } else if age <= MID_WINDOW_SECS {
                            75
                        } else {
                            50
                        };
                        if att.kind == ATTESTATION_KIND_PAYMENT {
                            pay_weighted_sum += att.metric_score as u64 * recency_w;
                            pay_weight_total += recency_w;
                            valid_pay_count += 1;
                        } else if att.kind == ATTESTATION_KIND_SAVINGS {
                            sav_weighted_sum += att.metric_score as u64 * recency_w;
                            sav_weight_total += recency_w;
                            sav_duration_sum += att.duration_months as u64;
                            valid_sav_count += 1;
                        }
                    }
                }
            }
            i += 1;
        }

        let loan_stats: LoanOutcomeStats = env
            .storage()
            .persistent()
            .get(&DataKey::UserLoanStats(user.clone()))
            .unwrap_or(LoanOutcomeStats {
                repaid_count: 0,
                on_time_count: 0,
                late_count: 0,
                defaulted_count: 0,
                last_event_at: 0,
            });

        let payment_history_score: u32 = if valid_pay_count > 0 {
            let avg = (pay_weighted_sum / pay_weight_total) as u32;
            let bonus = if valid_pay_count >= 12 {
                15
            } else if valid_pay_count >= 6 {
                10
            } else if valid_pay_count >= 3 {
                5
            } else {
                0
            };
            (avg + bonus).min(MAX_SCORE)
        } else {
            0
        };

        let savings_score: u32 = if valid_sav_count > 0 {
            let avg = (sav_weighted_sum / sav_weight_total) as u32;
            let avg_dur = (sav_duration_sum / valid_sav_count as u64) as u32;
            let bonus = if avg_dur >= 12 {
                20
            } else if avg_dur >= 6 {
                10
            } else if avg_dur >= 3 {
                5
            } else {
                0
            };
            (avg + bonus).min(MAX_SCORE)
        } else {
            0
        };

        let total_outcomes = loan_stats.repaid_count + loan_stats.defaulted_count;
        let repayment_score: u32 = if total_outcomes > 0 {
            let base = 50u32
                .saturating_add(loan_stats.on_time_count.saturating_mul(12))
                .saturating_add(loan_stats.late_count.saturating_mul(3))
                .min(MAX_SCORE);
            base.saturating_sub(loan_stats.defaulted_count.saturating_mul(50))
        } else if valid_pay_count + valid_sav_count > 0 {
            50
        } else {
            0
        };

        // Active escrowed vouches
        let vouch_count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::UserActiveVouchCount(user.clone()))
            .unwrap_or(0);
        let mut active_vouch_count: u32 = 0;
        let mut vouch_trust_sum: u64 = 0;
        let mut vouch_escrow_sum: u128 = 0;

        let mut vi = 0u32;
        while vi < vouch_count {
            if let Some(vid) = env
                .storage()
                .persistent()
                .get::<_, u64>(&DataKey::UserActiveVouchIdAt(user.clone(), vi))
            {
                if let Some(v) = env
                    .storage()
                    .persistent()
                    .get::<_, VouchSummary>(&DataKey::UserVouchEntry(user.clone(), vid))
                {
                    if v.expires_at == 0 || v.expires_at > now {
                        active_vouch_count += 1;
                        vouch_trust_sum += v.trust_score as u64;
                        vouch_escrow_sum = vouch_escrow_sum.saturating_add(v.escrowed_amount);
                    }
                }
            }
            vi += 1;
        }

        let community_score: u32 = if active_vouch_count > 0 {
            let avg_trust = (vouch_trust_sum / active_vouch_count as u64) as u32;
            let bonus = if vouch_escrow_sum >= 1_000_000 {
                15
            } else if vouch_escrow_sum >= 500_000 {
                10
            } else if vouch_escrow_sum >= 100_000 {
                5
            } else {
                0
            };
            (avg_trust + bonus).min(MAX_SCORE)
        } else {
            0
        };

        let verified_activity_items = valid_pay_count
            .saturating_add(valid_sav_count)
            .saturating_add(active_vouch_count)
            .saturating_add(loan_stats.repaid_count);

        let activity_score: u32 = match verified_activity_items {
            0 => 0,
            1..=2 => 30,
            3..=5 => 60,
            6..=10 => 85,
            _ => 100,
        };

        let default_penalty = loan_stats.defaulted_count.saturating_mul(25).min(MAX_SCORE);
        let weighted_raw = (payment_history_score * 35
            + savings_score * 25
            + repayment_score * 20
            + community_score * 10
            + activity_score * 10)
            / 100;
        let final_score = weighted_raw.saturating_sub(default_penalty).min(MAX_SCORE);

        let last_updated: u64 = env
            .storage()
            .persistent()
            .get::<_, CreditScoreData>(&DataKey::UserCreditScore(user.clone()))
            .map(|s| s.last_updated)
            .unwrap_or(if verified_activity_items > 0 { now } else { 0 });

        let self_reported_count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::UserSelfReportCount(user.clone()))
            .unwrap_or(0);

        ScoreBreakdown {
            model_version: SCORING_MODEL_VERSION,
            score: final_score,
            payment_history_score,
            savings_score,
            repayment_score,
            community_score,
            activity_score,
            weight_payment: 35,
            weight_savings: 25,
            weight_repayment: 20,
            weight_community: 10,
            weight_activity: 10,
            default_penalty,
            verified_payment_count: valid_pay_count,
            verified_savings_count: valid_sav_count,
            active_vouch_count,
            self_reported_count,
            repaid_loans: loan_stats.repaid_count,
            defaulted_loans: loan_stats.defaulted_count,
            last_updated,
        }
    }

    fn require_initialized(env: &Env) -> Result<(), CreditScoreError> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(CreditScoreError::NotInitialized);
        }
        Ok(())
    }

    fn require_not_paused(env: &Env) -> Result<(), CreditScoreError> {
        if Self::is_paused(env.clone()) {
            return Err(CreditScoreError::ContractPaused);
        }
        Ok(())
    }

    fn get_admin_unchecked(env: &Env) -> Result<Address, CreditScoreError> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(CreditScoreError::NotInitialized)
    }

    fn require_admin(env: &Env) -> Result<Address, CreditScoreError> {
        let admin = Self::get_admin_unchecked(env)?;
        admin.require_auth();
        Ok(admin)
    }

    fn require_active_issuer(env: &Env, issuer: &Address) -> Result<IssuerInfo, CreditScoreError> {
        let info: IssuerInfo = env
            .storage()
            .persistent()
            .get(&DataKey::Issuer(issuer.clone()))
            .ok_or(CreditScoreError::IssuerNotAuthorized)?;
        if !info.authorized {
            return Err(CreditScoreError::IssuerNotAuthorized);
        }
        Ok(info)
    }

    fn is_zero_bytes32(val: &BytesN<32>) -> bool {
        val.to_array() == [0u8; 32]
    }

    fn bump_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
    }

    fn bump_persistent(env: &Env, key: &DataKey) {
        env.storage()
            .persistent()
            .extend_ttl(key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
    }

    #[allow(dead_code)]
    fn fail(env: &Env, err: CreditScoreError) -> ! {
        panic_with_error!(env, err)
    }
}

mod tests;
