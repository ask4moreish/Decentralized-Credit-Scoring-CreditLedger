use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Map, Vec, String, Symbol, U256, u64, u128};

#[contracttype]
pub enum VouchDataKey {
    UserVouches(Address),
    UserReceivedVouches(Address),
    VouchCounter,
    TrustNetwork(Address),
    Vouch(u64),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Vouch {
    pub id: u64,
    pub voucher: Address,
    pub vouchee: Address,
    pub amount: u128,
    pub trust_score: u32,
    pub reason: String,
    pub created_at: u64,
    pub is_active: bool,
    pub expiration_date: u64,
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

#[contract]
pub struct CommunityVouchContract;

#[contractimpl]
impl CommunityVouchContract {
    
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&VouchDataKey::VouchCounter) {
            panic!("Contract already initialized");
        }
        
        env.storage().instance().set(&Symbol::new(&env, "admin"), &admin);
        env.storage().instance().set(&VouchDataKey::VouchCounter, &0u64);
    }

    pub fn create_vouch(
        env: Env,
        voucher: Address,
        vouchee: Address,
        amount: u128,
        trust_score: u32,
        reason: String,
        duration_months: u32,
    ) -> u64 {
        voucher.require_auth();
        
        // Check vouching limits
        let limits = Self::get_vouching_limits(&env, &voucher);
        
        if amount > limits.max_vouch_amount {
            panic!("Vouch amount exceeds limit");
        }
        
        if trust_score < limits.min_trust_score {
            panic!("Trust score too low");
        }
        
        // Check active vouches count
        let user_vouches: Vec<u64> = env.storage().persistent()
            .get(&VouchDataKey::UserVouches(voucher.clone()))
            .unwrap_or(Vec::new(&env));
        
        let mut active_count = 0;
        for vouch_id in user_vouches.iter() {
            let vouch: Vouch = env.storage().persistent()
                .get(&VouchDataKey::Vouch(*vouch_id))
                .unwrap();
            if vouch.is_active {
                active_count += 1;
            }
        }
        
        if active_count >= limits.max_active_vouches {
            panic!("Maximum active vouches reached");
        }
        
        // Check if voucher and vouchee are the same
        if voucher == vouchee {
            panic!("Cannot vouch for yourself");
        }
        
        // Create vouch
        let vouch_id: u64 = env.storage().instance()
            .get(&VouchDataKey::VouchCounter)
            .unwrap();
        
        let new_vouch_id = vouch_id + 1;
        env.storage().instance().set(&VouchDataKey::VouchCounter, &new_vouch_id);
        
        let current_time = env.ledger().timestamp();
        let expiration_date = current_time + (duration_months as u64 * 30 * 24 * 60 * 60);
        
        let vouch = Vouch {
            id: vouch_id,
            voucher: voucher.clone(),
            vouchee: vouchee.clone(),
            amount,
            trust_score,
            reason,
            created_at: current_time,
            is_active: true,
            expiration_date,
        };
        
        env.storage().persistent().set(&VouchDataKey::Vouch(vouch_id), &vouch);
        
        // Add to voucher's vouches
        let mut voucher_vouches: Vec<u64> = env.storage().persistent()
            .get(&VouchDataKey::UserVouches(voucher.clone()))
            .unwrap_or(Vec::new(&env));
        voucher_vouches.push_back(vouch_id);
        env.storage().persistent().set(&VouchDataKey::UserVouches(voucher), &voucher_vouches);
        
        // Add to vouchee's received vouches
        let mut vouchee_vouches: Vec<u64> = env.storage().persistent()
            .get(&VouchDataKey::UserReceivedVouches(vouchee.clone()))
            .unwrap_or(Vec::new(&env));
        vouchee_vouches.push_back(vouch_id);
        env.storage().persistent().set(&VouchDataKey::UserReceivedVouches(vouchee), &vouchee_vouches);
        
        // Update trust networks
        Self::update_trust_network(&env, &voucher);
        Self::update_trust_network(&env, &vouchee);
        
        vouch_id
    }

    pub fn revoke_vouch(env: Env, voucher: Address, vouch_id: u64) {
        voucher.require_auth();
        
        let mut vouch: Vouch = env.storage().persistent()
            .get(&VouchDataKey::Vouch(vouch_id))
            .unwrap_or_else(|| panic!("Vouch not found"));
        
        if vouch.voucher != voucher {
            panic!("Not the voucher of this vouch");
        }
        
        if !vouch.is_active {
            panic!("Vouch is already inactive");
        }
        
        vouch.is_active = false;
        env.storage().persistent().set(&VouchDataKey::Vouch(vouch_id), &vouch);
        
        // Update trust networks
        Self::update_trust_network(&env, &vouch.voucher);
        Self::update_trust_network(&env, &vouch.vouchee);
    }

    fn update_trust_network(env: &Env, user: &Address) {
        let received_vouches: Vec<u64> = env.storage().persistent()
            .get(&VouchDataKey::UserReceivedVouches(user.clone()))
            .unwrap_or(Vec::new(env));
        
        let mut direct_connections = Vec::new(env);
        let mut indirect_connections = Vec::new(env);
        let mut total_trust_score = 0u32;
        let mut total_amount = 0u128;
        let mut active_vouch_count = 0;
        
        for vouch_id in received_vouches.iter() {
            let vouch: Vouch = env.storage().persistent()
                .get(&VouchDataKey::Vouch(*vouch_id))
                .unwrap();
            
            if vouch.is_active {
                direct_connections.push_back(vouch.voucher);
                total_trust_score += vouch.trust_score;
                total_amount += vouch.amount;
                active_vouch_count += 1;
                
                // Find indirect connections (2nd degree)
                let voucher_connections: Vec<u64> = env.storage().persistent()
                    .get(&VouchDataKey::UserReceivedVouches(vouch.voucher))
                    .unwrap_or(Vec::new(env));
                
                for connection_id in voucher_connections.iter() {
                    let connection_vouch: Vouch = env.storage().persistent()
                        .get(&VouchDataKey::Vouch(*connection_id))
                        .unwrap();
                    
                    if connection_vouch.is_active && connection_vouch.voucher != *user {
                        indirect_connections.push_back(connection_vouch.voucher);
                    }
                }
            }
        }
        
        // Remove duplicates
        let mut unique_direct = Vec::new(env);
        for addr in direct_connections.iter() {
            if !unique_direct.contains(addr) {
                unique_direct.push_back(*addr);
            }
        }
        
        let mut unique_indirect = Vec::new(env);
        for addr in indirect_connections.iter() {
            if !unique_indirect.contains(addr) && !unique_direct.contains(addr) {
                unique_indirect.push_back(*addr);
            }
        }
        
        let avg_trust_score = if active_vouch_count > 0 {
            total_trust_score / active_vouch_count
        } else {
            0
        };
        
        let vouching_capacity = total_amount * 2; // Can vouch for 2x the amount received
        
        let trust_network = TrustNetwork {
            direct_connections: unique_direct,
            indirect_connections: unique_indirect,
            trust_score: avg_trust_score,
            vouching_capacity,
        };
        
        env.storage().persistent().set(&VouchDataKey::TrustNetwork(user.clone()), &trust_network);
    }

    fn get_vouching_limits(env: &Env, user: &Address) -> VouchingLimits {
        let trust_network: TrustNetwork = env.storage().persistent()
            .get(&VouchDataKey::TrustNetwork(user.clone()))
            .unwrap_or(TrustNetwork {
                direct_connections: Vec::new(env),
                indirect_connections: Vec::new(env),
                trust_score: 0,
                vouching_capacity: 1000000, // Default 1M
            });
        
        let max_vouch_amount = trust_network.vouching_capacity;
        let max_active_vouches = match trust_network.trust_score {
            80..=100 => 10,
            60..=79 => 7,
            40..=59 => 5,
            20..=39 => 3,
            _ => 1,
        };
        
        let min_trust_score = std::cmp::max(20, trust_network.trust_score - 20);
        
        VouchingLimits {
            max_vouch_amount,
            max_active_vouches,
            min_trust_score,
        }
    }

    pub fn get_vouch(env: Env, vouch_id: u64) -> Vouch {
        env.storage().persistent()
            .get(&VouchDataKey::Vouch(vouch_id))
            .unwrap_or_else(|| panic!("Vouch not found"))
    }

    pub fn get_user_vouches(env: Env, user: Address) -> Vec<u64> {
        env.storage().persistent()
            .get(&VouchDataKey::UserVouches(user))
            .unwrap_or(Vec::new(&env))
    }

    pub fn get_user_received_vouches(env: Env, user: Address) -> Vec<u64> {
        env.storage().persistent()
            .get(&VouchDataKey::UserReceivedVouches(user))
            .unwrap_or(Vec::new(&env))
    }

    pub fn get_trust_network(env: Env, user: Address) -> TrustNetwork {
        env.storage().persistent()
            .get(&VouchDataKey::TrustNetwork(user))
            .unwrap_or(TrustNetwork {
                direct_connections: Vec::new(&env),
                indirect_connections: Vec::new(&env),
                trust_score: 0,
                vouching_capacity: 1000000,
            })
    }

    pub fn get_vouching_capacity(env: Env, user: Address) -> u128 {
        let trust_network = Self::get_trust_network(env, user);
        trust_network.vouching_capacity
    }

    pub fn is_trusted_connection(env: Env, user1: Address, user2: Address, max_degrees: u32) -> bool {
        let trust_network1 = Self::get_trust_network(env.clone(), user1.clone());
        
        // Check direct connection
        if trust_network1.direct_connections.contains(&user2) {
            return true;
        }
        
        if max_degrees <= 1 {
            return false;
        }
        
        // Check indirect connections (2nd degree)
        if max_degrees >= 2 && trust_network1.indirect_connections.contains(&user2) {
            return true;
        }
        
        // For higher degrees, we'd need to implement a more complex traversal
        // For now, limiting to 2 degrees
        false
    }

    pub fn get_vouch_statistics(env: Env, user: Address) -> Map<String, u64> {
        let mut stats = Map::new(&env);
        
        let user_vouches: Vec<u64> = env.storage().persistent()
            .get(&VouchDataKey::UserVouches(user.clone()))
            .unwrap_or(Vec::new(&env));
        
        let received_vouches: Vec<u64> = env.storage().persistent()
            .get(&VouchDataKey::UserReceivedVouches(user.clone()))
            .unwrap_or(Vec::new(&env));
        
        let mut active_given = 0;
        let mut total_given_amount = 0u128;
        
        for vouch_id in user_vouches.iter() {
            let vouch: Vouch = env.storage().persistent()
                .get(&VouchDataKey::Vouch(*vouch_id))
                .unwrap();
            if vouch.is_active {
                active_given += 1;
                total_given_amount += vouch.amount;
            }
        }
        
        let mut active_received = 0;
        let mut total_received_amount = 0u128;
        
        for vouch_id in received_vouches.iter() {
            let vouch: Vouch = env.storage().persistent()
                .get(&VouchDataKey::Vouch(*vouch_id))
                .unwrap();
            if vouch.is_active {
                active_received += 1;
                total_received_amount += vouch.amount;
            }
        }
        
        stats.set(String::from_str(&env, "total_vouches_given"), user_vouches.len() as u64);
        stats.set(String::from_str(&env, "active_vouches_given"), active_given);
        stats.set(String::from_str(&env, "total_vouches_received"), received_vouches.len() as u64);
        stats.set(String::from_str(&env, "active_vouches_received"), active_received);
        stats.set(String::from_str(&env, "total_given_amount"), total_given_amount as u64);
        stats.set(String::from_str(&env, "total_received_amount"), total_received_amount as u64);
        
        stats
    }

    pub fn cleanup_expired_vouches(env: Env) {
        let vouch_counter: u64 = env.storage().instance()
            .get(&VouchDataKey::VouchCounter)
            .unwrap_or(0);
        
        let current_time = env.ledger().timestamp();
        
        for vouch_id in 1..=vouch_counter {
            if let Ok(mut vouch) = env.storage().persistent().get::<VouchDataKey, Vouch>(&VouchDataKey::Vouch(vouch_id)) {
                if vouch.is_active && current_time > vouch.expiration_date {
                    vouch.is_active = false;
                    env.storage().persistent().set(&VouchDataKey::Vouch(vouch_id), &vouch);
                    
                    // Update trust networks
                    Self::update_trust_network(&env, &vouch.voucher);
                    Self::update_trust_network(&env, &vouch.vouchee);
                }
            }
        }
    }
}
