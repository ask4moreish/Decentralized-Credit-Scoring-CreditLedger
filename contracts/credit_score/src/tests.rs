#![cfg(test)]

use soroban_sdk::{testutils::Address as _, Address, Env, String, Vec};

use crate::{CreditScoreContract, CreditScoreContractClient, PaymentRecord, SavingsRecord};

fn setup() -> (Env, Address, CreditScoreContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, CreditScoreContract);
    let client = CreditScoreContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    (env, admin, client)
}

#[test]
fn test_initialize() {
    let (_env, admin, client) = setup();
    assert_eq!(client.get_admin(), admin);
}

#[test]
#[should_panic(expected = "Contract already initialized")]
fn test_double_initialize_panics() {
    let (env, _admin, client) = setup();
    let other = Address::generate(&env);
    client.initialize(&other);
}

#[test]
fn test_default_credit_score_is_zero() {
    let (env, _admin, client) = setup();
    let user = Address::generate(&env);
    let score = client.get_credit_score(&user);
    assert_eq!(score.score, 0);
}

#[test]
fn test_update_payment_history_increases_score() {
    let (env, _admin, client) = setup();
    let user = Address::generate(&env);

    let payments = Vec::from_array(
        &env,
        [PaymentRecord {
            amount: 1000,
            timestamp: 1_700_000_000,
            payment_type: String::from_str(&env, "mobile"),
            consistency_score: 80,
        }],
    );

    client.update_payment_history(&user, &payments);
    let score = client.get_credit_score(&user);
    assert!(score.payment_history_score > 0);
    assert!(score.score > 0);
}

#[test]
fn test_update_savings_data_increases_score() {
    let (env, _admin, client) = setup();
    let user = Address::generate(&env);

    let savings = SavingsRecord {
        amount: 5000,
        timestamp: 1_700_000_000,
        duration_months: 12,
        regularity_score: 90,
    };

    client.update_savings_data(&user, &savings);
    let score = client.get_credit_score(&user);
    assert!(score.savings_score > 0);
    assert!(score.score > 0);
}

#[test]
fn test_is_creditworthy() {
    let (env, _admin, client) = setup();
    let user = Address::generate(&env);

    // No data → score 0 → not creditworthy at 500
    assert!(!client.is_creditworthy(&user, &500));

    // Add enough payment history to push score above 0
    let payments = Vec::from_array(
        &env,
        [PaymentRecord {
            amount: 1000,
            timestamp: 1_700_000_000,
            payment_type: String::from_str(&env, "mobile"),
            consistency_score: 100,
        }],
    );
    client.update_payment_history(&user, &payments);

    // Score should now be > 0; creditworthy at threshold 1
    assert!(client.is_creditworthy(&user, &1));
}

#[test]
fn test_update_admin() {
    let (env, _admin, client) = setup();
    let new_admin = Address::generate(&env);
    client.update_admin(&new_admin);
    assert_eq!(client.get_admin(), new_admin);
}

#[test]
fn test_get_payment_history() {
    let (env, _admin, client) = setup();
    let user = Address::generate(&env);

    let payments = Vec::from_array(
        &env,
        [PaymentRecord {
            amount: 200,
            timestamp: 1_700_000_001,
            payment_type: String::from_str(&env, "bank"),
            consistency_score: 70,
        }],
    );
    client.update_payment_history(&user, &payments);

    let history = client.get_payment_history(&user);
    assert_eq!(history.len(), 1);
    assert_eq!(history.get(0).unwrap().amount, 200);
}

#[test]
fn test_get_savings_data() {
    let (env, _admin, client) = setup();
    let user = Address::generate(&env);

    let savings = SavingsRecord {
        amount: 3000,
        timestamp: 1_700_000_002,
        duration_months: 6,
        regularity_score: 85,
    };
    client.update_savings_data(&user, &savings);

    let data = client.get_savings_data(&user);
    assert_eq!(data.len(), 1);
    assert_eq!(data.get(0).unwrap().duration_months, 6);
}
