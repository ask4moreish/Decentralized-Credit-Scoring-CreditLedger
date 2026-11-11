use soroban_sdk::{contracttype, Address};

pub const MIN_SCORE_TO_BORROW: u32 = 50;
pub const UNSECURED_MIN_SCORE: u32 = 60;
pub const MAX_ACTIVE_LOANS_PER_USER: u32 = 3;
pub const MIN_LOAN_AMOUNT: u128 = 1_000;
pub const MAX_DURATION_MONTHS: u32 = 60;
pub const MAX_LTV_BPS: u128 = 8_000; // 80% max loan-to-collateral value => >= 125% collateralization for scores 50..=59
pub const LIQUIDATION_BONUS_BPS: u128 = 500; // 5% capped liquidation fee
pub const LATE_FEE_BPS_PER_MONTH: u128 = 200; // 2% per 30d overdue period
pub const MAX_LATE_FEE_BPS: u128 = 2_500; // Capped at 25% of principal
pub const GRACE_PERIOD_SECS: u64 = 3 * 86_400; // 3-day grace before late fee accrual
pub const SECS_PER_MONTH: u64 = 30 * 86_400;
pub const MIN_POOL_DEPOSIT: u128 = 100;
pub const PRICE_SCALE_E7: u128 = 10_000_000;
pub const MAX_PAGE_SIZE: u32 = 50;

pub const INSTANCE_TTL_THRESHOLD: u32 = 518_400;
pub const INSTANCE_TTL_EXTEND: u32 = 2_592_000;
pub const PERSISTENT_TTL_THRESHOLD: u32 = 518_400;
pub const PERSISTENT_TTL_EXTEND: u32 = 2_592_000;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreditScoreData {
    pub score: u32,
    pub last_updated: u64,
    pub payment_history_score: u32,
    pub savings_score: u32,
    pub community_score: u32,
    pub activity_score: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LoanDataKey {
    Initialized,
    Admin,
    PendingAdmin,
    Paused,
    CreditScoreContract,
    CommunityVouchContract,
    LoanToken,
    CollateralToken,
    LiquidationVault,
    CollateralPriceE7,
    PoolState,
    LenderShares(Address),
    LoanCounter,
    Loan(u64),
    UserLoanCount(Address),
    UserLoanAt(Address, u32),
    ActiveLoanCount,
    ActiveLoanAt(u32),
    ActiveLoanPos(u64),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolState {
    pub total_shares: u128,
    pub available_cash: u128,
    pub outstanding_principal: u128,
    pub total_interest_earned: u128,
    pub total_collateral_locked: u128,
    pub total_defaulted_principal: u128,
    pub total_recovered: u128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LoanStatus {
    Pending,
    Active,
    Repaid,
    Defaulted,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Loan {
    pub id: u64,
    pub borrower: Address,
    pub amount: u128,
    pub interest_rate: u32, // APR percentage: 8, 10, 12, 15 (matching CreditScore tiers)
    pub duration_months: u32,
    pub scheduled_interest: u128,
    pub late_fee_charged: u128,
    pub created_at: u64,
    pub approved_at: u64,
    pub due_date: u64,
    pub last_repaid_at: u64,
    pub status: LoanStatus,
    pub collateral_required: bool,
    pub collateral_amount: u128,
    pub collateral_locked: bool,
    pub credit_score_used: u32,
    pub principal_repaid: u128,
    pub interest_repaid: u128,
    pub repaid_amount: u128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepaymentSchedule {
    pub loan_id: u64,
    pub principal_remaining: u128,
    pub interest_remaining: u128,
    pub late_fee_accrued: u128,
    pub total_remaining_due: u128,
    pub due_date: u64,
    pub is_overdue: bool,
}
