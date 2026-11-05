#![cfg(test)]

use soroban_sdk::{contract, contractimpl, testutils::Address as _, Address, Env, String};

use crate::{CommunityVouchContract, CommunityVouchContractClient};

// ── Mock CreditScore that accepts add_community_vouch and remove_community_vouch ──

#[contract]
pub struct MockCreditScore;

#[contractimpl]
impl MockCreditScore {
    pub fn add_community_vouch(
        _env: Env,
        _user: Address,
        _voucher: Address,
        _amount: u128,
        _trust_score: u32,
    ) {
        // no-op
    }

    pub fn remove_community_vouch(
        _env: Env,
        _user: Address,
        _voucher: Address,
    ) {
        // no-op
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn setup() -> (Env, Address, CommunityVouchContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();

    let mock_cs_id = env.register(MockCreditScore, ());
    let contract_id = env.register(CommunityVouchContract, ());
    let client = CommunityVouchContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);

    client.initialize(&admin, &mock_cs_id);
    (env, admin, client)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Contract already initialized")]
fn test_double_initialize_panics() {
    let (env, admin, client) = setup();
    let cs = Address::generate(&env);
    client.initialize(&admin, &cs);
}

#[test]
fn test_create_vouch_returns_id() {
    let (env, _admin, client) = setup();
    let voucher = Address::generate(&env);
    let vouchee = Address::generate(&env);

    // New voucher has no trust network → vouching_capacity defaults to 1_000_000
    // and min_trust_score = max(0 - 20, 20) = 20; trust_score 50 ≥ 20 ✓
    let vouch_id = client.create_vouch(
        &voucher,
        &vouchee,
        &500_000u128,
        &50u32,
        &String::from_str(&env, "Good community member"),
        &6u32,
    );
    assert_eq!(vouch_id, 1);
}

#[test]
fn test_get_vouch_after_create() {
    let (env, _admin, client) = setup();
    let voucher = Address::generate(&env);
    let vouchee = Address::generate(&env);

    let vouch_id = client.create_vouch(
        &voucher,
        &vouchee,
        &100_000u128,
        &50u32,
        &String::from_str(&env, "Trusted"),
        &3u32,
    );

    let vouch = client.get_vouch(&vouch_id);
    assert_eq!(vouch.voucher, voucher);
    assert_eq!(vouch.vouchee, vouchee);
    assert_eq!(vouch.amount, 100_000u128);
    assert!(vouch.is_active);
}

#[test]
fn test_revoke_vouch() {
    let (env, _admin, client) = setup();
    let voucher = Address::generate(&env);
    let vouchee = Address::generate(&env);

    let vouch_id = client.create_vouch(
        &voucher,
        &vouchee,
        &100_000u128,
        &50u32,
        &String::from_str(&env, "Trusted"),
        &3u32,
    );

    client.revoke_vouch(&voucher, &vouch_id);
    let vouch = client.get_vouch(&vouch_id);
    assert!(!vouch.is_active);
}

#[test]
#[should_panic(expected = "Cannot vouch for yourself")]
fn test_cannot_vouch_for_self() {
    let (env, _admin, client) = setup();
    let user = Address::generate(&env);
    client.create_vouch(
        &user,
        &user,
        &100_000u128,
        &50u32,
        &String::from_str(&env, "Self"),
        &1u32,
    );
}

#[test]
fn test_get_user_vouches() {
    let (env, _admin, client) = setup();
    let voucher1 = Address::generate(&env);
    let voucher2 = Address::generate(&env);
    let vouchee1 = Address::generate(&env);
    let vouchee2 = Address::generate(&env);

    client.create_vouch(&voucher1, &vouchee1, &100_000u128, &50u32, &String::from_str(&env, "A"), &3u32);
    client.create_vouch(&voucher2, &vouchee2, &100_000u128, &50u32, &String::from_str(&env, "B"), &3u32);

    let vouches1 = client.get_user_vouches(&voucher1);
    assert_eq!(vouches1.len(), 1);
    let vouches2 = client.get_user_vouches(&voucher2);
    assert_eq!(vouches2.len(), 1);
}

#[test]
fn test_get_user_received_vouches() {
    let (env, _admin, client) = setup();
    let voucher = Address::generate(&env);
    let vouchee = Address::generate(&env);

    client.create_vouch(&voucher, &vouchee, &100_000u128, &50u32, &String::from_str(&env, "A"), &3u32);

    let received = client.get_user_received_vouches(&vouchee);
    assert_eq!(received.len(), 1);
}

#[test]
fn test_vouch_statistics() {
    let (env, _admin, client) = setup();
    let voucher = Address::generate(&env);
    let vouchee = Address::generate(&env);

    client.create_vouch(&voucher, &vouchee, &100_000u128, &50u32, &String::from_str(&env, "A"), &3u32);

    let stats = client.get_vouch_statistics(&voucher);
    assert_eq!(stats.total_vouches_given, 1);
    assert_eq!(stats.active_vouches_given, 1);

    let stats_vouchee = client.get_vouch_statistics(&vouchee);
    assert_eq!(stats_vouchee.total_vouches_received, 1);
    assert_eq!(stats_vouchee.active_vouches_received, 1);
}

#[test]
fn test_is_trusted_connection() {
    let (env, _admin, client) = setup();
    let voucher = Address::generate(&env);
    let vouchee = Address::generate(&env);
    let stranger = Address::generate(&env);

    client.create_vouch(&voucher, &vouchee, &100_000u128, &50u32, &String::from_str(&env, "A"), &3u32);

    // vouchee should see voucher as a direct connection
    assert!(client.is_trusted_connection(&vouchee, &voucher, &1u32));
    // stranger is not connected
    assert!(!client.is_trusted_connection(&vouchee, &stranger, &2u32));
}
