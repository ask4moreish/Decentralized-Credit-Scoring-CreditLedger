#![cfg(test)]

use soroban_sdk::{contract, contractimpl, testutils::Address as _, Address, Env, Vec};

use crate::{CreditScoreData, CreditScoreContract, LoanManagerContract, LoanManagerContractClient, LoanStatus};

// ── Minimal mock CreditScore contract ────────────────────────────────────────

#[contract]
pub struct MockCreditScore;

#[contractimpl]
impl MockCreditScore {
    pub fn get_credit_score(_env: Env, _user: Address) -> CreditScoreData {
        CreditScoreData {
            score: 750,
            last_updated: 0,
            payment_history_score: 80,
            savings_score: 70,
            community_score: 60,
            activity_score: 50,
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn setup() -> (Env, Address, Address, LoanManagerContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();

    let mock_cs_id = env.register_contract(None, MockCreditScore);
    let contract_id = env.register_contract(None, LoanManagerContract);
    let client = LoanManagerContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);

    client.initialize(&admin, &mock_cs_id);
    (env, admin, mock_cs_id, client)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Contract already initialized")]
fn test_double_initialize_panics() {
    let (env, admin, cs, client) = setup();
    client.initialize(&admin, &cs);
}

#[test]
fn test_create_loan_returns_id() {
    let (env, _admin, _cs, client) = setup();
    let borrower = Address::generate(&env);
    let loan_id = client.create_loan(&borrower, &1_000_000u128, &12u32);
    assert_eq!(loan_id, 1);
}

#[test]
fn test_get_loan_after_create() {
    let (env, _admin, _cs, client) = setup();
    let borrower = Address::generate(&env);
    let loan_id = client.create_loan(&borrower, &500_000u128, &6u32);
    let loan = client.get_loan(&loan_id);
    assert_eq!(loan.borrower, borrower);
    assert_eq!(loan.amount, 500_000u128);
    assert_eq!(loan.duration_months, 6);
}

#[test]
fn test_loan_starts_as_pending() {
    let (env, _admin, _cs, client) = setup();
    let borrower = Address::generate(&env);
    let loan_id = client.create_loan(&borrower, &100_000u128, &3u32);
    let loan = client.get_loan(&loan_id);
    assert_eq!(loan.status, LoanStatus::Pending);
}

#[test]
fn test_approve_loan_sets_active() {
    let (env, admin, _cs, client) = setup();
    let borrower = Address::generate(&env);
    let loan_id = client.create_loan(&borrower, &100_000u128, &3u32);
    client.approve_loan(&admin, &loan_id);
    let loan = client.get_loan(&loan_id);
    assert_eq!(loan.status, LoanStatus::Active);
}

#[test]
fn test_repay_loan_fully() {
    let (env, admin, _cs, client) = setup();
    let borrower = Address::generate(&env);
    let loan_id = client.create_loan(&borrower, &100_000u128, &12u32);
    client.approve_loan(&admin, &loan_id);

    let loan = client.get_loan(&loan_id);
    // total_due = amount + (amount * rate * months) / (100 * 12)
    // rate = 8 for score 750; total = 100_000 + (100_000 * 8 * 12) / 1200 = 108_000
    let total_due = loan.amount + (loan.amount * loan.interest_rate as u128 * loan.duration_months as u128) / (100 * 12);

    client.repay_loan(&borrower, &loan_id, &total_due);
    let repaid = client.get_loan(&loan_id);
    assert_eq!(repaid.status, LoanStatus::Repaid);
}

#[test]
fn test_get_user_loans() {
    let (env, _admin, _cs, client) = setup();
    let borrower = Address::generate(&env);
    client.create_loan(&borrower, &100_000u128, &6u32);
    client.create_loan(&borrower, &200_000u128, &12u32);
    let loans = client.get_user_loans(&borrower);
    assert_eq!(loans.len(), 2);
}

#[test]
fn test_get_active_loans_after_approve() {
    let (env, admin, _cs, client) = setup();
    let borrower = Address::generate(&env);
    let loan_id = client.create_loan(&borrower, &100_000u128, &6u32);
    // Before approval, active list is empty
    assert_eq!(client.get_active_loans().len(), 0);
    client.approve_loan(&admin, &loan_id);
    assert_eq!(client.get_active_loans().len(), 1);
}

#[test]
fn test_can_borrow_with_good_score() {
    let (env, _admin, _cs, client) = setup();
    let user = Address::generate(&env);
    // Mock returns score 750 → max debt 7_000_000; requesting 1_000_000 should pass
    assert!(client.can_borrow(&user, &1_000_000u128));
}

#[test]
fn test_loan_statistics() {
    let (env, admin, _cs, client) = setup();
    let borrower = Address::generate(&env);
    let loan_id = client.create_loan(&borrower, &100_000u128, &6u32);
    client.approve_loan(&admin, &loan_id);
    let (total, active) = client.get_loan_statistics();
    assert_eq!(total, 1);
    assert_eq!(active, 1);
}

#[test]
fn test_interest_rate_for_score_750() {
    let (env, _admin, _cs, client) = setup();
    let borrower = Address::generate(&env);
    let loan_id = client.create_loan(&borrower, &100_000u128, &12u32);
    let loan = client.get_loan(&loan_id);
    // Score 750 → 8% interest
    assert_eq!(loan.interest_rate, 8);
}
