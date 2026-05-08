use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Vec, String, Symbol};

#[contracttype]
pub enum DataKey {
    UserCreditScore(Address),
    PaymentHistory(Address),
    SavingsData(Address),
    CommunityVouches(Address),
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
pub struct PaymentRecord {
    pub amount: u128,
    pub timestamp: u64,
    pub payment_type: String,
    pub consistency_score: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SavingsRecord {
    pub amount: u128,
    pub timestamp: u64,
    pub duration_months: u32,
    pub regularity_score: u32,
}

/// Lightweight vouch summary stored by this contract.
/// Full vouch data lives in the CommunityVouch contract.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VouchSummary {
    pub voucher: Address,
    pub amount: u128,
    pub trust_score: u32,
    pub timestamp: u64,
}

#[contract]
pub struct CreditScoreContract;

#[contractimpl]
impl CreditScoreContract {

    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&Symbol::new(&env, "admin")) {
            panic!("Contract already initialized");
        }
        env.storage().instance().set(&Symbol::new(&env, "admin"), &admin);
    }

    pub fn update_payment_history(env: Env, user: Address, payments: Vec<PaymentRecord>) {
        user.require_auth();

        let mut history: Vec<PaymentRecord> = env
            .storage().persistent()
            .get(&DataKey::PaymentHistory(user.clone()))
            .unwrap_or(Vec::new(&env));

        for payment in payments.iter() {
            history.push_back(payment);
        }

        env.storage().persistent().set(&DataKey::PaymentHistory(user.clone()), &history);
        Self::recalculate_credit_score(&env, &user);
    }

    pub fn update_savings_data(env: Env, user: Address, savings: SavingsRecord) {
        user.require_auth();

        let mut savings_data: Vec<SavingsRecord> = env
            .storage().persistent()
            .get(&DataKey::SavingsData(user.clone()))
            .unwrap_or(Vec::new(&env));

        savings_data.push_back(savings);
        env.storage().persistent().set(&DataKey::SavingsData(user.clone()), &savings_data);
        Self::recalculate_credit_score(&env, &user);
    }

    /// Called exclusively by the CommunityVouch contract.
    pub fn add_community_vouch(
        env: Env,
        user: Address,
        voucher: Address,
        amount: u128,
        trust_score: u32,
    ) {
        let community_vouch_contract: Address = env
            .storage().instance()
            .get(&Symbol::new(&env, "community_vouch_contract"))
            .expect("community_vouch_contract not set");
        community_vouch_contract.require_auth();

        let mut vouches: Vec<VouchSummary> = env
            .storage().persistent()
            .get(&DataKey::CommunityVouches(user.clone()))
            .unwrap_or(Vec::new(&env));

        vouches.push_back(VouchSummary {
            voucher,
            amount,
            trust_score,
            timestamp: env.ledger().timestamp(),
        });

        env.storage().persistent().set(&DataKey::CommunityVouches(user.clone()), &vouches);
        Self::recalculate_credit_score(&env, &user);
    }

    fn recalculate_credit_score(env: &Env, user: &Address) {
        let payment_score = Self::calculate_payment_score(env, user);
        let savings_score = Self::calculate_savings_score(env, user);
        let community_score = Self::calculate_community_score(env, user);
        let activity_score = Self::calculate_activity_score(env, user);

        let total_score =
            (payment_score * 40 + savings_score * 30 + community_score * 20 + activity_score * 10)
                / 100;

        env.storage().persistent().set(
            &DataKey::UserCreditScore(user.clone()),
            &CreditScoreData {
                score: total_score,
                last_updated: env.ledger().timestamp(),
                payment_history_score: payment_score,
                savings_score,
                community_score,
                activity_score,
            },
        );
    }

    fn calculate_payment_score(env: &Env, user: &Address) -> u32 {
        let history: Vec<PaymentRecord> = env
            .storage().persistent()
            .get(&DataKey::PaymentHistory(user.clone()))
            .unwrap_or(Vec::new(env));

        if history.is_empty() { return 0; }

        let count = history.len() as u32;
        let total: u32 = history.iter().map(|r| r.consistency_score).sum();
        let avg = total / count;
        let bonus = if count >= 12 { 20 } else if count >= 6 { 10 } else { 0 };
        (avg + bonus).min(100)
    }

    fn calculate_savings_score(env: &Env, user: &Address) -> u32 {
        let data: Vec<SavingsRecord> = env
            .storage().persistent()
            .get(&DataKey::SavingsData(user.clone()))
            .unwrap_or(Vec::new(env));

        if data.is_empty() { return 0; }

        let count = data.len() as u32;
        let total_reg: u32 = data.iter().map(|r| r.regularity_score).sum();
        let total_dur: u32 = data.iter().map(|r| r.duration_months).sum();
        let avg_reg = total_reg / count;
        let avg_dur = total_dur / count;
        let bonus = if avg_dur >= 12 { 20 } else if avg_dur >= 6 { 10 } else { 0 };
        (avg_reg + bonus).min(100)
    }

    fn calculate_community_score(env: &Env, user: &Address) -> u32 {
        let vouches: Vec<VouchSummary> = env
            .storage().persistent()
            .get(&DataKey::CommunityVouches(user.clone()))
            .unwrap_or(Vec::new(env));

        if vouches.is_empty() { return 0; }

        let count = vouches.len() as u32;
        let total_trust: u32 = vouches.iter().map(|v| v.trust_score).sum();
        let total_amount: u128 = vouches.iter().map(|v| v.amount).sum();
        let avg_trust = total_trust / count;
        let bonus = if total_amount >= 1_000_000 { 20 } else if total_amount >= 500_000 { 10 } else { 0 };
        (avg_trust + bonus).min(100)
    }

    fn calculate_activity_score(env: &Env, user: &Address) -> u32 {
        let p = env.storage().persistent()
            .get::<_, Vec<PaymentRecord>>(&DataKey::PaymentHistory(user.clone()))
            .map(|v| v.len()).unwrap_or(0);
        let s = env.storage().persistent()
            .get::<_, Vec<SavingsRecord>>(&DataKey::SavingsData(user.clone()))
            .map(|v| v.len()).unwrap_or(0);
        let v = env.storage().persistent()
            .get::<_, Vec<VouchSummary>>(&DataKey::CommunityVouches(user.clone()))
            .map(|v| v.len()).unwrap_or(0);

        match p + s + v {
            0 => 0,
            1..=5 => 20,
            6..=15 => 50,
            16..=30 => 80,
            _ => 100,
        }
    }

    pub fn get_credit_score(env: Env, user: Address) -> CreditScoreData {
        env.storage().persistent()
            .get(&DataKey::UserCreditScore(user))
            .unwrap_or(CreditScoreData {
                score: 0,
                last_updated: 0,
                payment_history_score: 0,
                savings_score: 0,
                community_score: 0,
                activity_score: 0,
            })
    }

    pub fn get_payment_history(env: Env, user: Address) -> Vec<PaymentRecord> {
        env.storage().persistent()
            .get(&DataKey::PaymentHistory(user))
            .unwrap_or(Vec::new(&env))
    }

    pub fn get_savings_data(env: Env, user: Address) -> Vec<SavingsRecord> {
        env.storage().persistent()
            .get(&DataKey::SavingsData(user))
            .unwrap_or(Vec::new(&env))
    }

    pub fn is_creditworthy(env: Env, user: Address, min_score: u32) -> bool {
        Self::get_credit_score(env, user).score >= min_score
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage().instance()
            .get(&Symbol::new(&env, "admin"))
            .unwrap()
    }

    pub fn update_admin(env: Env, new_admin: Address) {
        let admin: Address = env.storage().instance()
            .get(&Symbol::new(&env, "admin"))
            .unwrap();
        admin.require_auth();
        env.storage().instance().set(&Symbol::new(&env, "admin"), &new_admin);
    }

    /// Register the CommunityVouch contract address after deployment.
    /// Required before add_community_vouch can be called.
    pub fn set_community_vouch_contract(env: Env, community_vouch_contract: Address) {
        let admin: Address = env.storage().instance()
            .get(&Symbol::new(&env, "admin"))
            .unwrap();
        admin.require_auth();
        env.storage().instance()
            .set(&Symbol::new(&env, "community_vouch_contract"), &community_vouch_contract);
    }
}
