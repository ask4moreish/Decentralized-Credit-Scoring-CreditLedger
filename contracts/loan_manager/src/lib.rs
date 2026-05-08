use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, Address, Env, Vec, Symbol,
};

// Import CreditScoreData from the credit_score crate.
// In a workspace build the type is shared; here we redeclare the minimal shape
// needed so this crate compiles independently.
#[contracttype]
#[derive(Clone)]
pub struct CreditScoreData {
    pub score: u32,
    pub last_updated: u64,
    pub payment_history_score: u32,
    pub savings_score: u32,
    pub community_score: u32,
    pub activity_score: u32,
}

#[contractclient(name = "CreditScoreContractClient")]
pub trait CreditScoreContract {
    fn get_credit_score(&self, user: &Address) -> CreditScoreData;
}

#[contracttype]
pub enum LoanDataKey {
    Loan(u64),
    UserLoans(Address),
    ActiveLoans,
    LoanCounter,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Loan {
    pub id: u64,
    pub borrower: Address,
    pub amount: u128,
    pub interest_rate: u32,
    pub duration_months: u32,
    pub created_at: u64,
    pub due_date: u64,
    pub status: LoanStatus,
    pub collateral_required: bool,
    pub credit_score_used: u32,
    pub repaid_amount: u128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LoanStatus {
    Pending,
    Active,
    Repaid,
    Defaulted,
    Cancelled,
}

#[contract]
pub struct LoanManagerContract;

#[contractimpl]
impl LoanManagerContract {

    pub fn initialize(env: Env, admin: Address, credit_score_contract: Address) {
        if env.storage().instance().has(&LoanDataKey::LoanCounter) {
            panic!("Contract already initialized");
        }
        env.storage().instance().set(&Symbol::new(&env, "admin"), &admin);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "credit_score_contract"), &credit_score_contract);
        env.storage().instance().set(&LoanDataKey::LoanCounter, &0u64);
    }

    pub fn create_loan(env: Env, borrower: Address, amount: u128, duration_months: u32) -> u64 {
        borrower.require_auth();

        let credit_score_contract: Address = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "credit_score_contract"))
            .unwrap();

        let credit_score_data =
            CreditScoreContractClient::new(&env, &credit_score_contract)
                .get_credit_score(&borrower);

        let interest_rate = Self::calculate_interest_rate(credit_score_data.score);

        if Self::is_collateral_required(credit_score_data.score) {
            panic!("Collateral required for this credit score level");
        }

        // Increment counter first; the new loan's id equals the incremented value.
        // (Counter starts at 0, so first loan id = 1.)
        let loan_id: u64 = env
            .storage()
            .instance()
            .get(&LoanDataKey::LoanCounter)
            .unwrap_or(0u64)
            + 1;
        env.storage().instance().set(&LoanDataKey::LoanCounter, &loan_id);

        let current_time = env.ledger().timestamp();
        let due_date = current_time + (duration_months as u64 * 30 * 24 * 60 * 60);

        let loan = Loan {
            id: loan_id,
            borrower: borrower.clone(),
            amount,
            interest_rate,
            duration_months,
            created_at: current_time,
            due_date,
            status: LoanStatus::Pending,
            collateral_required: false,
            credit_score_used: credit_score_data.score,
            repaid_amount: 0,
        };

        env.storage()
            .persistent()
            .set(&LoanDataKey::Loan(loan_id), &loan);

        let mut user_loans: Vec<u64> = env
            .storage()
            .persistent()
            .get(&LoanDataKey::UserLoans(borrower.clone()))
            .unwrap_or(Vec::new(&env));
        user_loans.push_back(loan_id);
        env.storage()
            .persistent()
            .set(&LoanDataKey::UserLoans(borrower), &user_loans);

        loan_id
    }

    pub fn approve_loan(env: Env, admin: Address, loan_id: u64) {
        // Authenticate the passed-in admin address directly instead of
        // re-fetching from storage and ignoring the parameter.
        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "admin"))
            .unwrap();
        if admin != stored_admin {
            panic!("Not the contract admin");
        }

        let mut loan: Loan = env
            .storage()
            .persistent()
            .get(&LoanDataKey::Loan(loan_id))
            .unwrap_or_else(|| panic!("Loan not found"));

        if loan.status != LoanStatus::Pending {
            panic!("Loan is not pending");
        }

        loan.status = LoanStatus::Active;
        env.storage()
            .persistent()
            .set(&LoanDataKey::Loan(loan_id), &loan);

        // Only add to active list once approved, not when pending.
        let mut active_loans: Vec<u64> = env
            .storage()
            .persistent()
            .get(&LoanDataKey::ActiveLoans)
            .unwrap_or(Vec::new(&env));
        active_loans.push_back(loan_id);
        env.storage()
            .persistent()
            .set(&LoanDataKey::ActiveLoans, &active_loans);
    }

    pub fn repay_loan(env: Env, borrower: Address, loan_id: u64, amount: u128) {
        borrower.require_auth();

        let mut loan: Loan = env
            .storage()
            .persistent()
            .get(&LoanDataKey::Loan(loan_id))
            .unwrap_or_else(|| panic!("Loan not found"));

        if loan.borrower != borrower {
            panic!("Not the loan borrower");
        }
        if loan.status != LoanStatus::Active {
            panic!("Loan is not active");
        }

        let total_due = Self::calculate_total_due(&loan);
        let new_repaid = loan.repaid_amount + amount;

        if new_repaid > total_due {
            panic!("Repayment exceeds total due");
        }

        loan.repaid_amount = new_repaid;

        if new_repaid >= total_due {
            loan.status = LoanStatus::Repaid;
            Self::remove_from_active_loans(&env, loan_id);
        }

        env.storage()
            .persistent()
            .set(&LoanDataKey::Loan(loan_id), &loan);
    }

    pub fn mark_default(env: Env, admin: Address, loan_id: u64) {
        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "admin"))
            .unwrap();
        if admin != stored_admin {
            panic!("Not the contract admin");
        }

        let mut loan: Loan = env
            .storage()
            .persistent()
            .get(&LoanDataKey::Loan(loan_id))
            .unwrap_or_else(|| panic!("Loan not found"));

        if loan.status != LoanStatus::Active {
            panic!("Loan is not active");
        }
        if env.ledger().timestamp() < loan.due_date {
            panic!("Loan not yet due");
        }

        loan.status = LoanStatus::Defaulted;
        env.storage()
            .persistent()
            .set(&LoanDataKey::Loan(loan_id), &loan);

        Self::remove_from_active_loans(&env, loan_id);
    }

    pub fn can_borrow(env: Env, user: Address, amount: u128) -> bool {
        let credit_score_contract: Address = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "credit_score_contract"))
            .unwrap();

        let credit_score_data =
            CreditScoreContractClient::new(&env, &credit_score_contract)
                .get_credit_score(&user);

        if credit_score_data.score < 500 {
            return false;
        }

        let user_loans: Vec<u64> = env
            .storage()
            .persistent()
            .get(&LoanDataKey::UserLoans(user.clone()))
            .unwrap_or(Vec::new(&env));

        let mut active_count = 0u32;
        let mut total_active_debt = 0u128;

        for loan_id in user_loans.iter() {
            let loan: Loan = env
                .storage()
                .persistent()
                .get(&LoanDataKey::Loan(loan_id))
                .unwrap();

            if loan.status == LoanStatus::Active {
                active_count += 1;
                total_active_debt +=
                    Self::calculate_total_due(&loan).saturating_sub(loan.repaid_amount);
            }
        }

        if active_count >= 3 {
            return false;
        }

        // Cap is a fixed multiple of the *credit score*, not of the requested amount.
        // Using requested-amount as the multiplier base made the cap grow with the
        // request, which meant any amount was always within its own cap.
        let max_debt: u128 = match credit_score_data.score {
            800..=1000 => 10_000_000,
            700..=799 => 7_000_000,
            600..=699 => 5_000_000,
            500..=599 => 3_000_000,
            _ => 0,
        };

        total_active_debt + amount <= max_debt
    }

    pub fn get_loan(env: Env, loan_id: u64) -> Loan {
        env.storage()
            .persistent()
            .get(&LoanDataKey::Loan(loan_id))
            .unwrap_or_else(|| panic!("Loan not found"))
    }

    pub fn get_user_loans(env: Env, user: Address) -> Vec<u64> {
        env.storage()
            .persistent()
            .get(&LoanDataKey::UserLoans(user))
            .unwrap_or(Vec::new(&env))
    }

    pub fn get_active_loans(env: Env) -> Vec<u64> {
        env.storage()
            .persistent()
            .get(&LoanDataKey::ActiveLoans)
            .unwrap_or(Vec::new(&env))
    }

    pub fn get_loan_statistics(env: Env) -> (u64, u64) {
        // Returns (total_loans_ever, currently_active_loans).
        // Previously returned Map<String, u64> which required the unused Map import.
        let total: u64 = env
            .storage()
            .instance()
            .get(&LoanDataKey::LoanCounter)
            .unwrap_or(0);

        let active: u64 = env
            .storage()
            .persistent()
            .get::<_, Vec<u64>>(&LoanDataKey::ActiveLoans)
            .map(|v| v.len() as u64)
            .unwrap_or(0);

        (total, active)
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    fn calculate_interest_rate(credit_score: u32) -> u32 {
        match credit_score {
            800..=1000 => 5,
            700..=799 => 8,
            600..=699 => 12,
            500..=599 => 18,
            _ => 25,
        }
    }

    fn is_collateral_required(credit_score: u32) -> bool {
        credit_score < 600
    }

    fn calculate_total_due(loan: &Loan) -> u128 {
        let interest = (loan.amount * loan.interest_rate as u128 * loan.duration_months as u128)
            / (100 * 12);
        loan.amount + interest
    }

    fn remove_from_active_loans(env: &Env, loan_id: u64) {
        let mut active_loans: Vec<u64> = env
            .storage()
            .persistent()
            .get(&LoanDataKey::ActiveLoans)
            .unwrap_or(Vec::new(env));

        if let Some(index) = active_loans.iter().position(|id| id == loan_id) {
            active_loans.remove(index as u32);
            env.storage()
                .persistent()
                .set(&LoanDataKey::ActiveLoans, &active_loans);
        }
    }
}
