#![no_std]

mod errors;
mod types;

pub use errors::LoanManagerError;
pub use types::{
    CreditScoreData, Loan, LoanDataKey, LoanStatus, PoolState, RepaymentSchedule,
    GRACE_PERIOD_SECS, LATE_FEE_BPS_PER_MONTH, LIQUIDATION_BONUS_BPS, MAX_ACTIVE_LOANS_PER_USER,
    MAX_DURATION_MONTHS, MAX_LATE_FEE_BPS, MAX_LTV_BPS, MAX_PAGE_SIZE, MIN_LOAN_AMOUNT,
    MIN_POOL_DEPOSIT, MIN_SCORE_TO_BORROW, PRICE_SCALE_E7, UNSECURED_MIN_SCORE,
};

use soroban_sdk::{contract, contractclient, contractimpl, symbol_short, token, Address, Env, Vec};
use types::{
    INSTANCE_TTL_EXTEND, INSTANCE_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND, PERSISTENT_TTL_THRESHOLD,
    SECS_PER_MONTH,
};

#[contractclient(name = "CreditScoreContractClient")]
pub trait CreditScoreContract {
    fn get_credit_score(env: Env, user: Address) -> CreditScoreData;
    fn record_loan_outcome(env: Env, borrower: Address, on_time: bool, defaulted: bool);
}

#[contractclient(name = "CommunityVouchContractClient")]
pub trait CommunityVouchContract {
    fn slash_vouches_on_default(env: Env, borrower: Address, uncovered_loss: u128) -> u128;
}

#[contract]
pub struct LoanManagerContract;

#[contractimpl]
impl LoanManagerContract {
    // ── Initialization & Governance ───────────────────────────────────────────

    pub fn initialize(
        env: Env,
        admin: Address,
        credit_score_contract: Address,
        loan_token: Address,
        collateral_token: Address,
    ) -> Result<(), LoanManagerError> {
        if env.storage().instance().has(&LoanDataKey::Initialized) {
            return Err(LoanManagerError::AlreadyInitialized);
        }
        admin.require_auth();

        let self_addr = env.current_contract_address();
        if credit_score_contract == self_addr
            || loan_token == self_addr
            || collateral_token == self_addr
            || credit_score_contract == admin
        {
            return Err(LoanManagerError::InvalidInput);
        }

        env.storage()
            .instance()
            .set(&LoanDataKey::Initialized, &true);
        env.storage().instance().set(&LoanDataKey::Admin, &admin);
        env.storage().instance().set(&LoanDataKey::Paused, &false);
        env.storage()
            .instance()
            .set(&LoanDataKey::CreditScoreContract, &credit_score_contract);
        env.storage()
            .instance()
            .set(&LoanDataKey::LoanToken, &loan_token);
        env.storage()
            .instance()
            .set(&LoanDataKey::CollateralToken, &collateral_token);
        env.storage()
            .instance()
            .set(&LoanDataKey::LiquidationVault, &admin);
        env.storage()
            .instance()
            .set(&LoanDataKey::CollateralPriceE7, &PRICE_SCALE_E7); // 1:1 default scaled E7
        env.storage()
            .instance()
            .set(&LoanDataKey::LoanCounter, &0u64);
        env.storage()
            .instance()
            .set(&LoanDataKey::ActiveLoanCount, &0u32);
        env.storage().instance().set(
            &LoanDataKey::PoolState,
            &PoolState {
                total_shares: 0,
                available_cash: 0,
                outstanding_principal: 0,
                total_interest_earned: 0,
                total_collateral_locked: 0,
                total_defaulted_principal: 0,
                total_recovered: 0,
            },
        );
        Self::bump_instance(&env);
        env.events().publish((symbol_short!("lm_init"),), admin);
        Ok(())
    }

    pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), LoanManagerError> {
        Self::require_initialized(&env)?;
        let admin = Self::require_admin(&env)?;
        if new_admin == admin || new_admin == env.current_contract_address() {
            return Err(LoanManagerError::SameAdmin);
        }
        env.storage()
            .instance()
            .set(&LoanDataKey::PendingAdmin, &new_admin);
        Self::bump_instance(&env);
        Ok(())
    }

    pub fn accept_admin(env: Env) -> Result<(), LoanManagerError> {
        Self::require_initialized(&env)?;
        let pending: Address = env
            .storage()
            .instance()
            .get(&LoanDataKey::PendingAdmin)
            .ok_or(LoanManagerError::NoPendingAdmin)?;
        pending.require_auth();
        env.storage().instance().set(&LoanDataKey::Admin, &pending);
        env.storage().instance().remove(&LoanDataKey::PendingAdmin);
        Self::bump_instance(&env);
        Ok(())
    }

    pub fn pause(env: Env) -> Result<(), LoanManagerError> {
        Self::require_initialized(&env)?;
        Self::require_admin(&env)?;
        env.storage().instance().set(&LoanDataKey::Paused, &true);
        Self::bump_instance(&env);
        Ok(())
    }

    pub fn unpause(env: Env) -> Result<(), LoanManagerError> {
        Self::require_initialized(&env)?;
        Self::require_admin(&env)?;
        env.storage().instance().set(&LoanDataKey::Paused, &false);
        Self::bump_instance(&env);
        Ok(())
    }

    pub fn set_collateral_config(
        env: Env,
        collateral_price_e7: u128,
        liquidation_vault: Address,
    ) -> Result<(), LoanManagerError> {
        Self::require_initialized(&env)?;
        Self::require_admin(&env)?;
        if !(100_000..=1_000_000_000_000).contains(&collateral_price_e7)
            || liquidation_vault == env.current_contract_address()
        {
            return Err(LoanManagerError::InvalidInput);
        }
        env.storage()
            .instance()
            .set(&LoanDataKey::CollateralPriceE7, &collateral_price_e7);
        env.storage()
            .instance()
            .set(&LoanDataKey::LiquidationVault, &liquidation_vault);
        Self::bump_instance(&env);
        Ok(())
    }

    pub fn set_community_vouch_contract(
        env: Env,
        community_vouch_contract: Address,
    ) -> Result<(), LoanManagerError> {
        Self::require_initialized(&env)?;
        Self::require_admin(&env)?;
        if community_vouch_contract == env.current_contract_address() {
            return Err(LoanManagerError::InvalidInput);
        }
        env.storage().instance().set(
            &LoanDataKey::CommunityVouchContract,
            &community_vouch_contract,
        );
        Self::bump_instance(&env);
        Ok(())
    }

    pub fn get_admin(env: Env) -> Result<Address, LoanManagerError> {
        Self::require_initialized(&env)?;
        env.storage()
            .instance()
            .get(&LoanDataKey::Admin)
            .ok_or(LoanManagerError::NotInitialized)
    }

    pub fn get_pending_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&LoanDataKey::PendingAdmin)
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&LoanDataKey::Paused)
            .unwrap_or(false)
    }

    // ── Lender Liquidity Pool (SEP-41 Token Transfers & Share Accounting) ─────

    /// Deposits real SEP-41 loan_token into the shared lending pool and mints proportional pool shares.
    pub fn deposit_liquidity(
        env: Env,
        lender: Address,
        amount: u128,
    ) -> Result<u128, LoanManagerError> {
        Self::require_initialized(&env)?;
        Self::require_not_paused(&env)?;
        lender.require_auth();

        if amount < MIN_POOL_DEPOSIT {
            return Err(LoanManagerError::ZeroDeposit);
        }
        let transfer_amt: i128 = amount
            .try_into()
            .map_err(|_| LoanManagerError::ArithmeticOverflow)?;

        let self_addr = env.current_contract_address();
        let loan_token: Address = env
            .storage()
            .instance()
            .get(&LoanDataKey::LoanToken)
            .ok_or(LoanManagerError::NotInitialized)?;
        token::Client::new(&env, &loan_token).transfer(&lender, &self_addr, &transfer_amt);

        let mut pool = Self::get_pool_state(env.clone());
        let total_backing = pool
            .available_cash
            .checked_add(pool.outstanding_principal)
            .ok_or(LoanManagerError::ArithmeticOverflow)?;

        let minted_shares = if pool.total_shares == 0 || total_backing == 0 {
            amount
        } else {
            let s = amount
                .checked_mul(pool.total_shares)
                .ok_or(LoanManagerError::ArithmeticOverflow)?
                / total_backing;
            if s == 0 {
                return Err(LoanManagerError::ZeroDeposit);
            }
            s
        };

        pool.total_shares = pool
            .total_shares
            .checked_add(minted_shares)
            .ok_or(LoanManagerError::ArithmeticOverflow)?;
        pool.available_cash = pool
            .available_cash
            .checked_add(amount)
            .ok_or(LoanManagerError::ArithmeticOverflow)?;
        env.storage().instance().set(&LoanDataKey::PoolState, &pool);

        let share_key = LoanDataKey::LenderShares(lender.clone());
        let cur_shares: u128 = env.storage().persistent().get(&share_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&share_key, &(cur_shares + minted_shares));
        Self::bump_persistent(&env, &share_key);
        Self::bump_instance(&env);

        env.events()
            .publish((symbol_short!("lp_dep"), lender), amount);
        Ok(minted_shares)
    }

    /// Withdraws up to lender's redeemable pool value, strictly blocked from draining cash
    /// committed to active loans (`available_cash` check).
    pub fn withdraw_liquidity(
        env: Env,
        lender: Address,
        amount: u128,
    ) -> Result<u128, LoanManagerError> {
        Self::require_initialized(&env)?;
        Self::require_not_paused(&env)?;
        lender.require_auth();

        if amount == 0 {
            return Err(LoanManagerError::InvalidInput);
        }
        let transfer_amt: i128 = amount
            .try_into()
            .map_err(|_| LoanManagerError::ArithmeticOverflow)?;

        let mut pool = Self::get_pool_state(env.clone());
        if amount > pool.available_cash {
            return Err(LoanManagerError::InsufficientAvailableLiquidity);
        }

        let share_key = LoanDataKey::LenderShares(lender.clone());
        let lender_shares: u128 = env.storage().persistent().get(&share_key).unwrap_or(0);
        if lender_shares == 0 || pool.total_shares == 0 {
            return Err(LoanManagerError::InsufficientLenderBalance);
        }

        let total_backing = pool
            .available_cash
            .checked_add(pool.outstanding_principal)
            .ok_or(LoanManagerError::ArithmeticOverflow)?;
        let lender_claimable = lender_shares
            .checked_mul(total_backing)
            .ok_or(LoanManagerError::ArithmeticOverflow)?
            / pool.total_shares;

        if amount > lender_claimable {
            return Err(LoanManagerError::InsufficientLenderBalance);
        }

        // Ceiling burn of shares prevents rounding drain across tiny withdrawals
        let shares_to_burn = Self::ceil_div(
            amount
                .checked_mul(pool.total_shares)
                .ok_or(LoanManagerError::ArithmeticOverflow)?,
            total_backing,
        )?
        .min(lender_shares);

        pool.total_shares = pool.total_shares.saturating_sub(shares_to_burn);
        pool.available_cash = pool.available_cash.saturating_sub(amount);
        env.storage().instance().set(&LoanDataKey::PoolState, &pool);

        let next_shares = lender_shares.saturating_sub(shares_to_burn);
        env.storage().persistent().set(&share_key, &next_shares);
        Self::bump_persistent(&env, &share_key);
        Self::bump_instance(&env);

        let loan_token: Address = env
            .storage()
            .instance()
            .get(&LoanDataKey::LoanToken)
            .ok_or(LoanManagerError::NotInitialized)?;
        token::Client::new(&env, &loan_token).transfer(
            &env.current_contract_address(),
            &lender,
            &transfer_amt,
        );

        env.events()
            .publish((symbol_short!("lp_wdr"), lender), amount);
        Ok(amount)
    }

    pub fn get_pool_state(env: Env) -> PoolState {
        env.storage()
            .instance()
            .get(&LoanDataKey::PoolState)
            .unwrap_or(PoolState {
                total_shares: 0,
                available_cash: 0,
                outstanding_principal: 0,
                total_interest_earned: 0,
                total_collateral_locked: 0,
                total_defaulted_principal: 0,
                total_recovered: 0,
            })
    }

    pub fn get_lender_balance(env: Env, lender: Address) -> u128 {
        let pool = Self::get_pool_state(env.clone());
        let shares: u128 = env
            .storage()
            .persistent()
            .get(&LoanDataKey::LenderShares(lender))
            .unwrap_or(0);
        if pool.total_shares == 0 || shares == 0 {
            return 0;
        }
        let total_backing = pool
            .available_cash
            .saturating_add(pool.outstanding_principal);
        shares.saturating_mul(total_backing) / pool.total_shares
    }

    // ── Loan Origination, Collateral Locking, Approval & Real Transfers ───────

    pub fn create_loan(
        env: Env,
        borrower: Address,
        amount: u128,
        duration_months: u32,
        collateral_amount: u128,
    ) -> Result<u64, LoanManagerError> {
        Self::require_initialized(&env)?;
        Self::require_not_paused(&env)?;
        borrower.require_auth();

        if amount < MIN_LOAN_AMOUNT
            || duration_months == 0
            || duration_months > MAX_DURATION_MONTHS
            || borrower == env.current_contract_address()
        {
            return Err(LoanManagerError::InvalidInput);
        }

        let cs_contract: Address = env
            .storage()
            .instance()
            .get(&LoanDataKey::CreditScoreContract)
            .ok_or(LoanManagerError::NotInitialized)?;
        let cs_data =
            CreditScoreContractClient::new(&env, &cs_contract).get_credit_score(&borrower);
        if cs_data.score < MIN_SCORE_TO_BORROW {
            return Err(LoanManagerError::InsufficientCreditScore);
        }

        // Check active loans count & aggregate principal cap for tier
        let (active_cnt, active_principal) = Self::active_borrower_exposure(&env, &borrower);
        if active_cnt >= MAX_ACTIVE_LOANS_PER_USER {
            return Err(LoanManagerError::TooManyActiveLoans);
        }
        let tier_cap = Self::max_debt_for_score(cs_data.score);
        if active_principal.saturating_add(amount) > tier_cap {
            return Err(LoanManagerError::ExceedsTierLimit);
        }

        let collateral_required = cs_data.score < UNSECURED_MIN_SCORE;
        if collateral_required {
            let min_col = Self::required_collateral_for(&env, amount)?;
            if collateral_amount < min_col {
                return Err(LoanManagerError::InsufficientCollateral);
            }
        }

        let collateral_locked = collateral_amount > 0;
        if collateral_locked {
            let col_amt: i128 = collateral_amount
                .try_into()
                .map_err(|_| LoanManagerError::ArithmeticOverflow)?;
            let col_token: Address = env
                .storage()
                .instance()
                .get(&LoanDataKey::CollateralToken)
                .ok_or(LoanManagerError::NotInitialized)?;
            token::Client::new(&env, &col_token).transfer(
                &borrower,
                &env.current_contract_address(),
                &col_amt,
            );

            let mut pool = Self::get_pool_state(env.clone());
            pool.total_collateral_locked = pool
                .total_collateral_locked
                .checked_add(collateral_amount)
                .ok_or(LoanManagerError::ArithmeticOverflow)?;
            env.storage().instance().set(&LoanDataKey::PoolState, &pool);
        }

        let interest_rate = Self::calculate_interest_rate(cs_data.score);
        let scheduled_interest = Self::ceil_div(
            amount
                .checked_mul(interest_rate as u128)
                .ok_or(LoanManagerError::ArithmeticOverflow)?
                .checked_mul(duration_months as u128)
                .ok_or(LoanManagerError::ArithmeticOverflow)?,
            100 * 12,
        )?;

        let loan_id: u64 = env
            .storage()
            .instance()
            .get(&LoanDataKey::LoanCounter)
            .unwrap_or(0u64)
            .checked_add(1)
            .ok_or(LoanManagerError::ArithmeticOverflow)?;
        env.storage()
            .instance()
            .set(&LoanDataKey::LoanCounter, &loan_id);

        let now = env.ledger().timestamp();
        let due_date = now
            .checked_add(duration_months as u64 * SECS_PER_MONTH)
            .ok_or(LoanManagerError::ArithmeticOverflow)?;

        let loan = Loan {
            id: loan_id,
            borrower: borrower.clone(),
            amount,
            interest_rate,
            duration_months,
            scheduled_interest,
            late_fee_charged: 0,
            created_at: now,
            approved_at: 0,
            due_date,
            last_repaid_at: 0,
            status: LoanStatus::Pending,
            collateral_required,
            collateral_amount,
            collateral_locked,
            credit_score_used: cs_data.score,
            principal_repaid: 0,
            interest_repaid: 0,
            repaid_amount: 0,
        };

        let loan_key = LoanDataKey::Loan(loan_id);
        env.storage().persistent().set(&loan_key, &loan);
        Self::bump_persistent(&env, &loan_key);

        let u_count_key = LoanDataKey::UserLoanCount(borrower.clone());
        let u_count: u32 = env.storage().persistent().get(&u_count_key).unwrap_or(0);
        let u_idx_key = LoanDataKey::UserLoanAt(borrower.clone(), u_count);
        env.storage().persistent().set(&u_idx_key, &loan_id);
        env.storage().persistent().set(&u_count_key, &(u_count + 1));
        Self::bump_persistent(&env, &u_idx_key);
        Self::bump_persistent(&env, &u_count_key);
        Self::bump_instance(&env);

        env.events()
            .publish((symbol_short!("ln_req"), borrower), loan_id);
        Ok(loan_id)
    }

    /// Cancels an unapproved Pending loan and refunds any deposited collateral safely.
    pub fn cancel_loan(env: Env, borrower: Address, loan_id: u64) -> Result<(), LoanManagerError> {
        Self::require_initialized(&env)?;
        borrower.require_auth();

        let loan_key = LoanDataKey::Loan(loan_id);
        let mut loan: Loan = env
            .storage()
            .persistent()
            .get(&loan_key)
            .ok_or(LoanManagerError::LoanNotFound)?;
        if loan.borrower != borrower {
            return Err(LoanManagerError::Unauthorized);
        }
        if loan.status != LoanStatus::Pending {
            return Err(LoanManagerError::InvalidLoanStatus);
        }

        loan.status = LoanStatus::Cancelled;
        let refund_col = if loan.collateral_locked && loan.collateral_amount > 0 {
            loan.collateral_locked = false;
            loan.collateral_amount
        } else {
            0
        };
        env.storage().persistent().set(&loan_key, &loan);
        Self::bump_persistent(&env, &loan_key);

        if refund_col > 0 {
            Self::unlock_collateral_transfer(&env, &borrower, refund_col)?;
        }
        Self::bump_instance(&env);
        Ok(())
    }

    /// Approves a pending loan AND atomically disburses real SEP-41 loan_token to the borrower.
    pub fn approve_loan(env: Env, admin: Address, loan_id: u64) -> Result<(), LoanManagerError> {
        Self::require_initialized(&env)?;
        Self::require_not_paused(&env)?;
        admin.require_auth();

        let stored_admin = Self::require_admin_address(&env)?;
        if admin != stored_admin {
            return Err(LoanManagerError::Unauthorized);
        }

        let loan_key = LoanDataKey::Loan(loan_id);
        let mut loan: Loan = env
            .storage()
            .persistent()
            .get(&loan_key)
            .ok_or(LoanManagerError::LoanNotFound)?;
        if loan.status != LoanStatus::Pending {
            return Err(LoanManagerError::InvalidLoanStatus);
        }

        let mut pool = Self::get_pool_state(env.clone());
        if loan.amount > pool.available_cash {
            return Err(LoanManagerError::InsufficientPoolLiquidity);
        }
        let disburse_amt: i128 = loan
            .amount
            .try_into()
            .map_err(|_| LoanManagerError::ArithmeticOverflow)?;

        let now = env.ledger().timestamp();
        loan.status = LoanStatus::Active;
        loan.approved_at = now;
        loan.due_date = now
            .checked_add(loan.duration_months as u64 * SECS_PER_MONTH)
            .ok_or(LoanManagerError::ArithmeticOverflow)?;
        env.storage().persistent().set(&loan_key, &loan);
        Self::bump_persistent(&env, &loan_key);

        pool.available_cash = pool.available_cash.saturating_sub(loan.amount);
        pool.outstanding_principal = pool
            .outstanding_principal
            .checked_add(loan.amount)
            .ok_or(LoanManagerError::ArithmeticOverflow)?;
        env.storage().instance().set(&LoanDataKey::PoolState, &pool);

        Self::add_to_active_loans(&env, loan_id);

        // Real atomic token disbursement from LoanManager pool to borrower
        let loan_token: Address = env
            .storage()
            .instance()
            .get(&LoanDataKey::LoanToken)
            .ok_or(LoanManagerError::NotInitialized)?;
        token::Client::new(&env, &loan_token).transfer(
            &env.current_contract_address(),
            &loan.borrower,
            &disburse_amt,
        );

        Self::bump_instance(&env);
        env.events()
            .publish((symbol_short!("ln_disb"), loan.borrower), loan_id);
        Ok(())
    }

    /// Processes a real SEP-41 token repayment from borrower into the liquidity pool,
    /// amortizing accrued late fees + interest before principal, releasing collateral on completion.
    pub fn repay_loan(
        env: Env,
        borrower: Address,
        loan_id: u64,
        amount: u128,
    ) -> Result<Loan, LoanManagerError> {
        Self::require_initialized(&env)?;
        Self::require_not_paused(&env)?;
        borrower.require_auth();

        if amount == 0 {
            return Err(LoanManagerError::InvalidInput);
        }
        let transfer_amt: i128 = amount
            .try_into()
            .map_err(|_| LoanManagerError::ArithmeticOverflow)?;

        let loan_key = LoanDataKey::Loan(loan_id);
        let mut loan: Loan = env
            .storage()
            .persistent()
            .get(&loan_key)
            .ok_or(LoanManagerError::LoanNotFound)?;
        if loan.borrower != borrower {
            return Err(LoanManagerError::Unauthorized);
        }
        if loan.status != LoanStatus::Active {
            return Err(LoanManagerError::InvalidLoanStatus);
        }

        let now = env.ledger().timestamp();
        let late_fee = Self::compute_accrued_late_fee(&loan, now)?;
        loan.late_fee_charged = loan.late_fee_charged.max(late_fee);

        let total_interest_and_fees = loan
            .scheduled_interest
            .checked_add(loan.late_fee_charged)
            .ok_or(LoanManagerError::ArithmeticOverflow)?;
        let remaining_interest = total_interest_and_fees.saturating_sub(loan.interest_repaid);
        let remaining_principal = loan.amount.saturating_sub(loan.principal_repaid);
        let remaining_total = remaining_interest
            .checked_add(remaining_principal)
            .ok_or(LoanManagerError::ArithmeticOverflow)?;

        if amount > remaining_total {
            return Err(LoanManagerError::RepaymentExceedsDue);
        }

        // Pull real SEP-41 repayment from borrower to pool
        let loan_token: Address = env
            .storage()
            .instance()
            .get(&LoanDataKey::LoanToken)
            .ok_or(LoanManagerError::NotInitialized)?;
        token::Client::new(&env, &loan_token).transfer(
            &borrower,
            &env.current_contract_address(),
            &transfer_amt,
        );

        let interest_paid_now = amount.min(remaining_interest);
        let principal_paid_now = amount - interest_paid_now;

        loan.interest_repaid = loan.interest_repaid.saturating_add(interest_paid_now);
        loan.principal_repaid = loan.principal_repaid.saturating_add(principal_paid_now);
        loan.repaid_amount = loan.repaid_amount.saturating_add(amount);
        loan.last_repaid_at = now;

        let mut pool = Self::get_pool_state(env.clone());
        pool.available_cash = pool
            .available_cash
            .checked_add(amount)
            .ok_or(LoanManagerError::ArithmeticOverflow)?;
        pool.outstanding_principal = pool
            .outstanding_principal
            .saturating_sub(principal_paid_now);
        pool.total_interest_earned = pool.total_interest_earned.saturating_add(interest_paid_now);
        env.storage().instance().set(&LoanDataKey::PoolState, &pool);

        let fully_repaid =
            loan.principal_repaid == loan.amount && loan.interest_repaid >= total_interest_and_fees;

        let mut unlock_col = 0u128;
        if fully_repaid {
            loan.status = LoanStatus::Repaid;
            Self::remove_from_active_loans(&env, loan_id);
            if loan.collateral_locked && loan.collateral_amount > 0 {
                loan.collateral_locked = false;
                unlock_col = loan.collateral_amount;
            }
        }

        env.storage().persistent().set(&loan_key, &loan);
        Self::bump_persistent(&env, &loan_key);

        if unlock_col > 0 {
            Self::unlock_collateral_transfer(&env, &borrower, unlock_col)?;
        }

        if fully_repaid {
            let cs_contract: Address = env
                .storage()
                .instance()
                .get(&LoanDataKey::CreditScoreContract)
                .ok_or(LoanManagerError::NotInitialized)?;
            let on_time = now <= loan.due_date.saturating_add(GRACE_PERIOD_SECS);
            CreditScoreContractClient::new(&env, &cs_contract)
                .record_loan_outcome(&borrower, &on_time, &false);
        }

        Self::bump_instance(&env);
        env.events()
            .publish((symbol_short!("ln_repay"), loan_id), amount);
        Ok(loan)
    }

    /// Marks an overdue loan as Defaulted, liquidates locked collateral fairly with surplus refund
    /// (never confiscating excess collateral beyond debt + capped 5% buffer), updates CreditScore,
    /// and optionally invokes CommunityVouch bounded slashing for uncovered lender loss.
    pub fn mark_default(env: Env, admin: Address, loan_id: u64) -> Result<(), LoanManagerError> {
        Self::require_initialized(&env)?;
        admin.require_auth();

        let stored_admin = Self::require_admin_address(&env)?;
        if admin != stored_admin {
            return Err(LoanManagerError::Unauthorized);
        }

        let loan_key = LoanDataKey::Loan(loan_id);
        let mut loan: Loan = env
            .storage()
            .persistent()
            .get(&loan_key)
            .ok_or(LoanManagerError::LoanNotFound)?;
        if loan.status != LoanStatus::Active {
            return Err(LoanManagerError::InvalidLoanStatus);
        }

        let now = env.ledger().timestamp();
        if now < loan.due_date {
            return Err(LoanManagerError::LoanNotYetDue);
        }

        let late_fee = Self::compute_accrued_late_fee(&loan, now)?;
        loan.late_fee_charged = loan.late_fee_charged.max(late_fee);
        let total_interest_and_fees = loan
            .scheduled_interest
            .saturating_add(loan.late_fee_charged);
        let remaining_interest = total_interest_and_fees.saturating_sub(loan.interest_repaid);
        let remaining_principal = loan.amount.saturating_sub(loan.principal_repaid);
        let debt_owed = remaining_principal.saturating_add(remaining_interest);

        loan.status = LoanStatus::Defaulted;
        Self::remove_from_active_loans(&env, loan_id);

        let col_locked = if loan.collateral_locked && loan.collateral_amount > 0 {
            loan.collateral_locked = false;
            loan.collateral_amount
        } else {
            0
        };
        env.storage().persistent().set(&loan_key, &loan);
        Self::bump_persistent(&env, &loan_key);

        let mut pool = Self::get_pool_state(env.clone());
        pool.outstanding_principal = pool
            .outstanding_principal
            .saturating_sub(remaining_principal);
        pool.total_defaulted_principal = pool
            .total_defaulted_principal
            .saturating_add(remaining_principal);

        let mut recovered_value = 0u128;
        if col_locked > 0 {
            pool.total_collateral_locked = pool.total_collateral_locked.saturating_sub(col_locked);

            let price_e7: u128 = env
                .storage()
                .instance()
                .get(&LoanDataKey::CollateralPriceE7)
                .unwrap_or(PRICE_SCALE_E7);
            let max_seize_in_loan_value =
                debt_owed.saturating_mul(10_000 + LIQUIDATION_BONUS_BPS) / 10_000;
            let collateral_needed = Self::ceil_div(
                max_seize_in_loan_value.saturating_mul(PRICE_SCALE_E7),
                price_e7,
            )?
            .min(col_locked);
            let surplus = col_locked.saturating_sub(collateral_needed);

            let loan_token: Address = env
                .storage()
                .instance()
                .get(&LoanDataKey::LoanToken)
                .ok_or(LoanManagerError::NotInitialized)?;
            let col_token: Address = env
                .storage()
                .instance()
                .get(&LoanDataKey::CollateralToken)
                .ok_or(LoanManagerError::NotInitialized)?;
            let self_addr = env.current_contract_address();

            if col_token == loan_token {
                // Same-asset collateral directly recapitalizes lending pool cash cleanly
                pool.available_cash = pool.available_cash.saturating_add(collateral_needed);
                pool.total_recovered = pool.total_recovered.saturating_add(collateral_needed);
                recovered_value = collateral_needed;
            } else {
                // External collateral transferred to configured LiquidationVault
                let vault: Address = env
                    .storage()
                    .instance()
                    .get(&LoanDataKey::LiquidationVault)
                    .unwrap_or(stored_admin);
                let col_amt: i128 = collateral_needed
                    .try_into()
                    .map_err(|_| LoanManagerError::ArithmeticOverflow)?;
                token::Client::new(&env, &col_token).transfer(&self_addr, &vault, &col_amt);
                recovered_value = collateral_needed.saturating_mul(price_e7) / PRICE_SCALE_E7;
            }

            if surplus > 0 {
                let sur_amt: i128 = surplus
                    .try_into()
                    .map_err(|_| LoanManagerError::ArithmeticOverflow)?;
                token::Client::new(&env, &col_token).transfer(&self_addr, &loan.borrower, &sur_amt);
            }
        }

        let uncovered_loss = remaining_principal.saturating_sub(recovered_value);
        if uncovered_loss > 0 {
            if let Some(cv_addr) = env
                .storage()
                .instance()
                .get::<_, Address>(&LoanDataKey::CommunityVouchContract)
            {
                let slashed = CommunityVouchContractClient::new(&env, &cv_addr)
                    .slash_vouches_on_default(&loan.borrower, &uncovered_loss);
                if slashed > 0 {
                    pool.available_cash = pool.available_cash.saturating_add(slashed);
                    pool.total_recovered = pool.total_recovered.saturating_add(slashed);
                }
            }
        }

        env.storage().instance().set(&LoanDataKey::PoolState, &pool);

        let cs_contract: Address = env
            .storage()
            .instance()
            .get(&LoanDataKey::CreditScoreContract)
            .ok_or(LoanManagerError::NotInitialized)?;
        CreditScoreContractClient::new(&env, &cs_contract).record_loan_outcome(
            &loan.borrower,
            &false,
            &true,
        );

        Self::bump_instance(&env);
        env.events()
            .publish((symbol_short!("ln_def"), loan.borrower), loan_id);
        Ok(())
    }

    // ── Read Views & Bounded Pagination ───────────────────────────────────────

    pub fn can_borrow(env: Env, user: Address, amount: u128) -> bool {
        if Self::is_paused(env.clone()) || amount < MIN_LOAN_AMOUNT {
            return false;
        }
        let cs_contract: Address = match env
            .storage()
            .instance()
            .get(&LoanDataKey::CreditScoreContract)
        {
            Some(c) => c,
            None => return false,
        };
        let cs_data = CreditScoreContractClient::new(&env, &cs_contract).get_credit_score(&user);
        if cs_data.score < MIN_SCORE_TO_BORROW {
            return false;
        }
        let (active_cnt, active_principal) = Self::active_borrower_exposure(&env, &user);
        if active_cnt >= MAX_ACTIVE_LOANS_PER_USER {
            return false;
        }
        active_principal.saturating_add(amount) <= Self::max_debt_for_score(cs_data.score)
    }

    pub fn get_required_collateral(
        env: Env,
        borrower: Address,
        amount: u128,
    ) -> Result<u128, LoanManagerError> {
        Self::require_initialized(&env)?;
        let cs_contract: Address = env
            .storage()
            .instance()
            .get(&LoanDataKey::CreditScoreContract)
            .ok_or(LoanManagerError::NotInitialized)?;
        let cs_data =
            CreditScoreContractClient::new(&env, &cs_contract).get_credit_score(&borrower);
        if cs_data.score >= UNSECURED_MIN_SCORE {
            return Ok(0);
        }
        Self::required_collateral_for(&env, amount)
    }

    pub fn get_repayment_schedule(
        env: Env,
        loan_id: u64,
    ) -> Result<RepaymentSchedule, LoanManagerError> {
        let loan = Self::get_loan(env.clone(), loan_id)?;
        let now = env.ledger().timestamp();
        let late_fee = if loan.status == LoanStatus::Active {
            Self::compute_accrued_late_fee(&loan, now)?
        } else {
            loan.late_fee_charged
        };
        let effective_late = loan.late_fee_charged.max(late_fee);
        let interest_remaining = loan
            .scheduled_interest
            .saturating_add(effective_late)
            .saturating_sub(loan.interest_repaid);
        let principal_remaining = loan.amount.saturating_sub(loan.principal_repaid);
        Ok(RepaymentSchedule {
            loan_id,
            principal_remaining,
            interest_remaining,
            late_fee_accrued: effective_late,
            total_remaining_due: principal_remaining.saturating_add(interest_remaining),
            due_date: loan.due_date,
            is_overdue: loan.status == LoanStatus::Active && now > loan.due_date,
        })
    }

    pub fn get_loan(env: Env, loan_id: u64) -> Result<Loan, LoanManagerError> {
        env.storage()
            .persistent()
            .get(&LoanDataKey::Loan(loan_id))
            .ok_or(LoanManagerError::LoanNotFound)
    }

    pub fn get_user_loans_page(
        env: Env,
        user: Address,
        cursor: u32,
        limit: u32,
    ) -> Result<Vec<u64>, LoanManagerError> {
        if limit == 0 || limit > MAX_PAGE_SIZE {
            return Err(LoanManagerError::InvalidPageLimit);
        }
        let count: u32 = env
            .storage()
            .persistent()
            .get(&LoanDataKey::UserLoanCount(user.clone()))
            .unwrap_or(0);
        let mut out = Vec::new(&env);
        let end = cursor.saturating_add(limit).min(count);
        let mut idx = cursor;
        while idx < end {
            if let Some(id) = env
                .storage()
                .persistent()
                .get::<_, u64>(&LoanDataKey::UserLoanAt(user.clone(), idx))
            {
                out.push_back(id);
            }
            idx += 1;
        }
        Ok(out)
    }

    pub fn get_active_loans_page(
        env: Env,
        cursor: u32,
        limit: u32,
    ) -> Result<Vec<u64>, LoanManagerError> {
        if limit == 0 || limit > MAX_PAGE_SIZE {
            return Err(LoanManagerError::InvalidPageLimit);
        }
        let count: u32 = env
            .storage()
            .instance()
            .get(&LoanDataKey::ActiveLoanCount)
            .unwrap_or(0);
        let mut out = Vec::new(&env);
        let end = cursor.saturating_add(limit).min(count);
        let mut idx = cursor;
        while idx < end {
            if let Some(id) = env
                .storage()
                .persistent()
                .get::<_, u64>(&LoanDataKey::ActiveLoanAt(idx))
            {
                out.push_back(id);
            }
            idx += 1;
        }
        Ok(out)
    }

    pub fn get_user_loans(env: Env, user: Address) -> Vec<u64> {
        Self::get_user_loans_page(env, user, 0, MAX_PAGE_SIZE).unwrap_or_else(|e| panic!("{:?}", e))
    }

    pub fn get_active_loans(env: Env) -> Vec<u64> {
        Self::get_active_loans_page(env, 0, MAX_PAGE_SIZE).unwrap_or_else(|e| panic!("{:?}", e))
    }

    pub fn get_loan_statistics(env: Env) -> (u64, u64) {
        let total: u64 = env
            .storage()
            .instance()
            .get(&LoanDataKey::LoanCounter)
            .unwrap_or(0);
        let active: u32 = env
            .storage()
            .instance()
            .get(&LoanDataKey::ActiveLoanCount)
            .unwrap_or(0);
        (total, active as u64)
    }

    pub fn extend_loan_ttl(env: Env, loan_id: u64) -> Result<(), LoanManagerError> {
        Self::require_initialized(&env)?;
        let loan_key = LoanDataKey::Loan(loan_id);
        let loan: Loan = env
            .storage()
            .persistent()
            .get(&loan_key)
            .ok_or(LoanManagerError::LoanNotFound)?;
        Self::bump_instance(&env);
        Self::bump_persistent(&env, &loan_key);
        let ul_key = LoanDataKey::UserLoanCount(loan.borrower);
        if env.storage().persistent().has(&ul_key) {
            Self::bump_persistent(&env, &ul_key);
        }
        Ok(())
    }

    // ── Internal Helpers ──────────────────────────────────────────────────────

    fn unlock_collateral_transfer(
        env: &Env,
        recipient: &Address,
        collateral_amount: u128,
    ) -> Result<(), LoanManagerError> {
        let amt: i128 = collateral_amount
            .try_into()
            .map_err(|_| LoanManagerError::ArithmeticOverflow)?;
        let mut pool = Self::get_pool_state(env.clone());
        pool.total_collateral_locked = pool
            .total_collateral_locked
            .saturating_sub(collateral_amount);
        env.storage().instance().set(&LoanDataKey::PoolState, &pool);

        let col_token: Address = env
            .storage()
            .instance()
            .get(&LoanDataKey::CollateralToken)
            .ok_or(LoanManagerError::NotInitialized)?;
        token::Client::new(env, &col_token).transfer(
            &env.current_contract_address(),
            recipient,
            &amt,
        );
        Ok(())
    }

    fn required_collateral_for(env: &Env, principal: u128) -> Result<u128, LoanManagerError> {
        let price_e7: u128 = env
            .storage()
            .instance()
            .get(&LoanDataKey::CollateralPriceE7)
            .unwrap_or(PRICE_SCALE_E7);
        let numer = principal
            .checked_mul(10_000)
            .ok_or(LoanManagerError::ArithmeticOverflow)?
            .checked_mul(PRICE_SCALE_E7)
            .ok_or(LoanManagerError::ArithmeticOverflow)?;
        let denom = MAX_LTV_BPS
            .checked_mul(price_e7)
            .ok_or(LoanManagerError::ArithmeticOverflow)?;
        Self::ceil_div(numer, denom)
    }

    fn compute_accrued_late_fee(loan: &Loan, now: u64) -> Result<u128, LoanManagerError> {
        let grace_end = loan.due_date.saturating_add(GRACE_PERIOD_SECS);
        if now <= grace_end {
            return Ok(0);
        }
        let overdue_secs = now - grace_end;
        let overdue_periods = 1 + (overdue_secs / SECS_PER_MONTH) as u128;
        let remaining_principal = loan.amount.saturating_sub(loan.principal_repaid);
        if remaining_principal == 0 {
            return Ok(0);
        }
        let fee = Self::ceil_div(
            remaining_principal
                .checked_mul(LATE_FEE_BPS_PER_MONTH)
                .ok_or(LoanManagerError::ArithmeticOverflow)?
                .checked_mul(overdue_periods)
                .ok_or(LoanManagerError::ArithmeticOverflow)?,
            10_000,
        )?;
        let cap = (loan.amount.saturating_mul(MAX_LATE_FEE_BPS)) / 10_000;
        Ok(fee.min(cap))
    }

    fn active_borrower_exposure(env: &Env, borrower: &Address) -> (u32, u128) {
        let count: u32 = env
            .storage()
            .persistent()
            .get(&LoanDataKey::UserLoanCount(borrower.clone()))
            .unwrap_or(0);
        let start = count.saturating_sub(50);
        let mut active_cnt = 0u32;
        let mut active_debt = 0u128;
        let mut idx = start;
        while idx < count {
            if let Some(id) = env
                .storage()
                .persistent()
                .get::<_, u64>(&LoanDataKey::UserLoanAt(borrower.clone(), idx))
            {
                if let Some(loan) = env
                    .storage()
                    .persistent()
                    .get::<_, Loan>(&LoanDataKey::Loan(id))
                {
                    if loan.status == LoanStatus::Active || loan.status == LoanStatus::Pending {
                        active_cnt += 1;
                        active_debt = active_debt
                            .saturating_add(loan.amount.saturating_sub(loan.principal_repaid));
                    }
                }
            }
            idx += 1;
        }
        (active_cnt, active_debt)
    }

    /// Unified 0..=100 risk-tier APR schedule matching README and UI:
    /// 80..=100 -> 8%, 70..=79 -> 10%, 60..=69 -> 12%, 50..=59 -> 15%.
    fn calculate_interest_rate(credit_score: u32) -> u32 {
        match credit_score {
            80..=100 => 8,
            70..=79 => 10,
            60..=69 => 12,
            50..=59 => 15,
            _ => 20,
        }
    }

    fn max_debt_for_score(credit_score: u32) -> u128 {
        match credit_score {
            80..=100 => 100_000_000_000,
            70..=79 => 50_000_000_000,
            60..=69 => 25_000_000_000,
            50..=59 => 10_000_000_000,
            _ => 0,
        }
    }

    fn ceil_div(numer: u128, denom: u128) -> Result<u128, LoanManagerError> {
        if denom == 0 {
            return Err(LoanManagerError::InvalidInput);
        }
        if numer == 0 {
            return Ok(0);
        }
        numer
            .checked_add(denom - 1)
            .map(|n| n / denom)
            .ok_or(LoanManagerError::ArithmeticOverflow)
    }

    fn add_to_active_loans(env: &Env, loan_id: u64) {
        let pos_key = LoanDataKey::ActiveLoanPos(loan_id);
        if env.storage().persistent().has(&pos_key) {
            return;
        }
        let count: u32 = env
            .storage()
            .instance()
            .get(&LoanDataKey::ActiveLoanCount)
            .unwrap_or(0);
        let at_key = LoanDataKey::ActiveLoanAt(count);
        env.storage().persistent().set(&at_key, &loan_id);
        env.storage().persistent().set(&pos_key, &count);
        env.storage()
            .instance()
            .set(&LoanDataKey::ActiveLoanCount, &(count + 1));
        Self::bump_persistent(env, &at_key);
        Self::bump_persistent(env, &pos_key);
    }

    fn remove_from_active_loans(env: &Env, loan_id: u64) {
        let pos_key = LoanDataKey::ActiveLoanPos(loan_id);
        if let Some(pos) = env.storage().persistent().get::<_, u32>(&pos_key) {
            let count: u32 = env
                .storage()
                .instance()
                .get(&LoanDataKey::ActiveLoanCount)
                .unwrap_or(0);
            if count > 0 {
                let last_idx = count - 1;
                if pos != last_idx {
                    let last_id: u64 = env
                        .storage()
                        .persistent()
                        .get(&LoanDataKey::ActiveLoanAt(last_idx))
                        .unwrap();
                    let pos_at = LoanDataKey::ActiveLoanAt(pos);
                    let last_pos = LoanDataKey::ActiveLoanPos(last_id);
                    env.storage().persistent().set(&pos_at, &last_id);
                    env.storage().persistent().set(&last_pos, &pos);
                    Self::bump_persistent(env, &pos_at);
                    Self::bump_persistent(env, &last_pos);
                }
                env.storage()
                    .persistent()
                    .remove(&LoanDataKey::ActiveLoanAt(last_idx));
                env.storage()
                    .instance()
                    .set(&LoanDataKey::ActiveLoanCount, &last_idx);
            }
            env.storage().persistent().remove(&pos_key);
        }
    }

    fn require_initialized(env: &Env) -> Result<(), LoanManagerError> {
        if !env.storage().instance().has(&LoanDataKey::Initialized) {
            return Err(LoanManagerError::NotInitialized);
        }
        Ok(())
    }

    fn require_not_paused(env: &Env) -> Result<(), LoanManagerError> {
        if Self::is_paused(env.clone()) {
            return Err(LoanManagerError::ContractPaused);
        }
        Ok(())
    }

    fn require_admin_address(env: &Env) -> Result<Address, LoanManagerError> {
        env.storage()
            .instance()
            .get(&LoanDataKey::Admin)
            .ok_or(LoanManagerError::NotInitialized)
    }

    fn require_admin(env: &Env) -> Result<Address, LoanManagerError> {
        let admin = Self::require_admin_address(env)?;
        admin.require_auth();
        Ok(admin)
    }

    fn bump_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
    }

    fn bump_persistent(env: &Env, key: &LoanDataKey) {
        env.storage()
            .persistent()
            .extend_ttl(key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
    }
}

mod tests;
