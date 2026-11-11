#![cfg(test)]

use soroban_sdk::{
    contract, contractimpl,
    testutils::{storage::Persistent as _, Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, IntoVal, String, Symbol,
};

use crate::{CommunityVouchContract, CommunityVouchContractClient, CreditScoreData, VouchError};

#[contract]
pub struct MockCreditScore;

#[contractimpl]
impl MockCreditScore {
    pub fn set_score(env: Env, user: Address, score: u32) {
        env.storage()
            .instance()
            .set(&(Symbol::new(&env, "s"), user), &score);
    }

    pub fn set_should_fail(env: Env, fail: bool) {
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "fail"), &fail);
    }

    pub fn get_credit_score(env: Env, user: Address) -> CreditScoreData {
        let score: u32 = env
            .storage()
            .instance()
            .get(&(Symbol::new(&env, "s"), user))
            .unwrap_or(0);
        CreditScoreData {
            score,
            last_updated: 0,
            payment_history_score: score,
            savings_score: score,
            community_score: 0,
            activity_score: score,
        }
    }

    pub fn add_community_vouch(
        env: Env,
        vouch_id: u64,
        user: Address,
        _voucher: Address,
        escrowed_amount: u128,
        trust_score: u32,
        _expires_at: u64,
    ) {
        let should_fail: bool = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "fail"))
            .unwrap_or(false);
        if should_fail {
            panic!("Simulated cross-contract failure");
        }
        env.storage().instance().set(
            &(Symbol::new(&env, "v"), user, vouch_id),
            &(escrowed_amount, trust_score),
        );
    }

    pub fn remove_community_vouch(env: Env, user: Address, vouch_id: u64) {
        env.storage()
            .instance()
            .remove(&(Symbol::new(&env, "v"), user, vouch_id));
    }

    pub fn get_synced_vouch(env: Env, user: Address, vouch_id: u64) -> Option<(u128, u32)> {
        env.storage()
            .instance()
            .get(&(Symbol::new(&env, "v"), user, vouch_id))
    }
}

struct TestCtx<'a> {
    env: Env,
    cs_id: Address,
    client: CommunityVouchContractClient<'a>,
    token: TokenClient<'a>,
    sac: StellarAssetClient<'a>,
}

fn setup() -> TestCtx<'static> {
    let env = Env::default();
    env.ledger().with_mut(|li| {
        li.timestamp = 1_750_000_000;
        li.sequence_number = 10_000;
    });
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let sac_contract = env.register_stellar_asset_contract_v2(token_admin);
    let token_id = sac_contract.address();
    let token = TokenClient::new(&env, &token_id);
    let sac = StellarAssetClient::new(&env, &token_id);

    let cs_id = env.register(MockCreditScore, ());
    let contract_id = env.register(CommunityVouchContract, ());
    let client = CommunityVouchContractClient::new(&env, &contract_id);
    client.initialize(&admin, &cs_id, &token_id);

    TestCtx {
        env,
        cs_id,
        client,
        token,
        sac,
    }
}

#[test]
fn test_initialize_requires_admin_auth_and_rejects_reinit() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let attacker = Address::generate(&env);
    let cs_id = env.register(MockCreditScore, ());
    let tok = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let contract_id = env.register(CommunityVouchContract, ());
    let client = CommunityVouchContractClient::new(&env, &contract_id);

    assert!(client.try_initialize(&admin, &cs_id, &tok).is_err());

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "initialize",
            args: (&admin, &cs_id, &tok).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.initialize(&admin, &cs_id, &tok);
    assert_eq!(client.get_admin(), admin);

    env.mock_all_auths();
    assert_eq!(
        client.try_initialize(&attacker, &cs_id, &tok),
        Err(Ok(VouchError::AlreadyInitialized))
    );
}

#[test]
fn test_real_escrow_policy_weight_and_anti_double_withdraw() {
    let ctx = setup();
    let voucher = Address::generate(&ctx.env);
    let vouchee = Address::generate(&ctx.env);
    let stranger = Address::generate(&ctx.env);

    // Voucher starts with 1_500_000 tokens and score 80
    ctx.sac.mint(&voucher, &1_500_000i128);
    MockCreditScoreClient::new(&ctx.env, &ctx.cs_id).set_score(&voucher, &80u32);

    let vouch_id = ctx.client.create_vouch(
        &voucher,
        &vouchee,
        &1_000_000u128,
        &String::from_str(&ctx.env, "Verified cooperative peer"),
        &6u32,
    );

    // Real escrow locked inside contract
    assert_eq!(ctx.token.balance(&voucher), 500_000);
    assert_eq!(ctx.token.balance(&ctx.client.address), 1_000_000);
    assert_eq!(ctx.client.get_total_escrowed(), 1_000_000);

    // Trust weight computed strictly by policy: (80 * 70 / 100) + 30 = 86
    let vouch = ctx.client.get_vouch(&vouch_id);
    assert_eq!(vouch.trust_score, 86);
    assert_eq!(vouch.escrowed_balance, 1_000_000);

    // Cross-contract sync recorded
    let cs = MockCreditScoreClient::new(&ctx.env, &ctx.cs_id);
    assert_eq!(
        cs.get_synced_vouch(&vouchee, &vouch_id),
        Some((1_000_000u128, 86u32))
    );

    // Duplicate active pair rejected
    assert_eq!(
        ctx.client.try_create_vouch(
            &voucher,
            &vouchee,
            &50_000u128,
            &String::from_str(&ctx.env, "Second"),
            &3u32,
        ),
        Err(Ok(VouchError::DuplicateActiveVouch))
    );

    // Unauthorized revocation rejected
    assert_eq!(
        ctx.client.try_revoke_vouch(&stranger, &vouch_id),
        Err(Ok(VouchError::Unauthorized))
    );

    // Revoking returns real escrowed funds cleanly & prevents double withdrawal
    let refunded = ctx.client.revoke_vouch(&voucher, &vouch_id);
    assert_eq!(refunded, 1_000_000);
    assert_eq!(ctx.token.balance(&voucher), 1_500_000);
    assert_eq!(ctx.token.balance(&ctx.client.address), 0);
    assert_eq!(ctx.client.get_total_escrowed(), 0);
    assert_eq!(cs.get_synced_vouch(&vouchee, &vouch_id), None);

    assert_eq!(
        ctx.client.try_revoke_vouch(&voucher, &vouch_id),
        Err(Ok(VouchError::VouchAlreadyWithdrawn))
    );
    assert_eq!(
        ctx.client
            .try_withdraw_remaining_escrow(&voucher, &vouch_id),
        Err(Ok(VouchError::VouchAlreadyWithdrawn))
    );
}

#[test]
fn test_trust_decay_cooldown_expiry_and_bounded_default_slashing() {
    let ctx = setup();
    let voucher = Address::generate(&ctx.env);
    let vouchee = Address::generate(&ctx.env);
    let loan_manager = Address::generate(&ctx.env);
    let pool = Address::generate(&ctx.env);

    ctx.client.set_loan_manager_contract(&loan_manager, &pool);
    ctx.client.set_revocation_cooldown(&(7 * 86_400));

    ctx.sac.mint(&voucher, &2_000_000i128);
    MockCreditScoreClient::new(&ctx.env, &ctx.cs_id).set_score(&voucher, &60u32);

    let vid = ctx.client.create_vouch(
        &voucher,
        &vouchee,
        &1_000_000u128,
        &String::from_str(&ctx.env, "Trade guild guarantee"),
        &2u32, // 60 days = 5_184_000s
    );
    // Trust = (60*70/100) + 30 = 42 + 30 = 72
    assert_eq!(ctx.client.get_effective_vouch_trust(&vid), 72);

    // Cooldown prevents premature revocation
    assert_eq!(
        ctx.client.try_revoke_vouch(&voucher, &vid),
        Err(Ok(VouchError::CooldownActive))
    );

    // Advance to 75% of vouch duration -> trust decays between 72 and 36 (approx 54)
    let start = ctx.client.get_vouch(&vid).created_at;
    let end = ctx.client.get_vouch(&vid).expiration_date;
    ctx.env.ledger().with_mut(|li| {
        li.timestamp = start + ((end - start) * 3) / 4;
    });
    let decayed = ctx.client.get_effective_vouch_trust(&vid);
    assert!((36..72).contains(&decayed));

    // Unauthorized caller cannot trigger slashing
    ctx.env.mock_auths(&[MockAuth {
        address: &voucher,
        invoke: &MockAuthInvoke {
            contract: &ctx.client.address,
            fn_name: "slash_vouches_on_default",
            args: (&vouchee, &500_000u128).into_val(&ctx.env),
            sub_invokes: &[],
        },
    }]);
    assert!(ctx
        .client
        .try_slash_vouches_on_default(&vouchee, &500_000u128)
        .is_err());

    // LoanManager triggers default slash -> bounded strictly at 50% (500_000 out of 1_000_000)
    ctx.env.mock_all_auths();
    let slashed = ctx.client.slash_vouches_on_default(&vouchee, &900_000u128);
    assert_eq!(slashed, 500_000);
    assert_eq!(ctx.token.balance(&pool), 500_000);
    assert_eq!(ctx.token.balance(&ctx.client.address), 500_000);

    // Voucher safely reclaims unslashed 50% remainder once without double withdrawal
    let reclaimed = ctx.client.withdraw_remaining_escrow(&voucher, &vid);
    assert_eq!(reclaimed, 500_000);
    assert_eq!(ctx.token.balance(&voucher), 1_500_000);
    assert_eq!(ctx.token.balance(&ctx.client.address), 0);
}

#[test]
fn test_vouch_expiry_pagination_and_ttl_extension() {
    let ctx = setup();
    let voucher = Address::generate(&ctx.env);
    let vouchee1 = Address::generate(&ctx.env);
    let vouchee2 = Address::generate(&ctx.env);
    let vouchee3 = Address::generate(&ctx.env);

    ctx.sac.mint(&voucher, &500_000i128);
    MockCreditScoreClient::new(&ctx.env, &ctx.cs_id).set_score(&voucher, &80u32);

    let v1 = ctx.client.create_vouch(
        &voucher,
        &vouchee1,
        &100_000u128,
        &String::from_str(&ctx.env, "Peer 1"),
        &1u32,
    );
    let _v2 = ctx.client.create_vouch(
        &voucher,
        &vouchee2,
        &100_000u128,
        &String::from_str(&ctx.env, "Peer 2"),
        &2u32,
    );
    let _v3 = ctx.client.create_vouch(
        &voucher,
        &vouchee3,
        &100_000u128,
        &String::from_str(&ctx.env, "Peer 3"),
        &3u32,
    );

    let p1 = ctx.client.get_user_vouches_page(&voucher, &0, &2);
    let p2 = ctx.client.get_user_vouches_page(&voucher, &2, &2);
    assert_eq!(p1.len(), 2);
    assert_eq!(p2.len(), 1);
    assert!(ctx.client.is_trusted_connection(&vouchee1, &voucher, &1));

    // Expire v1 only after expiration date passes
    assert_eq!(
        ctx.client.try_expire_vouch(&voucher, &v1),
        Err(Ok(VouchError::VouchNotExpired))
    );
    let exp = ctx.client.get_vouch(&v1).expiration_date;
    ctx.env.ledger().with_mut(|li| {
        li.timestamp = exp;
        li.sequence_number += 1_000;
    });
    let refunded = ctx.client.expire_vouch(&vouchee1, &v1);
    assert_eq!(refunded, 100_000);
    assert_eq!(ctx.token.balance(&voucher), 300_000);

    // Advance ledger sequence far into the future to test persistent/instance TTL maintenance
    ctx.env.ledger().with_mut(|li| {
        li.sequence_number += 2_100_000;
    });
    ctx.client.extend_vouch_ttl(&_v2);
    ctx.env.as_contract(&ctx.client.address, || {
        let ttl = ctx
            .env
            .storage()
            .persistent()
            .get_ttl(&crate::VouchDataKey::Vouch(_v2));
        assert!(ttl >= 2_500_000);
    });
}

#[test]
fn test_adversarial_vouch_circular_sybil_and_double_withdrawal_guards() {
    let ctx = setup();
    let alice = Address::generate(&ctx.env);
    let bob = Address::generate(&ctx.env);
    let charlie = Address::generate(&ctx.env);
    let loan_manager = Address::generate(&ctx.env);
    let pool = Address::generate(&ctx.env);
    ctx.client.set_loan_manager_contract(&loan_manager, &pool);

    ctx.sac.mint(&alice, &2_000_000_000i128);
    ctx.sac.mint(&bob, &2_000_000_000i128);
    ctx.sac.mint(&charlie, &2_000_000_000i128);
    MockCreditScoreClient::new(&ctx.env, &ctx.cs_id).set_score(&alice, &82u32);
    MockCreditScoreClient::new(&ctx.env, &ctx.cs_id).set_score(&bob, &82u32);
    MockCreditScoreClient::new(&ctx.env, &ctx.cs_id).set_score(&charlie, &65u32);

    // 1. Self-vouch blocked
    assert_eq!(
        ctx.client.try_create_vouch(
            &alice,
            &alice,
            &50_000u128,
            &String::from_str(&ctx.env, "Self"),
            &6u32,
        ),
        Err(Ok(VouchError::SelfVouchNotAllowed))
    );

    // 2. Mutual circular vouches Alice <-> Bob are bounded without infinite recursion or score explosion
    let v_ab = ctx.client.create_vouch(
        &alice,
        &bob,
        &100_000u128,
        &String::from_str(&ctx.env, "Alice->Bob"),
        &6u32,
    );
    let _v_ba = ctx.client.create_vouch(
        &bob,
        &alice,
        &100_000u128,
        &String::from_str(&ctx.env, "Bob->Alice"),
        &6u32,
    );
    assert!(ctx.client.get_effective_vouch_trust(&v_ab) <= 100);

    // 3. Duplicate active pair Alice -> Bob blocked
    assert_eq!(
        ctx.client.try_create_vouch(
            &alice,
            &bob,
            &100_000u128,
            &String::from_str(&ctx.env, "Dup"),
            &6u32,
        ),
        Err(Ok(VouchError::DuplicateActiveVouch))
    );

    // 4. Below minimum amount and excessive duration (>24 months) rejected
    assert_eq!(
        ctx.client.try_create_vouch(
            &charlie,
            &alice,
            &999u128,
            &String::from_str(&ctx.env, "Tiny"),
            &6u32,
        ),
        Err(Ok(VouchError::InvalidInput))
    );
    assert_eq!(
        ctx.client.try_create_vouch(
            &charlie,
            &alice,
            &10_000u128,
            &String::from_str(&ctx.env, "TooLong"),
            &25u32,
        ),
        Err(Ok(VouchError::InvalidInput))
    );

    // 5. Revocation cooldown enforcement and double withdrawal protection
    ctx.client.set_revocation_cooldown(&86_400u64);
    let v_cb = ctx.client.create_vouch(
        &charlie,
        &bob,
        &200_000u128,
        &String::from_str(&ctx.env, "Cooldown test"),
        &6u32,
    );
    assert_eq!(
        ctx.client.try_revoke_vouch(&charlie, &v_cb),
        Err(Ok(VouchError::CooldownActive))
    );
    ctx.env.ledger().with_mut(|li| {
        li.timestamp += 86_400;
    });
    assert_eq!(ctx.client.revoke_vouch(&charlie, &v_cb), 200_000);
    // Double withdrawal on already refunded vouch must fail
    assert_eq!(
        ctx.client.try_withdraw_remaining_escrow(&charlie, &v_cb),
        Err(Ok(VouchError::VouchAlreadyWithdrawn))
    );

    // 6. Slashing Bob's vouchees isolates Bob's vouchers and leaves unrelated active vouches intact
    let bob_pre_slash_v = ctx.client.get_vouch(&_v_ba);
    assert!(bob_pre_slash_v.is_active);
    let slashed_on_bob = ctx.client.slash_vouches_on_default(&bob, &500_000u128);
    assert_eq!(slashed_on_bob, 50_000); // 50% of Alice->Bob 100_000
    assert_eq!(ctx.client.withdraw_remaining_escrow(&alice, &v_ab), 50_000);
    // Double withdraw blocked after slash reclaim
    assert_eq!(
        ctx.client.try_withdraw_remaining_escrow(&alice, &v_ab),
        Err(Ok(VouchError::VouchAlreadyWithdrawn))
    );
    // Bob -> Alice remains untouched and active
    assert!(ctx.client.get_vouch(&_v_ba).is_active);
    assert_eq!(ctx.client.get_vouch(&_v_ba).escrowed_balance, 100_000);
}

#[test]
fn test_multi_voucher_sequential_slashing_and_admin_expiry() {
    let ctx = setup();
    let voucher1 = Address::generate(&ctx.env);
    let voucher2 = Address::generate(&ctx.env);
    let borrower = Address::generate(&ctx.env);
    let loan_manager = Address::generate(&ctx.env);
    let pool = Address::generate(&ctx.env);

    ctx.client.set_loan_manager_contract(&loan_manager, &pool);
    ctx.sac.mint(&voucher1, &100_000i128);
    ctx.sac.mint(&voucher2, &200_000i128);
    MockCreditScoreClient::new(&ctx.env, &ctx.cs_id).set_score(&voucher1, &80u32);
    MockCreditScoreClient::new(&ctx.env, &ctx.cs_id).set_score(&voucher2, &80u32);

    let v1 = ctx.client.create_vouch(
        &voucher1,
        &borrower,
        &100_000u128,
        &String::from_str(&ctx.env, "Voucher 1"),
        &6u32,
    );
    let v2 = ctx.client.create_vouch(
        &voucher2,
        &borrower,
        &200_000u128,
        &String::from_str(&ctx.env, "Voucher 2"),
        &6u32,
    );

    // Uncovered loss of 120_000 takes max 50% (50_000) from v1 + remaining 70_000 from v2 (<=50% of 200k)
    let slashed = ctx.client.slash_vouches_on_default(&borrower, &120_000u128);
    assert_eq!(slashed, 120_000);
    assert_eq!(ctx.token.balance(&pool), 120_000);

    // Remaining escrows (50_000 & 130_000) reclaimed independently without cross-leakage
    assert_eq!(ctx.client.withdraw_remaining_escrow(&voucher1, &v1), 50_000);
    assert_eq!(
        ctx.client.withdraw_remaining_escrow(&voucher2, &v2),
        130_000
    );
    assert_eq!(ctx.token.balance(&ctx.client.address), 0);
}
