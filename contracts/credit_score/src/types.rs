use soroban_sdk::{contracttype, Address, BytesN, String};

pub const SCORING_MODEL_VERSION: u32 = 2;
pub const MAX_SCORE: u32 = 100;
pub const MAX_BATCH_SIZE: u32 = 25;
pub const MAX_PAGE_SIZE: u32 = 50;
pub const MAX_FUTURE_DRIFT_SECS: u64 = 300;
pub const RECENT_WINDOW_SECS: u64 = 15_552_000; // 180 days
pub const MID_WINDOW_SECS: u64 = 31_536_000; // 365 days

pub const ATTESTATION_KIND_PAYMENT: u32 = 1;
pub const ATTESTATION_KIND_SAVINGS: u32 = 2;

pub const INSTANCE_TTL_THRESHOLD: u32 = 518_400; // ~30 days
pub const INSTANCE_TTL_EXTEND: u32 = 2_592_000; // ~150 days
pub const PERSISTENT_TTL_THRESHOLD: u32 = 518_400; // ~30 days
pub const PERSISTENT_TTL_EXTEND: u32 = 2_592_000; // ~150 days

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Initialized,
    Admin,
    PendingAdmin,
    Paused,
    CommunityVouchContract,
    LoanManagerContract,
    Issuer(Address),
    IssuerCount,
    IssuerAt(u32),
    Attestation(BytesN<32>),
    UserAttestationCount(Address),
    UserAttestationIdAt(Address, u32),
    UserCreditScore(Address),
    UserLoanStats(Address),
    UserSelfReportCount(Address),
    UserSelfReportAt(Address, u32),
    UserActiveVouchCount(Address),
    UserActiveVouchIdAt(Address, u32),
    UserVouchPos(Address, u64),
    UserVouchEntry(Address, u64),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IssuerInfo {
    pub issuer: Address,
    pub verification_key: BytesN<32>,
    pub category: u32, // 1=Bank/FI, 2=MobileMoney, 3=DataProvider, 4=VerifiedInstitution
    pub name: String,
    pub metadata_uri: String,
    pub authorized: bool,
    pub revoked_for_cause: bool,
    pub registered_at: u64,
    pub revoked_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FinancialAttestation {
    pub attestation_id: BytesN<32>,
    pub subject: Address,
    pub issuer: Address,
    pub kind: u32, // 1=Payment, 2=Savings
    pub record_commitment: BytesN<32>,
    pub metric_score: u32, // 0..=100
    pub amount_units: u128,
    pub duration_months: u32,
    pub issued_at: u64,
    pub expires_at: u64,
    pub revoked: bool,
    pub revoked_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttestationInput {
    pub attestation_id: BytesN<32>,
    pub subject: Address,
    pub kind: u32,
    pub record_commitment: BytesN<32>,
    pub metric_score: u32,
    pub amount_units: u128,
    pub duration_months: u32,
    pub issued_at: u64,
    pub expires_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelfReportInput {
    pub kind: u32, // 1=Payment, 2=Savings
    pub record_commitment: BytesN<32>,
    pub claimed_amount: u128,
    pub claimed_metric: u32,
    pub duration_months: u32,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelfReportedRecord {
    pub record_commitment: BytesN<32>,
    pub kind: u32, // 1=Payment, 2=Savings
    pub claimed_amount: u128,
    pub claimed_metric: u32,
    pub duration_months: u32,
    pub timestamp: u64,
    pub verified: bool, // Always false
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VouchSummary {
    pub vouch_id: u64,
    pub voucher: Address,
    pub escrowed_amount: u128,
    pub trust_score: u32,
    pub expires_at: u64,
    pub updated_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LoanOutcomeStats {
    pub repaid_count: u32,
    pub on_time_count: u32,
    pub late_count: u32,
    pub defaulted_count: u32,
    pub last_event_at: u64,
}

/// Core 0..=100 score returned to LoanManager and readers (backwards-compatible field set + extension).
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

/// Transparent, versioned, explainable credit score breakdown.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScoreBreakdown {
    pub model_version: u32,
    pub score: u32,
    pub payment_history_score: u32,
    pub savings_score: u32,
    pub repayment_score: u32,
    pub community_score: u32,
    pub activity_score: u32,
    pub weight_payment: u32,
    pub weight_savings: u32,
    pub weight_repayment: u32,
    pub weight_community: u32,
    pub weight_activity: u32,
    pub default_penalty: u32,
    pub verified_payment_count: u32,
    pub verified_savings_count: u32,
    pub active_vouch_count: u32,
    pub self_reported_count: u32,
    pub repaid_loans: u32,
    pub defaulted_loans: u32,
    pub last_updated: u64,
}
