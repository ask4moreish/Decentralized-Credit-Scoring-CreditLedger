#![no_std]

mod errors;
mod types;

pub use errors::VouchError;
pub use types::{
    CreditScoreData, TrustNetwork, Vouch, VouchDataKey, VouchStatistics, VouchingLimits,
    MAX_DURATION_MONTHS, MAX_PAGE_SIZE, MAX_SLASH_BPS, MIN_VOUCH_AMOUNT,
};

use soroban_sdk::{
    contract, contractclient, contractimpl, symbol_short, token, Address, Env, String, Vec,
};
use types::{
    INSTANCE_TTL_EXTEND, INSTANCE_TTL_THRESHOLD, MAX_COOLDOWN_SECS, MAX_VOUCH_HARD_CAP,
    PERSISTENT_TTL_EXTEND, PERSISTENT_TTL_THRESHOLD, SECS_PER_MONTH,
};

#[contractclient(name = "CreditScoreContractClient")]
pub trait CreditScoreContract {
    fn get_credit_score(env: Env, user: Address) -> CreditScoreData;
    fn add_community_vouch(
        env: Env,
        vouch_id: u64,
        user: Address,
        voucher: Address,
        escrowed_amount: u128,
        trust_score: u32,
        expires_at: u64,
    );
    fn remove_community_vouch(env: Env, user: Address, vouch_id: u64);
}

#[contract]
pub struct CommunityVouchContract;

#[contractimpl]
impl CommunityVouchContract {
    // ── Initialization & Governance ───────────────────────────────────────────

    pub fn initialize(
        env: Env,
        admin: Address,
        credit_score_contract: Address,
        escrow_token: Address,
    ) -> Result<(), VouchError> {
        if env.storage().instance().has(&VouchDataKey::Initialized) {
            return Err(VouchError::AlreadyInitialized);
        }
        admin.require_auth();

        let self_addr = env.current_contract_address();
        if credit_score_contract == self_addr
            || escrow_token == self_addr
            || credit_score_contract == admin
            || escrow_token == admin
        {
            return Err(VouchError::InvalidInput);
        }

        env.storage()
            .instance()
            .set(&VouchDataKey::Initialized, &true);
        env.storage().instance().set(&VouchDataKey::Admin, &admin);
        env.storage().instance().set(&VouchDataKey::Paused, &false);
        env.storage()
            .instance()
            .set(&VouchDataKey::CreditScoreContract, &credit_score_contract);
        env.storage()
            .instance()
            .set(&VouchDataKey::EscrowToken, &escrow_token);
        env.storage()
            .instance()
            .set(&VouchDataKey::SlashingPool, &admin);
        env.storage()
            .instance()
            .set(&VouchDataKey::RevocationCooldownSecs, &0u64);
        env.storage()
            .instance()
            .set(&VouchDataKey::VouchCounter, &0u64);
        env.storage()
            .instance()
            .set(&VouchDataKey::TotalEscrowed, &0u128);
        env.storage()
            .instance()
            .set(&VouchDataKey::TotalSlashed, &0u128);
        Self::bump_instance(&env);

        env.events().publish((symbol_short!("cv_init"),), admin);
        Ok(())
    }

    pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), VouchError> {
        Self::require_initialized(&env)?;
        let admin = Self::require_admin(&env)?;
        if new_admin == admin || new_admin == env.current_contract_address() {
            return Err(VouchError::SameAdmin);
        }
        env.storage()
            .instance()
            .set(&VouchDataKey::PendingAdmin, &new_admin);
        Self::bump_instance(&env);
        Ok(())
    }

    pub fn accept_admin(env: Env) -> Result<(), VouchError> {
        Self::require_initialized(&env)?;
        let pending: Address = env
            .storage()
            .instance()
            .get(&VouchDataKey::PendingAdmin)
            .ok_or(VouchError::NoPendingAdmin)?;
        pending.require_auth();
        env.storage().instance().set(&VouchDataKey::Admin, &pending);
        env.storage().instance().remove(&VouchDataKey::PendingAdmin);
        Self::bump_instance(&env);
        Ok(())
    }

    pub fn pause(env: Env) -> Result<(), VouchError> {
        Self::require_initialized(&env)?;
        Self::require_admin(&env)?;
        env.storage().instance().set(&VouchDataKey::Paused, &true);
        Self::bump_instance(&env);
        Ok(())
    }

    pub fn unpause(env: Env) -> Result<(), VouchError> {
        Self::require_initialized(&env)?;
        Self::require_admin(&env)?;
        env.storage().instance().set(&VouchDataKey::Paused, &false);
        Self::bump_instance(&env);
        Ok(())
    }

    pub fn set_loan_manager_contract(
        env: Env,
        loan_manager: Address,
        slashing_pool: Address,
    ) -> Result<(), VouchError> {
        Self::require_initialized(&env)?;
        Self::require_admin(&env)?;
        if loan_manager == env.current_contract_address() {
            return Err(VouchError::InvalidInput);
        }
        env.storage()
            .instance()
            .set(&VouchDataKey::LoanManagerContract, &loan_manager);
        env.storage()
            .instance()
            .set(&VouchDataKey::SlashingPool, &slashing_pool);
        Self::bump_instance(&env);
        Ok(())
    }

    pub fn set_revocation_cooldown(env: Env, cooldown_secs: u64) -> Result<(), VouchError> {
        Self::require_initialized(&env)?;
        Self::require_admin(&env)?;
        if cooldown_secs > MAX_COOLDOWN_SECS {
            return Err(VouchError::InvalidInput);
        }
        env.storage()
            .instance()
            .set(&VouchDataKey::RevocationCooldownSecs, &cooldown_secs);
        Self::bump_instance(&env);
        Ok(())
    }

    pub fn get_admin(env: Env) -> Result<Address, VouchError> {
        Self::require_initialized(&env)?;
        env.storage()
            .instance()
            .get(&VouchDataKey::Admin)
            .ok_or(VouchError::NotInitialized)
    }

    pub fn get_pending_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&VouchDataKey::PendingAdmin)
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&VouchDataKey::Paused)
            .unwrap_or(false)
    }

    // ── Real SEP-41 Token-Escrowed Vouching ───────────────────────────────────

    /// Creates a real capital-backed vouch. Trust weight is derived strictly by protocol policy
    /// from the voucher's verified on-chain CreditScore and actual escrowed token stake.
    pub fn create_vouch(
        env: Env,
        voucher: Address,
        vouchee: Address,
        amount: u128,
        reason: String,
        duration_months: u32,
    ) -> Result<u64, VouchError> {
        Self::require_initialized(&env)?;
        Self::require_not_paused(&env)?;
        voucher.require_auth();

        if voucher == vouchee {
            return Err(VouchError::SelfVouchNotAllowed);
        }
        let self_addr = env.current_contract_address();
        if vouchee == self_addr
            || amount < MIN_VOUCH_AMOUNT
            || duration_months == 0
            || duration_months > MAX_DURATION_MONTHS
            || reason.is_empty()
            || reason.len() > 64
        {
            return Err(VouchError::InvalidInput);
        }
        let transfer_amount: i128 = amount
            .try_into()
            .map_err(|_| VouchError::ArithmeticOverflow)?;

        let pair_key = VouchDataKey::ActivePairVouch(voucher.clone(), vouchee.clone());
        if env.storage().persistent().has(&pair_key) {
            return Err(VouchError::DuplicateActiveVouch);
        }

        let cs_contract: Address = env
            .storage()
            .instance()
            .get(&VouchDataKey::CreditScoreContract)
            .ok_or(VouchError::NotInitialized)?;
        let cs_client = CreditScoreContractClient::new(&env, &cs_contract);
        let voucher_score_data = cs_client.get_credit_score(&voucher);

        let limits = Self::compute_limits_for(&env, &voucher, voucher_score_data.score);
        if amount > limits.max_vouch_amount {
            return Err(VouchError::ExceedsMaxVouchAmount);
        }

        let given_count: u32 = env
            .storage()
            .persistent()
            .get(&VouchDataKey::UserGivenCount(voucher.clone()))
            .unwrap_or(0);
        let mut active_count = 0u32;
        let scan_start = given_count.saturating_sub(100);
        let now = env.ledger().timestamp();
        let mut idx = scan_start;
        while idx < given_count {
            if let Some(vid) = env
                .storage()
                .persistent()
                .get::<_, u64>(&VouchDataKey::UserGivenAt(voucher.clone(), idx))
            {
                if let Some(v) = env
                    .storage()
                    .persistent()
                    .get::<_, Vouch>(&VouchDataKey::Vouch(vid))
                {
                    if v.is_active && v.expiration_date > now {
                        active_count += 1;
                    }
                }
            }
            idx += 1;
        }
        if active_count >= limits.max_active_vouches {
            return Err(VouchError::MaxActiveVouchesReached);
        }

        // Pull real tokens from voucher into contract escrow first (or abort cleanly on failure).
        let escrow_token: Address = env
            .storage()
            .instance()
            .get(&VouchDataKey::EscrowToken)
            .ok_or(VouchError::NotInitialized)?;
        token::Client::new(&env, &escrow_token).transfer(&voucher, &self_addr, &transfer_amount);

        let policy_trust_weight =
            Self::compute_policy_trust_weight(voucher_score_data.score, amount);

        let vouch_id: u64 = env
            .storage()
            .instance()
            .get(&VouchDataKey::VouchCounter)
            .unwrap_or(0u64)
            .checked_add(1)
            .ok_or(VouchError::ArithmeticOverflow)?;
        let expiration_date = now
            .checked_add(duration_months as u64 * SECS_PER_MONTH)
            .ok_or(VouchError::ArithmeticOverflow)?;

        let total_escrowed: u128 = env
            .storage()
            .instance()
            .get(&VouchDataKey::TotalEscrowed)
            .unwrap_or(0u128)
            .checked_add(amount)
            .ok_or(VouchError::ArithmeticOverflow)?;
        env.storage()
            .instance()
            .set(&VouchDataKey::VouchCounter, &vouch_id);
        env.storage()
            .instance()
            .set(&VouchDataKey::TotalEscrowed, &total_escrowed);

        let vouch = Vouch {
            id: vouch_id,
            voucher: voucher.clone(),
            vouchee: vouchee.clone(),
            amount,
            escrowed_balance: amount,
            slashed_amount: 0,
            trust_score: policy_trust_weight,
            reason,
            created_at: now,
            is_active: true,
            withdrawn: false,
            expiration_date,
            deactivated_at: 0,
        };

        let vouch_key = VouchDataKey::Vouch(vouch_id);
        env.storage().persistent().set(&vouch_key, &vouch);
        Self::bump_persistent(&env, &vouch_key);

        env.storage().persistent().set(&pair_key, &vouch_id);
        Self::bump_persistent(&env, &pair_key);

        let voucher_idx_key = VouchDataKey::UserGivenAt(voucher.clone(), given_count);
        env.storage().persistent().set(&voucher_idx_key, &vouch_id);
        env.storage().persistent().set(
            &VouchDataKey::UserGivenCount(voucher.clone()),
            &(given_count + 1),
        );
        Self::bump_persistent(&env, &voucher_idx_key);
        Self::bump_persistent(&env, &VouchDataKey::UserGivenCount(voucher.clone()));

        let rec_count: u32 = env
            .storage()
            .persistent()
            .get(&VouchDataKey::UserReceivedCount(vouchee.clone()))
            .unwrap_or(0);
        let rec_idx_key = VouchDataKey::UserReceivedAt(vouchee.clone(), rec_count);
        env.storage().persistent().set(&rec_idx_key, &vouch_id);
        env.storage().persistent().set(
            &VouchDataKey::UserReceivedCount(vouchee.clone()),
            &(rec_count + 1),
        );
        Self::bump_persistent(&env, &rec_idx_key);
        Self::bump_persistent(&env, &VouchDataKey::UserReceivedCount(vouchee.clone()));

        Self::update_trust_network(&env, &voucher);
        Self::update_trust_network(&env, &vouchee);

        cs_client.add_community_vouch(
            &vouch_id,
            &vouchee,
            &voucher,
            &amount,
            &policy_trust_weight,
            &expiration_date,
        );

        Self::bump_instance(&env);
        env.events()
            .publish((symbol_short!("vouch_ok"), voucher, vouchee), vouch_id);
        Ok(vouch_id)
    }

    pub fn revoke_vouch(env: Env, voucher: Address, vouch_id: u64) -> Result<u128, VouchError> {
        Self::require_initialized(&env)?;
        Self::require_not_paused(&env)?;
        voucher.require_auth();

        let vouch_key = VouchDataKey::Vouch(vouch_id);
        let mut vouch: Vouch = env
            .storage()
            .persistent()
            .get(&vouch_key)
            .ok_or(VouchError::VouchNotFound)?;

        if vouch.voucher != voucher {
            return Err(VouchError::Unauthorized);
        }
        if vouch.withdrawn {
            return Err(VouchError::VouchAlreadyWithdrawn);
        }
        if !vouch.is_active {
            return Err(VouchError::VouchAlreadyInactive);
        }

        let now = env.ledger().timestamp();
        let cooldown: u64 = env
            .storage()
            .instance()
            .get(&VouchDataKey::RevocationCooldownSecs)
            .unwrap_or(0u64);
        if now < vouch.created_at.saturating_add(cooldown) {
            return Err(VouchError::CooldownActive);
        }

        Self::settle_and_refund_vouch(&env, &mut vouch, now)
    }

    pub fn expire_vouch(env: Env, caller: Address, vouch_id: u64) -> Result<u128, VouchError> {
        Self::require_initialized(&env)?;
        caller.require_auth();

        let vouch_key = VouchDataKey::Vouch(vouch_id);
        let mut vouch: Vouch = env
            .storage()
            .persistent()
            .get(&vouch_key)
            .ok_or(VouchError::VouchNotFound)?;

        let admin = Self::get_admin(env.clone())?;
        if caller != vouch.voucher && caller != vouch.vouchee && caller != admin {
            return Err(VouchError::Unauthorized);
        }
        if vouch.withdrawn {
            return Err(VouchError::VouchAlreadyWithdrawn);
        }
        if !vouch.is_active {
            return Err(VouchError::VouchAlreadyInactive);
        }

        let now = env.ledger().timestamp();
        if now < vouch.expiration_date {
            return Err(VouchError::VouchNotExpired);
        }

        Self::settle_and_refund_vouch(&env, &mut vouch, now)
    }

    /// Allows a voucher whose vouch was deactivated (e.g., partially slashed on default)
    /// to reclaim any remaining unslashed escrowed capital safely, preventing double withdrawal.
    pub fn withdraw_remaining_escrow(
        env: Env,
        voucher: Address,
        vouch_id: u64,
    ) -> Result<u128, VouchError> {
        Self::require_initialized(&env)?;
        voucher.require_auth();

        let vouch_key = VouchDataKey::Vouch(vouch_id);
        let mut vouch: Vouch = env
            .storage()
            .persistent()
            .get(&vouch_key)
            .ok_or(VouchError::VouchNotFound)?;
        if vouch.voucher != voucher {
            return Err(VouchError::Unauthorized);
        }
        if vouch.withdrawn {
            return Err(VouchError::VouchAlreadyWithdrawn);
        }
        if vouch.is_active || vouch.escrowed_balance == 0 {
            return Err(VouchError::InsufficientEscrow);
        }

        let now = env.ledger().timestamp();
        Self::release_escrow_transfer(&env, &mut vouch, now)
    }

    /// Authorized explicit slashing called ONLY by registered LoanManager on defaulted borrower.
    /// Bounded strictly by MAX_SLASH_BPS (50% of active vouch escrow) per default event.
    pub fn slash_vouches_on_default(
        env: Env,
        borrower: Address,
        uncovered_loss: u128,
    ) -> Result<u128, VouchError> {
        Self::require_initialized(&env)?;
        let loan_manager: Address = env
            .storage()
            .instance()
            .get(&VouchDataKey::LoanManagerContract)
            .ok_or(VouchError::Unauthorized)?;
        loan_manager.require_auth();

        if uncovered_loss == 0 {
            return Ok(0);
        }

        let pool_recipient: Address = env
            .storage()
            .instance()
            .get(&VouchDataKey::SlashingPool)
            .ok_or(VouchError::NotInitialized)?;
        let escrow_token: Address = env
            .storage()
            .instance()
            .get(&VouchDataKey::EscrowToken)
            .ok_or(VouchError::NotInitialized)?;
        let cs_contract: Address = env
            .storage()
            .instance()
            .get(&VouchDataKey::CreditScoreContract)
            .ok_or(VouchError::NotInitialized)?;
        let cs_client = CreditScoreContractClient::new(&env, &cs_contract);

        let rec_count: u32 = env
            .storage()
            .persistent()
            .get(&VouchDataKey::UserReceivedCount(borrower.clone()))
            .unwrap_or(0);

        let now = env.ledger().timestamp();
        let mut remaining_loss = uncovered_loss;
        let mut total_slashed_now = 0u128;

        let start = rec_count.saturating_sub(50);
        let mut idx = start;
        while idx < rec_count && remaining_loss > 0 {
            if let Some(vid) = env
                .storage()
                .persistent()
                .get::<_, u64>(&VouchDataKey::UserReceivedAt(borrower.clone(), idx))
            {
                let vkey = VouchDataKey::Vouch(vid);
                if let Some(mut v) = env.storage().persistent().get::<_, Vouch>(&vkey) {
                    if v.is_active && !v.withdrawn && v.escrowed_balance > 0 {
                        let max_slash_for_vouch = v.escrowed_balance * MAX_SLASH_BPS / 10_000;
                        let slash_amt = max_slash_for_vouch.min(remaining_loss);
                        if slash_amt > 0 {
                            v.escrowed_balance -= slash_amt;
                            v.slashed_amount = v.slashed_amount.saturating_add(slash_amt);
                            v.is_active = false;
                            v.deactivated_at = now;
                            if v.escrowed_balance == 0 {
                                v.withdrawn = true;
                            }
                            env.storage().persistent().set(&vkey, &v);
                            Self::bump_persistent(&env, &vkey);

                            env.storage()
                                .persistent()
                                .remove(&VouchDataKey::ActivePairVouch(
                                    v.voucher.clone(),
                                    v.vouchee.clone(),
                                ));

                            remaining_loss -= slash_amt;
                            total_slashed_now = total_slashed_now.saturating_add(slash_amt);

                            Self::update_trust_network(&env, &v.voucher);
                            cs_client.remove_community_vouch(&borrower, &vid);
                        }
                    }
                }
            }
            idx += 1;
        }

        if total_slashed_now > 0 {
            let cur_escrowed: u128 = env
                .storage()
                .instance()
                .get(&VouchDataKey::TotalEscrowed)
                .unwrap_or(0);
            let cur_slashed: u128 = env
                .storage()
                .instance()
                .get(&VouchDataKey::TotalSlashed)
                .unwrap_or(0);
            env.storage().instance().set(
                &VouchDataKey::TotalEscrowed,
                &cur_escrowed.saturating_sub(total_slashed_now),
            );
            env.storage().instance().set(
                &VouchDataKey::TotalSlashed,
                &cur_slashed.saturating_add(total_slashed_now),
            );

            let transfer_amt: i128 = total_slashed_now
                .try_into()
                .map_err(|_| VouchError::ArithmeticOverflow)?;
            token::Client::new(&env, &escrow_token).transfer(
                &env.current_contract_address(),
                &pool_recipient,
                &transfer_amt,
            );
            Self::update_trust_network(&env, &borrower);
            env.events()
                .publish((symbol_short!("v_slash"), borrower), total_slashed_now);
        }

        Self::bump_instance(&env);
        Ok(total_slashed_now)
    }

    // ── Read Views, Decay & Bounded Pagination ────────────────────────────────

    /// Returns effective trust weight after applying linear time decay past the 50% midpoint
    /// down to a 50% floor prior to full expiry (returns 0 once inactive or expired).
    pub fn get_effective_vouch_trust(env: Env, vouch_id: u64) -> Result<u32, VouchError> {
        let vouch: Vouch = env
            .storage()
            .persistent()
            .get(&VouchDataKey::Vouch(vouch_id))
            .ok_or(VouchError::VouchNotFound)?;
        let now = env.ledger().timestamp();
        if !vouch.is_active || now >= vouch.expiration_date {
            return Ok(0);
        }
        let span = vouch.expiration_date.saturating_sub(vouch.created_at);
        if span == 0 {
            return Ok(vouch.trust_score);
        }
        let elapsed = now.saturating_sub(vouch.created_at);
        let half_span = span / 2;
        if elapsed <= half_span {
            return Ok(vouch.trust_score);
        }
        let remaining = vouch.expiration_date.saturating_sub(now);
        let factor_pct = 50 + (50 * remaining / half_span.max(1));
        Ok((vouch.trust_score as u64 * factor_pct / 100) as u32)
    }

    pub fn get_vouch(env: Env, vouch_id: u64) -> Result<Vouch, VouchError> {
        env.storage()
            .persistent()
            .get(&VouchDataKey::Vouch(vouch_id))
            .ok_or(VouchError::VouchNotFound)
    }

    pub fn get_user_vouches_page(
        env: Env,
        user: Address,
        cursor: u32,
        limit: u32,
    ) -> Result<Vec<u64>, VouchError> {
        if limit == 0 || limit > MAX_PAGE_SIZE {
            return Err(VouchError::InvalidPageLimit);
        }
        let count: u32 = env
            .storage()
            .persistent()
            .get(&VouchDataKey::UserGivenCount(user.clone()))
            .unwrap_or(0);
        let mut out = Vec::new(&env);
        let end = cursor.saturating_add(limit).min(count);
        let mut idx = cursor;
        while idx < end {
            if let Some(id) = env
                .storage()
                .persistent()
                .get::<_, u64>(&VouchDataKey::UserGivenAt(user.clone(), idx))
            {
                out.push_back(id);
            }
            idx += 1;
        }
        Ok(out)
    }

    pub fn get_user_received_vouches_page(
        env: Env,
        user: Address,
        cursor: u32,
        limit: u32,
    ) -> Result<Vec<u64>, VouchError> {
        if limit == 0 || limit > MAX_PAGE_SIZE {
            return Err(VouchError::InvalidPageLimit);
        }
        let count: u32 = env
            .storage()
            .persistent()
            .get(&VouchDataKey::UserReceivedCount(user.clone()))
            .unwrap_or(0);
        let mut out = Vec::new(&env);
        let end = cursor.saturating_add(limit).min(count);
        let mut idx = cursor;
        while idx < end {
            if let Some(id) = env
                .storage()
                .persistent()
                .get::<_, u64>(&VouchDataKey::UserReceivedAt(user.clone(), idx))
            {
                out.push_back(id);
            }
            idx += 1;
        }
        Ok(out)
    }

    pub fn get_user_vouches(env: Env, user: Address) -> Vec<u64> {
        Self::get_user_vouches_page(env, user, 0, MAX_PAGE_SIZE)
            .unwrap_or_else(|e| panic!("{:?}", e))
    }

    pub fn get_user_received_vouches(env: Env, user: Address) -> Vec<u64> {
        Self::get_user_received_vouches_page(env, user, 0, MAX_PAGE_SIZE)
            .unwrap_or_else(|e| panic!("{:?}", e))
    }

    pub fn get_trust_network(env: Env, user: Address) -> TrustNetwork {
        env.storage()
            .persistent()
            .get(&VouchDataKey::TrustNetwork(user))
            .unwrap_or(TrustNetwork {
                direct_connections: Vec::new(&env),
                indirect_connections: Vec::new(&env),
                trust_score: 0,
                vouching_capacity: 5_000_000,
            })
    }

    pub fn get_vouching_capacity(env: Env, user: Address) -> u128 {
        Self::get_trust_network(env, user).vouching_capacity
    }

    pub fn is_trusted_connection(
        env: Env,
        user1: Address,
        user2: Address,
        max_degrees: u32,
    ) -> bool {
        let network = Self::get_trust_network(env, user1);
        if network.direct_connections.contains(&user2) {
            return true;
        }
        if max_degrees >= 2 && network.indirect_connections.contains(&user2) {
            return true;
        }
        false
    }

    pub fn get_total_escrowed(env: Env) -> u128 {
        env.storage()
            .instance()
            .get(&VouchDataKey::TotalEscrowed)
            .unwrap_or(0)
    }

    pub fn get_total_slashed(env: Env) -> u128 {
        env.storage()
            .instance()
            .get(&VouchDataKey::TotalSlashed)
            .unwrap_or(0)
    }

    pub fn get_vouch_statistics(env: Env, user: Address) -> VouchStatistics {
        let given_count: u32 = env
            .storage()
            .persistent()
            .get(&VouchDataKey::UserGivenCount(user.clone()))
            .unwrap_or(0);
        let rec_count: u32 = env
            .storage()
            .persistent()
            .get(&VouchDataKey::UserReceivedCount(user.clone()))
            .unwrap_or(0);

        let now = env.ledger().timestamp();
        let mut active_given = 0u32;
        let mut total_given_amount = 0u128;
        let mut active_escrowed_given = 0u128;

        let g_start = given_count.saturating_sub(100);
        let mut gi = g_start;
        while gi < given_count {
            if let Some(vid) = env
                .storage()
                .persistent()
                .get::<_, u64>(&VouchDataKey::UserGivenAt(user.clone(), gi))
            {
                if let Some(v) = env
                    .storage()
                    .persistent()
                    .get::<_, Vouch>(&VouchDataKey::Vouch(vid))
                {
                    if v.is_active && v.expiration_date > now {
                        active_given += 1;
                        total_given_amount = total_given_amount.saturating_add(v.amount);
                        active_escrowed_given =
                            active_escrowed_given.saturating_add(v.escrowed_balance);
                    }
                }
            }
            gi += 1;
        }

        let mut active_received = 0u32;
        let mut total_received_amount = 0u128;
        let mut active_escrowed_received = 0u128;

        let r_start = rec_count.saturating_sub(100);
        let mut ri = r_start;
        while ri < rec_count {
            if let Some(vid) = env
                .storage()
                .persistent()
                .get::<_, u64>(&VouchDataKey::UserReceivedAt(user.clone(), ri))
            {
                if let Some(v) = env
                    .storage()
                    .persistent()
                    .get::<_, Vouch>(&VouchDataKey::Vouch(vid))
                {
                    if v.is_active && v.expiration_date > now {
                        active_received += 1;
                        total_received_amount = total_received_amount.saturating_add(v.amount);
                        active_escrowed_received =
                            active_escrowed_received.saturating_add(v.escrowed_balance);
                    }
                }
            }
            ri += 1;
        }

        VouchStatistics {
            total_vouches_given: given_count,
            active_vouches_given: active_given,
            total_vouches_received: rec_count,
            active_vouches_received: active_received,
            total_given_amount,
            total_received_amount,
            active_escrowed_given,
            active_escrowed_received,
        }
    }

    pub fn extend_vouch_ttl(env: Env, vouch_id: u64) -> Result<(), VouchError> {
        Self::require_initialized(&env)?;
        let key = VouchDataKey::Vouch(vouch_id);
        let vouch: Vouch = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(VouchError::VouchNotFound)?;
        Self::bump_instance(&env);
        Self::bump_persistent(&env, &key);
        for k in [
            VouchDataKey::UserGivenCount(vouch.voucher.clone()),
            VouchDataKey::UserReceivedCount(vouch.vouchee.clone()),
            VouchDataKey::TrustNetwork(vouch.voucher),
            VouchDataKey::TrustNetwork(vouch.vouchee),
        ] {
            if env.storage().persistent().has(&k) {
                Self::bump_persistent(&env, &k);
            }
        }
        Ok(())
    }

    // ── Internal Helpers ──────────────────────────────────────────────────────

    fn settle_and_refund_vouch(env: &Env, vouch: &mut Vouch, now: u64) -> Result<u128, VouchError> {
        vouch.is_active = false;
        vouch.deactivated_at = now;

        let voucher_addr = vouch.voucher.clone();
        let vouchee_addr = vouch.vouchee.clone();
        let vouch_id = vouch.id;
        env.storage()
            .persistent()
            .remove(&VouchDataKey::ActivePairVouch(
                voucher_addr.clone(),
                vouchee_addr.clone(),
            ));

        let refunded = Self::release_escrow_transfer(env, vouch, now)?;

        Self::update_trust_network(env, &voucher_addr);
        Self::update_trust_network(env, &vouchee_addr);

        if let Some(cs_contract) = env
            .storage()
            .instance()
            .get::<_, Address>(&VouchDataKey::CreditScoreContract)
        {
            CreditScoreContractClient::new(env, &cs_contract)
                .remove_community_vouch(&vouchee_addr, &vouch_id);
        }

        Self::bump_instance(env);
        Ok(refunded)
    }

    fn release_escrow_transfer(
        env: &Env,
        vouch: &mut Vouch,
        _now: u64,
    ) -> Result<u128, VouchError> {
        let refund = vouch.escrowed_balance;
        if refund == 0 {
            return Err(VouchError::InsufficientEscrow);
        }
        let transfer_amt: i128 = refund
            .try_into()
            .map_err(|_| VouchError::ArithmeticOverflow)?;

        // Checks-effects-interactions: mark withdrawn and zero balance before external token call
        vouch.escrowed_balance = 0;
        vouch.withdrawn = true;
        let vouch_key = VouchDataKey::Vouch(vouch.id);
        env.storage().persistent().set(&vouch_key, vouch);
        Self::bump_persistent(env, &vouch_key);

        let cur_escrowed: u128 = env
            .storage()
            .instance()
            .get(&VouchDataKey::TotalEscrowed)
            .unwrap_or(0);
        env.storage().instance().set(
            &VouchDataKey::TotalEscrowed,
            &cur_escrowed.saturating_sub(refund),
        );

        let escrow_token: Address = env
            .storage()
            .instance()
            .get(&VouchDataKey::EscrowToken)
            .ok_or(VouchError::NotInitialized)?;
        token::Client::new(env, &escrow_token).transfer(
            &env.current_contract_address(),
            &vouch.voucher,
            &transfer_amt,
        );
        Ok(refund)
    }

    fn compute_policy_trust_weight(voucher_credit_score: u32, amount: u128) -> u32 {
        let rep_component = (voucher_credit_score.min(100) * 70) / 100;
        let stake_component = if amount >= 1_000_000 {
            30
        } else if amount >= 500_000 {
            20
        } else if amount >= 100_000 {
            15
        } else if amount >= 10_000 {
            10
        } else {
            5
        };
        (rep_component + stake_component).min(100)
    }

    fn compute_limits_for(env: &Env, user: &Address, credit_score: u32) -> VouchingLimits {
        let net = Self::get_trust_network(env.clone(), user.clone());
        let max_active_vouches = match credit_score.max(net.trust_score) {
            80..=100 => 10,
            60..=79 => 7,
            40..=59 => 5,
            20..=39 => 3,
            _ => 2,
        };
        let tier_cap: u128 = if credit_score >= 80 {
            50_000_000_000
        } else if credit_score >= 50 {
            25_000_000_000
        } else {
            10_000_000_000
        };
        VouchingLimits {
            max_vouch_amount: tier_cap.max(net.vouching_capacity).min(MAX_VOUCH_HARD_CAP),
            max_active_vouches,
            min_trust_score: 0,
        }
    }

    fn update_trust_network(env: &Env, user: &Address) {
        let rec_count: u32 = env
            .storage()
            .persistent()
            .get(&VouchDataKey::UserReceivedCount(user.clone()))
            .unwrap_or(0);

        let now = env.ledger().timestamp();
        let mut unique_direct: Vec<Address> = Vec::new(env);
        let mut unique_indirect: Vec<Address> = Vec::new(env);
        let mut total_trust_score = 0u32;
        let mut total_amount = 0u128;
        let mut active_vouch_count = 0u32;

        let start = rec_count.saturating_sub(50);
        let mut i = start;
        while i < rec_count {
            if let Some(vid) = env
                .storage()
                .persistent()
                .get::<_, u64>(&VouchDataKey::UserReceivedAt(user.clone(), i))
            {
                if let Some(v) = env
                    .storage()
                    .persistent()
                    .get::<_, Vouch>(&VouchDataKey::Vouch(vid))
                {
                    if v.is_active && v.expiration_date > now {
                        let voucher_addr = v.voucher.clone();
                        if !unique_direct.contains(&voucher_addr) {
                            unique_direct.push_back(voucher_addr.clone());
                        }
                        total_trust_score = total_trust_score.saturating_add(v.trust_score);
                        total_amount = total_amount.saturating_add(v.escrowed_balance);
                        active_vouch_count += 1;

                        let v_rec_count: u32 = env
                            .storage()
                            .persistent()
                            .get(&VouchDataKey::UserReceivedCount(voucher_addr.clone()))
                            .unwrap_or(0);
                        let v_start = v_rec_count.saturating_sub(20);
                        let mut j = v_start;
                        while j < v_rec_count {
                            if let Some(cid) = env.storage().persistent().get::<_, u64>(
                                &VouchDataKey::UserReceivedAt(voucher_addr.clone(), j),
                            ) {
                                if let Some(cv) = env
                                    .storage()
                                    .persistent()
                                    .get::<_, Vouch>(&VouchDataKey::Vouch(cid))
                                {
                                    if cv.is_active
                                        && cv.expiration_date > now
                                        && cv.voucher != *user
                                        && !unique_direct.contains(&cv.voucher)
                                        && !unique_indirect.contains(&cv.voucher)
                                    {
                                        unique_indirect.push_back(cv.voucher.clone());
                                    }
                                }
                            }
                            j += 1;
                        }
                    }
                }
            }
            i += 1;
        }

        let avg_trust_score = total_trust_score
            .checked_div(active_vouch_count)
            .unwrap_or(0);

        let cap = 5_000_000u128
            .saturating_add(total_amount.saturating_mul(2))
            .min(MAX_VOUCH_HARD_CAP);
        let key = VouchDataKey::TrustNetwork(user.clone());
        env.storage().persistent().set(
            &key,
            &TrustNetwork {
                direct_connections: unique_direct,
                indirect_connections: unique_indirect,
                trust_score: avg_trust_score,
                vouching_capacity: cap,
            },
        );
        Self::bump_persistent(env, &key);
    }

    fn require_initialized(env: &Env) -> Result<(), VouchError> {
        if !env.storage().instance().has(&VouchDataKey::Initialized) {
            return Err(VouchError::NotInitialized);
        }
        Ok(())
    }

    fn require_not_paused(env: &Env) -> Result<(), VouchError> {
        if Self::is_paused(env.clone()) {
            return Err(VouchError::ContractPaused);
        }
        Ok(())
    }

    fn require_admin(env: &Env) -> Result<Address, VouchError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&VouchDataKey::Admin)
            .ok_or(VouchError::NotInitialized)?;
        admin.require_auth();
        Ok(admin)
    }

    fn bump_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
    }

    fn bump_persistent(env: &Env, key: &VouchDataKey) {
        env.storage()
            .persistent()
            .extend_ttl(key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
    }
}

mod tests;
