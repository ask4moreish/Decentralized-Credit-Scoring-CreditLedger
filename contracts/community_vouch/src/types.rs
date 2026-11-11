use soroban_sdk::{contracttype, Address, String, Vec};

pub const MIN_VOUCH_AMOUNT: u128 = 1_000;
pub const MAX_VOUCH_HARD_CAP: u128 = 100_000_000_000;
pub const MAX_DURATION_MONTHS: u32 = 24;
pub const MAX_PAGE_SIZE: u32 = 50;
pub const SECS_PER_MONTH: u64 = 30 * 86_400;
pub const MAX_SLASH_BPS: u128 = 5_000; // 50% explicit cap per default event
pub const MAX_COOLDOWN_SECS: u64 = 30 * 86_400;

pub const INSTANCE_TTL_THRESHOLD: u32 = 518_400;
pub const INSTANCE_TTL_EXTEND: u32 = 2_592_000;
pub const PERSISTENT_TTL_THRESHOLD: u32 = 518_400;
pub const PERSISTENT_TTL_EXTEND: u32 = 2_592_000;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VouchDataKey {
    Initialized,
    Admin,
    PendingAdmin,
    Paused,
    CreditScoreContract,
    LoanManagerContract,
    EscrowToken,
    SlashingPool,
    RevocationCooldownSecs,
    VouchCounter,
    TotalEscrowed,
    TotalSlashed,
    Vouch(u64),
    ActivePairVouch(Address, Address),
    UserGivenCount(Address),
    UserGivenAt(Address, u32),
    UserReceivedCount(Address),
    UserReceivedAt(Address, u32),
    TrustNetwork(Address),
}

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
pub struct Vouch {
    pub id: u64,
    pub voucher: Address,
    pub vouchee: Address,
    pub amount: u128,
    pub escrowed_balance: u128,
    pub slashed_amount: u128,
    pub trust_score: u32,
    pub reason: String,
    pub created_at: u64,
    pub is_active: bool,
    pub withdrawn: bool,
    pub expiration_date: u64,
    pub deactivated_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrustNetwork {
    pub direct_connections: Vec<Address>,
    pub indirect_connections: Vec<Address>,
    pub trust_score: u32,
    pub vouching_capacity: u128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VouchingLimits {
    pub max_vouch_amount: u128,
    pub max_active_vouches: u32,
    pub min_trust_score: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VouchStatistics {
    pub total_vouches_given: u32,
    pub active_vouches_given: u32,
    pub total_vouches_received: u32,
    pub active_vouches_received: u32,
    pub total_given_amount: u128,
    pub total_received_amount: u128,
    pub active_escrowed_given: u128,
    pub active_escrowed_received: u128,
}
