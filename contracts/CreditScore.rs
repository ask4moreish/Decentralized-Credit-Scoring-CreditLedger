use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Map, Vec, String, Symbol, U256, u64};

#[contracttype]
pub enum DataKey {
    UserCreditScore(Address),
    PaymentHistory(Address),
    SavingsData(Address),
    CommunityVouches(Address),
    UserMetrics(Address),
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

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VouchRecord {
    pub vouch_address: Address,
    pub amount: u128,
    pub timestamp: u64,
    pub trust_score: u32,
}

#[contract]
pub struct CreditScoreContract;

#[contractimpl]
impl CreditScoreContract {
    
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::UserCreditScore(Address::from_contract_id(env.current_contract_address()))) {
            panic!("Contract already initialized");
        }
        
        env.storage().instance().set(&Symbol::new(&env, "admin"), &admin);
    }

    pub fn update_payment_history(env: Env, user: Address, payments: Vec<PaymentRecord>) {
        user.require_auth();
        
        let mut payment_history: Vec<PaymentRecord> = env.storage().persistent().get(&DataKey::PaymentHistory(user.clone()))
            .unwrap_or(Vec::new(&env));
        
        for payment in payments {
            payment_history.push_back(payment);
        }
        
        env.storage().persistent().set(&DataKey::PaymentHistory(user.clone()), &payment_history);
        
        Self::recalculate_credit_score(env, user);
    }

    pub fn update_savings_data(env: Env, user: Address, savings: SavingsRecord) {
        user.require_auth();
        
        let mut savings_data: Vec<SavingsRecord> = env.storage().persistent().get(&DataKey::SavingsData(user.clone()))
            .unwrap_or(Vec::new(&env));
        
        savings_data.push_back(savings);
        env.storage().persistent().set(&DataKey::SavingsData(user.clone()), &savings_data);
        
        Self::recalculate_credit_score(env, user);
    }

    pub fn add_community_vouch(env: Env, user: Address, voucher: Address, amount: u128, trust_score: u32) {
        voucher.require_auth();
        
        let vouch_record = VouchRecord {
            vouch_address: voucher,
            amount,
            timestamp: env.ledger().timestamp(),
            trust_score,
        };
        
        let mut vouches: Vec<VouchRecord> = env.storage().persistent().get(&DataKey::CommunityVouches(user.clone()))
            .unwrap_or(Vec::new(&env));
        
        vouches.push_back(vouch_record);
        env.storage().persistent().set(&DataKey::CommunityVouches(user.clone()), &vouches);
        
        Self::recalculate_credit_score(env, user);
    }

    fn recalculate_credit_score(env: Env, user: Address) {
        let payment_score = Self::calculate_payment_score(&env, &user);
        let savings_score = Self::calculate_savings_score(&env, &user);
        let community_score = Self::calculate_community_score(&env, &user);
        let activity_score = Self::calculate_activity_score(&env, &user);
        
        let total_score = (payment_score * 40 + savings_score * 30 + community_score * 20 + activity_score * 10) / 100;
        
        let credit_data = CreditScoreData {
            score: total_score,
            last_updated: env.ledger().timestamp(),
            payment_history_score: payment_score,
            savings_score,
            community_score,
            activity_score,
        };
        
        env.storage().persistent().set(&DataKey::UserCreditScore(user.clone()), &credit_data);
    }

    fn calculate_payment_score(env: &Env, user: &Address) -> u32 {
        let payment_history: Vec<PaymentRecord> = env.storage().persistent()
            .get(&DataKey::PaymentHistory(user.clone()))
            .unwrap_or(Vec::new(env));
        
        if payment_history.is_empty() {
            return 0;
        }
        
        let mut total_consistency = 0u32;
        let mut count = 0u32;
        
        for record in payment_history.iter() {
            total_consistency += record.consistency_score;
            count += 1;
        }
        
        if count == 0 { return 0; }
        
        let avg_consistency = total_consistency / count;
        
        // Bonus for payment frequency
        let frequency_bonus = if count >= 12 { 20 } else if count >= 6 { 10 } else { 0 };
        
        std::cmp::min(100, avg_consistency + frequency_bonus)
    }

    fn calculate_savings_score(env: &Env, user: &Address) -> u32 {
        let savings_data: Vec<SavingsRecord> = env.storage().persistent()
            .get(&DataKey::SavingsData(user.clone()))
            .unwrap_or(Vec::new(env));
        
        if savings_data.is_empty() {
            return 0;
        }
        
        let mut total_regularity = 0u32;
        let mut total_duration = 0u32;
        let mut count = 0u32;
        
        for record in savings_data.iter() {
            total_regularity += record.regularity_score;
            total_duration += record.duration_months;
            count += 1;
        }
        
        if count == 0 { return 0; }
        
        let avg_regularity = total_regularity / count;
        let avg_duration = total_duration / count;
        
        // Bonus for long-term savings
        let duration_bonus = if avg_duration >= 12 { 20 } else if avg_duration >= 6 { 10 } else { 0 };
        
        std::cmp::min(100, avg_regularity + duration_bonus)
    }

    fn calculate_community_score(env: &Env, user: &Address) -> u32 {
        let vouches: Vec<VouchRecord> = env.storage().persistent()
            .get(&DataKey::CommunityVouches(user.clone()))
            .unwrap_or(Vec::new(env));
        
        if vouches.is_empty() {
            return 0;
        }
        
        let mut total_trust = 0u32;
        let mut total_amount = 0u128;
        
        for record in vouches.iter() {
            total_trust += record.trust_score;
            total_amount += record.amount;
        }
        
        let avg_trust = total_trust / vouches.len() as u32;
        
        // Bonus for high-value vouches
        let amount_bonus = if total_amount >= 1000000 { 20 } else if total_amount >= 500000 { 10 } else { 0 };
        
        std::cmp::min(100, avg_trust + amount_bonus)
    }

    fn calculate_activity_score(env: &Env, user: &Address) -> u32 {
        let payment_history: Vec<PaymentRecord> = env.storage().persistent()
            .get(&DataKey::PaymentHistory(user.clone()))
            .unwrap_or(Vec::new(env));
        
        let savings_data: Vec<SavingsRecord> = env.storage().persistent()
            .get(&DataKey::SavingsData(user.clone()))
            .unwrap_or(Vec::new(env));
        
        let vouches: Vec<VouchRecord> = env.storage().persistent()
            .get(&DataKey::CommunityVouches(user.clone()))
            .unwrap_or(Vec::new(env));
        
        let total_activities = payment_history.len() + savings_data.len() + vouches.len();
        
        match total_activities {
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

    pub fn get_community_vouches(env: Env, user: Address) -> Vec<VouchRecord> {
        env.storage().persistent()
            .get(&DataKey::CommunityVouches(user))
            .unwrap_or(Vec::new(&env))
    }

    pub fn is_creditworthy(env: Env, user: Address, min_score: u32) -> bool {
        let credit_data = Self::get_credit_score(env, user);
        credit_data.score >= min_score
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage().instance()
            .get(&Symbol::new(&env, "admin"))
            .unwrap()
    }

    pub fn update_admin(env: Env, current_admin: Address, new_admin: Address) {
        let admin: Address = env.storage().instance()
            .get(&Symbol::new(&env, "admin"))
            .unwrap();
        
        admin.require_auth();
        
        env.storage().instance().set(&Symbol::new(&env, "admin"), &new_admin);
    }
}
