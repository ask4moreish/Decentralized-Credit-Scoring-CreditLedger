#![cfg(test)]

use soroban_sdk::{
    contract, contractimpl,
    testutils::{storage::Persistent as _, Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, IntoVal, Symbol,
};

use crate::{
    CreditScoreData, LoanManagerContract, LoanManagerContractClient, LoanManagerError, LoanStatus,
};

#[contract]
pub struct MockCreditScore;

#[contractimpl]
impl MockCreditScore {
    pub fn set_score(env: Env, user: Address, score: u32) {
        env.storage()
            .instance()
            .set(&(Symbol::new(&env, "s"), user), &score);
    }

    pub fn get_credit_score(env: Env, user: Address) -> CreditScoreData {
        let score: u32 = env
            .storage()
            .instance()
            .get(&(Symbol::new(&env, "s"), user))
            .unwrap_or(75);
        CreditScoreData {
            score,
            last_updated: 0,
            payment_history_score: score,
            savings_score: score,
            community_score: 0,
            activity_score: score,
        }
    }

    pub fn record_loan_outcome(env: Env, borrower: Address, on_time: bool, defaulted: bool) {
        env.storage()
            .instance()
            .set(&(Symbol::new(&env, "out"), borrower), &(on_time, defaulted));
    }

    pub fn get_outcome(env: Env, borrower: Address) -> Option<(bool, bool)> {
        env.storage()
            .instance()
            .get(&(Symbol::new(&env, "out"), borrower))
    }
}

#[contract]
pub struct MockCommunityVouch;

#[contractimpl]
impl MockCommunityVouch {
    pub fn slash_vouches_on_default(env: Env, borrower: Address, uncovered_loss: u128) -> u128 {
        let slash = (uncovered_loss / 2).min(200_000);
        let token_addr: Address = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "tok"))
            .unwrap();
        let pool_addr: Address = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "pool"))
            .unwrap();
        if slash > 0 {
            TokenClient::new(&env, &token_addr).transfer(
                &env.current_contract_address(),
                &pool_addr,
                &(slash as i128),
            );
        }
        env.storage()
            .instance()
            .set(&(Symbol::new(&env, "slashed"), borrower), &slash);
        slash
    }

    pub fn configure(env: Env, tok: Address, pool: Address) {
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "tok"), &tok);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "pool"), &pool);
    }
}

struct TestCtx<'a> {
    env: Env,
    admin: Address,
    cs_id: Address,
    loan_token: TokenClient<'a>,
    loan_sac: StellarAssetClient<'a>,
    col_token: TokenClient<'a>,
    col_sac: StellarAssetClient<'a>,
    client: LoanManagerContractClient<'a>,
}

fn setup(same_asset_collateral: bool) -> TestCtx<'static> {
    let env = Env::default();
    env.ledger().with_mut(|li| {
        li.timestamp = 1_750_000_000;
        li.sequence_number = 10_000;
    });
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let loan_tok_id = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let col_tok_id = if same_asset_collateral {
        loan_tok_id.clone()
    } else {
        env.register_stellar_asset_contract_v2(token_admin)
            .address()
    };

    let loan_token = TokenClient::new(&env, &loan_tok_id);
    let loan_sac = StellarAssetClient::new(&env, &loan_tok_id);
    let col_token = TokenClient::new(&env, &col_tok_id);
    let col_sac = StellarAssetClient::new(&env, &col_tok_id);

    let cs_id = env.register(MockCreditScore, ());
    let lm_id = env.register(LoanManagerContract, ());
    let client = LoanManagerContractClient::new(&env, &lm_id);

    client.initialize(&admin, &cs_id, &loan_tok_id, &col_tok_id);

    TestCtx {
        env,
        admin,
        cs_id,
        loan_token,
        loan_sac,
        col_token,
        col_sac,
        client,
    }
}

#[test]
fn test_initialize_requires_auth_and_single_run_and_admin_handover() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let admin2 = Address::generate(&env);
    let cs_id = env.register(MockCreditScore, ());
    let tok = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let lm_id = env.register(LoanManagerContract, ());
    let client = LoanManagerContractClient::new(&env, &lm_id);

    assert!(client.try_initialize(&admin, &cs_id, &tok, &tok).is_err());

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &lm_id,
            fn_name: "initialize",
            args: (&admin, &cs_id, &tok, &tok).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.initialize(&admin, &cs_id, &tok, &tok);
    assert_eq!(client.get_admin(), admin);

    env.mock_all_auths();
    assert_eq!(
        client.try_initialize(&admin2, &cs_id, &tok, &tok),
        Err(Ok(LoanManagerError::AlreadyInitialized))
    );

    client.propose_admin(&admin2);
    assert_eq!(client.get_pending_admin(), Some(admin2.clone()));
    client.accept_admin();
    assert_eq!(client.get_admin(), admin2);
    assert_eq!(client.get_pending_admin(), None);
}

#[test]
fn test_lender_liquidity_pool_lock_disbursement_and_repayment_interest_yield() {
    let ctx = setup(true);
    let lender = Address::generate(&ctx.env);
    let borrower = Address::generate(&ctx.env);

    ctx.loan_sac.mint(&lender, &1_000_000i128);
    ctx.client.deposit_liquidity(&lender, &1_000_000u128);
    assert_eq!(ctx.loan_token.balance(&ctx.client.address), 1_000_000);
    assert_eq!(ctx.client.get_lender_balance(&lender), 1_000_000);

    // Borrower has score 80 -> 8% APR unsecured
    MockCreditScoreClient::new(&ctx.env, &ctx.cs_id).set_score(&borrower, &80u32);
    let loan_id = ctx
        .client
        .create_loan(&borrower, &600_000u128, &12u32, &0u128);
    assert_eq!(ctx.client.get_loan(&loan_id).interest_rate, 8);

    // Atomic disbursement moves 600_000 real tokens to borrower
    ctx.client.approve_loan(&ctx.admin, &loan_id);
    assert_eq!(ctx.loan_token.balance(&borrower), 600_000);
    assert_eq!(ctx.loan_token.balance(&ctx.client.address), 400_000);

    let pool_active = ctx.client.get_pool_state();
    assert_eq!(pool_active.available_cash, 400_000);
    assert_eq!(pool_active.outstanding_principal, 600_000);

    // Lender cannot withdraw cash committed to active loan (500_000 > 400_000)
    assert_eq!(
        ctx.client.try_withdraw_liquidity(&lender, &500_000u128),
        Err(Ok(LoanManagerError::InsufficientAvailableLiquidity))
    );

    // Partial repayment + final repayment (600_000 + 8% * 12/12 = 648_000 total due)
    ctx.loan_sac.mint(&borrower, &48_000i128);
    ctx.client.repay_loan(&borrower, &loan_id, &100_000u128);
    let mid = ctx.client.get_loan(&loan_id);
    assert_eq!(mid.status, LoanStatus::Active);
    // Interest (48_000) paid first, then 52_000 principal
    assert_eq!(mid.interest_repaid, 48_000);
    assert_eq!(mid.principal_repaid, 52_000);

    // Overpayment rejected
    assert_eq!(
        ctx.client.try_repay_loan(&borrower, &loan_id, &600_000u128),
        Err(Ok(LoanManagerError::RepaymentExceedsDue))
    );

    // Remaining 548_000 finishes repayment and updates borrower loan outcome
    ctx.client.repay_loan(&borrower, &loan_id, &548_000u128);
    let done = ctx.client.get_loan(&loan_id);
    assert_eq!(done.status, LoanStatus::Repaid);
    assert_eq!(
        MockCreditScoreClient::new(&ctx.env, &ctx.cs_id).get_outcome(&borrower),
        Some((true, false))
    );

    // Lender now earns full principal + 48_000 interest yield
    assert_eq!(ctx.client.get_lender_balance(&lender), 1_048_000);
    ctx.client.withdraw_liquidity(&lender, &1_048_000u128);
    assert_eq!(ctx.loan_token.balance(&lender), 1_048_000);
    assert_eq!(ctx.loan_token.balance(&ctx.client.address), 0);
}

#[test]
fn test_collateralized_base_tier_ltv_enforcement_lock_and_release() {
    // Separate collateral asset vs loan asset so reserves stay cleanly separated
    let ctx = setup(false);
    let lender = Address::generate(&ctx.env);
    let borrower = Address::generate(&ctx.env);

    ctx.loan_sac.mint(&lender, &1_000_000i128);
    ctx.client.deposit_liquidity(&lender, &1_000_000u128);

    // Borrower score 55 (< 60 -> collateral required @ MAX_LTV_BPS=80% => >=125% = 500_000 collateral for 400_000 loan)
    MockCreditScoreClient::new(&ctx.env, &ctx.cs_id).set_score(&borrower, &55u32);
    let req_col = ctx.client.get_required_collateral(&borrower, &400_000u128);
    assert_eq!(req_col, 500_000);

    ctx.col_sac.mint(&borrower, &600_000i128);

    // Under-collateralized attempt rejected
    assert_eq!(
        ctx.client
            .try_create_loan(&borrower, &400_000u128, &6u32, &499_999u128),
        Err(Ok(LoanManagerError::InsufficientCollateral))
    );

    // Valid collateralized application locks 500_000 collateral token cleanly
    let loan_id = ctx
        .client
        .create_loan(&borrower, &400_000u128, &6u32, &500_000u128);
    assert_eq!(ctx.col_token.balance(&borrower), 100_000);
    assert_eq!(ctx.col_token.balance(&ctx.client.address), 500_000);
    assert_eq!(ctx.client.get_loan(&loan_id).interest_rate, 15);
    assert!(ctx.client.get_loan(&loan_id).collateral_required);

    ctx.client.approve_loan(&ctx.admin, &loan_id);
    assert_eq!(ctx.loan_token.balance(&borrower), 400_000);

    // 400_000 * 15% * 6/12 = 30_000 interest -> 430_000 total
    ctx.loan_sac.mint(&borrower, &30_000i128);
    ctx.client.repay_loan(&borrower, &loan_id, &430_000u128);

    // Collateral fully unlocked & returned to borrower!
    assert_eq!(ctx.col_token.balance(&borrower), 600_000);
    assert_eq!(ctx.col_token.balance(&ctx.client.address), 0);
    assert!(!ctx.client.get_loan(&loan_id).collateral_locked);
}

#[test]
fn test_late_fee_default_liquidation_with_surplus_refund_and_vouch_slash() {
    let ctx = setup(true);
    let lender = Address::generate(&ctx.env);
    let borrower = Address::generate(&ctx.env);

    // Set up MockCommunityVouch holding 400_000 voucher escrow tokens
    let cv_id = ctx.env.register(MockCommunityVouch, ());
    MockCommunityVouchClient::new(&ctx.env, &cv_id)
        .configure(&ctx.loan_token.address, &ctx.client.address);
    ctx.loan_sac.mint(&cv_id, &400_000i128);
    ctx.client.set_community_vouch_contract(&cv_id);

    ctx.loan_sac.mint(&lender, &1_000_000i128);
    ctx.client.deposit_liquidity(&lender, &1_000_000u128);

    MockCreditScoreClient::new(&ctx.env, &ctx.cs_id).set_score(&borrower, &55u32);
    // Borrower deposits 600_000 collateral for 400_000 loan (extra surplus above required 500_000)
    ctx.loan_sac.mint(&borrower, &600_000i128);
    let loan_id = ctx
        .client
        .create_loan(&borrower, &400_000u128, &6u32, &600_000u128);
    ctx.client.approve_loan(&ctx.admin, &loan_id);

    // Cannot mark default before due_date
    assert_eq!(
        ctx.client.try_mark_default(&ctx.admin, &loan_id),
        Err(Ok(LoanManagerError::LoanNotYetDue))
    );

    // Advance past due_date + 10 days (grace period passed -> late fee accrues!)
    let due = ctx.client.get_loan(&loan_id).due_date;
    ctx.env.ledger().with_mut(|li| {
        li.timestamp = due + 10 * 86_400;
        li.sequence_number += 1_000;
    });

    let sched = ctx.client.get_repayment_schedule(&loan_id);
    assert!(sched.is_overdue);
    assert!(sched.late_fee_accrued > 0);
    // Debt owed = 400_000 + 30_000 + 8_000 (2% of 400k) = 438_000; +5% cap = 459_900 seized, 140_100 surplus returned!
    ctx.client.mark_default(&ctx.admin, &loan_id);
    let def = ctx.client.get_loan(&loan_id);
    assert_eq!(def.status, LoanStatus::Defaulted);
    assert!(!def.collateral_locked);

    // Surplus refunded fairly to borrower (400_000 principal disbursed + 140_100 surplus returned = 540_100)
    assert_eq!(ctx.loan_token.balance(&borrower), 540_100);
    // Pool recovered collateral directly into available_cash
    let pool = ctx.client.get_pool_state();
    assert!(pool.available_cash >= 1_059_900);
    assert_eq!(
        MockCreditScoreClient::new(&ctx.env, &ctx.cs_id).get_outcome(&borrower),
        Some((false, true))
    );

    // Simulate long inactivity before invoking keeper TTL maintenance
    ctx.env.ledger().with_mut(|li| {
        li.sequence_number += 2_100_000;
    });
    ctx.client.extend_loan_ttl(&loan_id);
    ctx.env.as_contract(&ctx.client.address, || {
        let ttl = ctx
            .env
            .storage()
            .persistent()
            .get_ttl(&crate::LoanDataKey::Loan(loan_id));
        assert!(ttl >= 2_500_000);
    });
}

#[test]
fn test_pause_cancel_collateral_refund_limits_and_pagination() {
    let ctx = setup(false);
    let lender = Address::generate(&ctx.env);
    let borrower = Address::generate(&ctx.env);
    let low_user = Address::generate(&ctx.env);

    ctx.loan_sac.mint(&lender, &500_000i128);
    ctx.client.deposit_liquidity(&lender, &500_000u128);

    // Low score (<50) cannot borrow
    MockCreditScoreClient::new(&ctx.env, &ctx.cs_id).set_score(&low_user, &45u32);
    assert!(!ctx.client.can_borrow(&low_user, &10_000u128));
    assert_eq!(
        ctx.client
            .try_create_loan(&low_user, &10_000u128, &6u32, &0u128),
        Err(Ok(LoanManagerError::InsufficientCreditScore))
    );

    // Pause blocks loan creation until unpaused
    ctx.client.pause();
    MockCreditScoreClient::new(&ctx.env, &ctx.cs_id).set_score(&borrower, &85u32);
    assert_eq!(
        ctx.client
            .try_create_loan(&borrower, &100_000u128, &6u32, &0u128),
        Err(Ok(LoanManagerError::ContractPaused))
    );
    ctx.client.unpause();

    // Collateralized pending loan canceled cleanly refunds collateral
    MockCreditScoreClient::new(&ctx.env, &ctx.cs_id).set_score(&borrower, &55u32);
    ctx.col_sac.mint(&borrower, &300_000i128);
    let cancel_id = ctx
        .client
        .create_loan(&borrower, &200_000u128, &6u32, &250_000u128);
    assert_eq!(ctx.col_token.balance(&borrower), 50_000);
    ctx.client.cancel_loan(&borrower, &cancel_id);
    assert_eq!(ctx.col_token.balance(&borrower), 300_000);
    assert_eq!(
        ctx.client.get_loan(&cancel_id).status,
        LoanStatus::Cancelled
    );

    // Exceeding pool liquidity on approve_loan fails cleanly
    MockCreditScoreClient::new(&ctx.env, &ctx.cs_id).set_score(&borrower, &85u32);
    let big_id = ctx
        .client
        .create_loan(&borrower, &800_000u128, &12u32, &0u128);
    assert_eq!(
        ctx.client.try_approve_loan(&ctx.admin, &big_id),
        Err(Ok(LoanManagerError::InsufficientPoolLiquidity))
    );

    // Pagination page checks + invalid limit 0 check
    let id1 = ctx
        .client
        .create_loan(&borrower, &100_000u128, &6u32, &0u128);
    let id2 = ctx
        .client
        .create_loan(&borrower, &100_000u128, &6u32, &0u128);
    ctx.client.approve_loan(&ctx.admin, &id1);
    ctx.client.approve_loan(&ctx.admin, &id2);

    assert_eq!(
        ctx.client.try_get_active_loans_page(&0, &0),
        Err(Ok(LoanManagerError::InvalidPageLimit))
    );
    let p1 = ctx.client.get_user_loans_page(&borrower, &0, &2);
    let p2 = ctx.client.get_user_loans_page(&borrower, &2, &2);
    assert_eq!(p1.len(), 2);
    assert_eq!(p2.len(), 2);
    assert_eq!(ctx.client.get_active_loans().len(), 2);
    assert_eq!(ctx.client.get_loan_statistics(), (4, 2));
}

#[test]
fn test_stroop_scale_real_asset_limits_prime_tier() {
    let ctx = setup(false);
    let lender = Address::generate(&ctx.env);
    let borrower = Address::generate(&ctx.env);

    // 500 XLM = 5_000_000_000 stroops (7 decimals)
    ctx.loan_sac.mint(&lender, &5_000_000_000i128);
    ctx.client.deposit_liquidity(&lender, &5_000_000_000u128);

    MockCreditScoreClient::new(&ctx.env, &ctx.cs_id).set_score(&borrower, &85u32);
    assert!(ctx.client.can_borrow(&borrower, &1_000_000_000u128));

    // Borrow 100 XLM (1_000_000_000 stroops) uncollateralized in Prime tier (score >= 80)
    let loan_id = ctx
        .client
        .create_loan(&borrower, &1_000_000_000u128, &12u32, &0u128);
    ctx.client.approve_loan(&ctx.admin, &loan_id);
    assert_eq!(ctx.loan_token.balance(&borrower), 1_000_000_000);

    // Total due = 100 XLM + 8% = 108 XLM (1_080_000_000 stroops)
    ctx.loan_sac.mint(&borrower, &80_000_000i128);
    ctx.client
        .repay_loan(&borrower, &loan_id, &1_080_000_000u128);
    assert_eq!(ctx.client.get_loan(&loan_id).status, LoanStatus::Repaid);
    assert_eq!(ctx.client.get_lender_balance(&lender), 5_080_000_000);
}
