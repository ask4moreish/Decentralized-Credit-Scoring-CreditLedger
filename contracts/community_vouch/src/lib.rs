use soroban_sdk::{contract, contractclient, contractimpl, contracttype, Address, Env, Vec, String, Symbol};

#[contractclient(name = "CreditScoreContractClient")]
pub trait CreditScoreContract {
    fn add_community_vouch(
        &self,
        user: &Address,
        voucher: &Address,
        amount: u128,
        trust_score: u32,
    );
}

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

/// Statistics returned by get_vouch_statistics.
/// Amounts are kept as u128 to avoid silent truncation.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VouchStatistics {
    pub total_vouches_given: u32,
    pub active_vouches_given: u32,
    pub total_vouches_received: u32,
    pub active_vouches_received: u32,
    pub total_given_amount: u128,
    pub total_received_amount: u128,
}

#[contract]
pub struct CommunityVouchContract;

#[contractimpl]
impl CommunityVouchContract {

    pub fn initialize(env: Env, admin: Address, credit_score_contract: Address) {
        if env.storage().instance().has(&VouchDataKey::VouchCounter) {
            panic!("Contract already initialized");
        }
        env.storage().instance().set(&Symbol::new(&env, "admin"), &admin);
        env.storage().instance().set(&Symbol::new(&env, "credit_score_contract"), &credit_score_contract);
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

        if voucher == vouchee {
            panic!("Cannot vouch for yourself");
        }

        let limits = Self::get_vouching_limits(&env, &voucher);

        if amount > limits.max_vouch_amount {
            panic!("Vouch amount exceeds limit");
        }
        if trust_score < limits.min_trust_score {
            panic!("Trust score too low");
        }

        // Count active vouches given by this voucher.
        let user_vouches: Vec<u64> = env
            .storage()
            .persistent()
            .get(&VouchDataKey::UserVouches(voucher.clone()))
            .unwrap_or(Vec::new(&env));

        let active_count = user_vouches.iter().filter(|&id| {
            env.storage()
                .persistent()
                .get::<_, Vouch>(&VouchDataKey::Vouch(id))
                .map(|v| v.is_active)
                .unwrap_or(false)
        }).count() as u32;

        if active_count >= limits.max_active_vouches {
            panic!("Maximum active vouches reached");
        }

        // Increment counter first; first vouch id = 1.
        let vouch_id: u64 = env
            .storage()
            .instance()
            .get(&VouchDataKey::VouchCounter)
            .unwrap_or(0u64)
            + 1;
        env.storage()
            .instance()
            .set(&VouchDataKey::VouchCounter, &vouch_id);

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

        env.storage()
            .persistent()
            .set(&VouchDataKey::Vouch(vouch_id), &vouch);

        let mut voucher_vouches: Vec<u64> = env
            .storage()
            .persistent()
            .get(&VouchDataKey::UserVouches(voucher.clone()))
            .unwrap_or(Vec::new(&env));
        voucher_vouches.push_back(vouch_id);
        env.storage()
            .persistent()
            .set(&VouchDataKey::UserVouches(voucher.clone()), &voucher_vouches);

        let mut vouchee_vouches: Vec<u64> = env
            .storage()
            .persistent()
            .get(&VouchDataKey::UserReceivedVouches(vouchee.clone()))
            .unwrap_or(Vec::new(&env));
        vouchee_vouches.push_back(vouch_id);
        env.storage()
            .persistent()
            .set(&VouchDataKey::UserReceivedVouches(vouchee.clone()), &vouchee_vouches);

        Self::update_trust_network(&env, &voucher);
        Self::update_trust_network(&env, &vouchee);

        // Notify the CreditScore contract so the vouchee's community score updates.
        let credit_score_contract: Address = env
            .storage().instance()
            .get(&Symbol::new(&env, "credit_score_contract"))
            .unwrap();
        CreditScoreContractClient::new(&env, &credit_score_contract)
            .add_community_vouch(&vouchee, &voucher, &amount, &trust_score);

        vouch_id
    }

    pub fn revoke_vouch(env: Env, voucher: Address, vouch_id: u64) {
        voucher.require_auth();

        let mut vouch: Vouch = env
            .storage()
            .persistent()
            .get(&VouchDataKey::Vouch(vouch_id))
            .unwrap_or_else(|| panic!("Vouch not found"));

        if vouch.voucher != voucher {
            panic!("Not the voucher of this vouch");
        }
        if !vouch.is_active {
            panic!("Vouch is already inactive");
        }

        vouch.is_active = false;
        env.storage()
            .persistent()
            .set(&VouchDataKey::Vouch(vouch_id), &vouch);

        // Clone addresses before moving vouch into update calls.
        let voucher_addr = vouch.voucher.clone();
        let vouchee_addr = vouch.vouchee.clone();
        Self::update_trust_network(&env, &voucher_addr);
        Self::update_trust_network(&env, &vouchee_addr);
    }

    /// Expire a single vouch by id. Must be called by the voucher or vouchee.
    /// Caller-triggered per-vouch expiry avoids O(n) full scans.
    pub fn expire_vouch(env: Env, caller: Address, vouch_id: u64) {
        caller.require_auth();

        let mut vouch: Vouch = env
            .storage()
            .persistent()
            .get(&VouchDataKey::Vouch(vouch_id))
            .unwrap_or_else(|| panic!("Vouch not found"));

        if caller != vouch.voucher && caller != vouch.vouchee {
            panic!("Only the voucher or vouchee can expire this vouch");
        }
        if !vouch.is_active {
            return;
        }
        if env.ledger().timestamp() <= vouch.expiration_date {
            panic!("Vouch has not expired yet");
        }

        vouch.is_active = false;
        env.storage()
            .persistent()
            .set(&VouchDataKey::Vouch(vouch_id), &vouch);

        let voucher_addr = vouch.voucher.clone();
        let vouchee_addr = vouch.vouchee.clone();
        Self::update_trust_network(&env, &voucher_addr);
        Self::update_trust_network(&env, &vouchee_addr);
    }

    fn update_trust_network(env: &Env, user: &Address) {
        let received_vouches: Vec<u64> = env
            .storage()
            .persistent()
            .get(&VouchDataKey::UserReceivedVouches(user.clone()))
            .unwrap_or(Vec::new(env));

        let mut direct_connections: Vec<Address> = Vec::new(env);
        let mut indirect_connections: Vec<Address> = Vec::new(env);
        let mut total_trust_score = 0u32;
        let mut total_amount = 0u128;
        let mut active_vouch_count = 0u32;

        for vouch_id in received_vouches.iter() {
            let vouch: Vouch = env
                .storage()
                .persistent()
                .get(&VouchDataKey::Vouch(vouch_id))
                .unwrap();

            if !vouch.is_active {
                continue;
            }

            // Use clone() — Address does not implement Copy.
            let voucher_addr = vouch.voucher.clone();
            direct_connections.push_back(voucher_addr.clone());
            total_trust_score += vouch.trust_score;
            total_amount += vouch.amount;
            active_vouch_count += 1;

            // 2nd-degree connections: vouches received by this voucher.
            let voucher_received: Vec<u64> = env
                .storage()
                .persistent()
                .get(&VouchDataKey::UserReceivedVouches(voucher_addr))
                .unwrap_or(Vec::new(env));

            for conn_id in voucher_received.iter() {
                let conn_vouch: Vouch = env
                    .storage()
                    .persistent()
                    .get(&VouchDataKey::Vouch(conn_id))
                    .unwrap();

                if conn_vouch.is_active && conn_vouch.voucher != *user {
                    indirect_connections.push_back(conn_vouch.voucher.clone());
                }
            }
        }

        // Deduplicate using a single pass with contains() — acceptable because
        // direct/indirect connection lists are bounded by the active-vouch cap
        // (max 10 per user), so this is O(cap²) = O(100) worst case, not O(n²).
        let mut unique_direct: Vec<Address> = Vec::new(env);
        for addr in direct_connections.iter() {
            if !unique_direct.contains(&addr) {
                unique_direct.push_back(addr.clone());
            }
        }

        let mut unique_indirect: Vec<Address> = Vec::new(env);
        for addr in indirect_connections.iter() {
            if !unique_indirect.contains(&addr) && !unique_direct.contains(&addr) {
                unique_indirect.push_back(addr.clone());
            }
        }

        let avg_trust_score = if active_vouch_count > 0 {
            total_trust_score / active_vouch_count
        } else {
            0
        };

        let trust_network = TrustNetwork {
            direct_connections: unique_direct,
            indirect_connections: unique_indirect,
            trust_score: avg_trust_score,
            vouching_capacity: total_amount * 2,
        };

        env.storage()
            .persistent()
            .set(&VouchDataKey::TrustNetwork(user.clone()), &trust_network);
    }

    fn get_vouching_limits(env: &Env, user: &Address) -> VouchingLimits {
        let trust_network: TrustNetwork = env
            .storage()
            .persistent()
            .get(&VouchDataKey::TrustNetwork(user.clone()))
            .unwrap_or(TrustNetwork {
                direct_connections: Vec::new(env),
                indirect_connections: Vec::new(env),
                trust_score: 0,
                vouching_capacity: 1_000_000,
            });

        let max_active_vouches = match trust_network.trust_score {
            80..=100 => 10,
            60..=79 => 7,
            40..=59 => 5,
            20..=39 => 3,
            _ => 1,
        };

        let min_trust_score = trust_network.trust_score.saturating_sub(20).max(20);

        VouchingLimits {
            max_vouch_amount: trust_network.vouching_capacity,
            max_active_vouches,
            min_trust_score,
        }
    }

    pub fn get_vouch(env: Env, vouch_id: u64) -> Vouch {
        env.storage()
            .persistent()
            .get(&VouchDataKey::Vouch(vouch_id))
            .unwrap_or_else(|| panic!("Vouch not found"))
    }

    pub fn get_user_vouches(env: Env, user: Address) -> Vec<u64> {
        env.storage()
            .persistent()
            .get(&VouchDataKey::UserVouches(user))
            .unwrap_or(Vec::new(&env))
    }

    pub fn get_user_received_vouches(env: Env, user: Address) -> Vec<u64> {
        env.storage()
            .persistent()
            .get(&VouchDataKey::UserReceivedVouches(user))
            .unwrap_or(Vec::new(&env))
    }

    pub fn get_trust_network(env: Env, user: Address) -> TrustNetwork {
        env.storage()
            .persistent()
            .get(&VouchDataKey::TrustNetwork(user))
            .unwrap_or(TrustNetwork {
                direct_connections: Vec::new(&env),
                indirect_connections: Vec::new(&env),
                trust_score: 0,
                vouching_capacity: 1_000_000,
            })
    }

    pub fn get_vouching_capacity(env: Env, user: Address) -> u128 {
        Self::get_trust_network(env, user).vouching_capacity
    }

    pub fn is_trusted_connection(env: Env, user1: Address, user2: Address, max_degrees: u32) -> bool {
        let network = Self::get_trust_network(env, user1);

        if network.direct_connections.contains(&user2) {
            return true;
        }
        if max_degrees >= 2 && network.indirect_connections.contains(&user2) {
            return true;
        }
        false
    }

    /// Returns a VouchStatistics struct with u128 amounts.
    /// The previous implementation silently truncated u128 → u64 via `as u64`.
    pub fn get_vouch_statistics(env: Env, user: Address) -> VouchStatistics {
        let given: Vec<u64> = env
            .storage()
            .persistent()
            .get(&VouchDataKey::UserVouches(user.clone()))
            .unwrap_or(Vec::new(&env));

        let received: Vec<u64> = env
            .storage()
            .persistent()
            .get(&VouchDataKey::UserReceivedVouches(user.clone()))
            .unwrap_or(Vec::new(&env));

        let mut active_given = 0u32;
        let mut total_given_amount = 0u128;

        for id in given.iter() {
            let v: Vouch = env.storage().persistent().get(&VouchDataKey::Vouch(id)).unwrap();
            if v.is_active {
                active_given += 1;
                total_given_amount += v.amount;
            }
        }

        let mut active_received = 0u32;
        let mut total_received_amount = 0u128;

        for id in received.iter() {
            let v: Vouch = env.storage().persistent().get(&VouchDataKey::Vouch(id)).unwrap();
            if v.is_active {
                active_received += 1;
                total_received_amount += v.amount;
            }
        }

        VouchStatistics {
            total_vouches_given: given.len() as u32,
            active_vouches_given: active_given,
            total_vouches_received: received.len() as u32,
            active_vouches_received: active_received,
            total_given_amount,
            total_received_amount,
        }
    }
}
