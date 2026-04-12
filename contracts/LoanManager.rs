use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Map, Vec, String, Symbol, U256, u64, u128, i128};

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

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepaymentSchedule {
    pub loan_id: u64,
    pub installment_amount: u128,
    pub due_dates: Vec<u64>,
    pub paid_installments: Vec<bool>,
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
        env.storage().instance().set(&Symbol::new(&env, "credit_score_contract"), &credit_score_contract);
        env.storage().instance().set(&LoanDataKey::LoanCounter, &0u64);
    }

    pub fn create_loan(
        env: Env,
        borrower: Address,
        amount: u128,
        duration_months: u32,
    ) -> u64 {
        borrower.require_auth();
        
        // Get borrower's credit score
        let credit_score_contract: Address = env.storage().instance()
            .get(&Symbol::new(&env, "credit_score_contract"))
            .unwrap();
        
        let credit_score_data = CreditScoreContractClient::new(&env, &credit_score_contract)
            .get_credit_score(&borrower);
        
        // Calculate interest rate based on credit score
        let interest_rate = Self::calculate_interest_rate(credit_score_data.score);
        let collateral_required = Self::is_collateral_required(credit_score_data.score);
        
        if collateral_required {
            panic!("Collateral required for this credit score level");
        }
        
        // Create loan
        let loan_id: u64 = env.storage().instance()
            .get(&LoanDataKey::LoanCounter)
            .unwrap();
        
        let new_loan_id = loan_id + 1;
        env.storage().instance().set(&LoanDataKey::LoanCounter, &new_loan_id);
        
        let current_time = env.ledger().timestamp();
        let due_date = current_time + (duration_months as u64 * 30 * 24 * 60 * 60); // Approximate months
        
        let loan = Loan {
            id: loan_id,
            borrower: borrower.clone(),
            amount,
            interest_rate,
            duration_months,
            created_at: current_time,
            due_date,
            status: LoanStatus::Pending,
            collateral_required,
            credit_score_used: credit_score_data.score,
            repaid_amount: 0,
        };
        
        env.storage().persistent().set(&LoanDataKey::Loan(loan_id), &loan);
        
        // Add to user's loans
        let mut user_loans: Vec<u64> = env.storage().persistent()
            .get(&LoanDataKey::UserLoans(borrower))
            .unwrap_or(Vec::new(&env));
        user_loans.push_back(loan_id);
        env.storage().persistent().set(&LoanDataKey::UserLoans(borrower), &user_loans);
        
        // Add to active loans
        let mut active_loans: Vec<u64> = env.storage().persistent()
            .get(&LoanDataKey::ActiveLoans)
            .unwrap_or(Vec::new(&env));
        active_loans.push_back(loan_id);
        env.storage().persistent().set(&LoanDataKey::ActiveLoans, &active_loans);
        
        loan_id
    }

    pub fn approve_loan(env: Env, admin: Address, loan_id: u64) {
        let admin_address: Address = env.storage().instance()
            .get(&Symbol::new(&env, "admin"))
            .unwrap();
        
        admin_address.require_auth();
        
        let mut loan: Loan = env.storage().persistent()
            .get(&LoanDataKey::Loan(loan_id))
            .unwrap_or_else(|| panic!("Loan not found"));
        
        if loan.status != LoanStatus::Pending {
            panic!("Loan is not pending");
        }
        
        loan.status = LoanStatus::Active;
        env.storage().persistent().set(&LoanDataKey::Loan(loan_id), &loan);
    }

    pub fn repay_loan(env: Env, borrower: Address, loan_id: u64, amount: u128) {
        borrower.require_auth();
        
        let mut loan: Loan = env.storage().persistent()
            .get(&LoanDataKey::Loan(loan_id))
            .unwrap_or_else(|| panic!("Loan not found"));
        
        if loan.borrower != borrower {
            panic!("Not the loan borrower");
        }
        
        if loan.status != LoanStatus::Active {
            panic!("Loan is not active");
        }
        
        let total_due = Self::calculate_total_due(&loan);
        let new_repaid_amount = loan.repaid_amount + amount;
        
        if new_repaid_amount > total_due {
            panic!("Repayment exceeds total due");
        }
        
        loan.repaid_amount = new_repaid_amount;
        
        if new_repaid_amount >= total_due {
            loan.status = LoanStatus::Repaid;
            
            // Remove from active loans
            let mut active_loans: Vec<u64> = env.storage().persistent()
                .get(&LoanDataKey::ActiveLoans)
                .unwrap_or(Vec::new(&env));
            
            let index = active_loans.iter().position(|&id| id == loan_id).unwrap();
            active_loans.remove(index as u32);
            env.storage().persistent().set(&LoanDataKey::ActiveLoans, &active_loans);
        }
        
        env.storage().persistent().set(&LoanDataKey::Loan(loan_id), &loan);
    }

    pub fn mark_default(env: Env, admin: Address, loan_id: u64) {
        let admin_address: Address = env.storage().instance()
            .get(&Symbol::new(&env, "admin"))
            .unwrap();
        
        admin_address.require_auth();
        
        let mut loan: Loan = env.storage().persistent()
            .get(&LoanDataKey::Loan(loan_id))
            .unwrap_or_else(|| panic!("Loan not found"));
        
        if loan.status != LoanStatus::Active {
            panic!("Loan is not active");
        }
        
        if env.ledger().timestamp() < loan.due_date {
            panic!("Loan not yet due");
        }
        
        loan.status = LoanStatus::Defaulted;
        env.storage().persistent().set(&LoanDataKey::Loan(loan_id), &loan);
        
        // Remove from active loans
        let mut active_loans: Vec<u64> = env.storage().persistent()
            .get(&LoanDataKey::ActiveLoans)
            .unwrap_or(Vec::new(&env));
        
        let index = active_loans.iter().position(|&id| id == loan_id).unwrap();
        active_loans.remove(index as u32);
        env.storage().persistent().set(&LoanDataKey::ActiveLoans, &active_loans);
    }

    fn calculate_interest_rate(credit_score: u32) -> u32 {
        match credit_score {
            800..=1000 => 5,   // Excellent: 5%
            700..=799 => 8,    // Good: 8%
            600..=699 => 12,   // Fair: 12%
            500..=599 => 18,   // Poor: 18%
            _ => 25,           // Very Poor: 25%
        }
    }

    fn is_collateral_required(credit_score: u32) -> bool {
        credit_score < 600
    }

    fn calculate_total_due(loan: &Loan) -> u128 {
        let interest = (loan.amount * loan.interest_rate as u128 * loan.duration_months as u128) / (100 * 12);
        loan.amount + interest
    }

    pub fn get_loan(env: Env, loan_id: u64) -> Loan {
        env.storage().persistent()
            .get(&LoanDataKey::Loan(loan_id))
            .unwrap_or_else(|| panic!("Loan not found"))
    }

    pub fn get_user_loans(env: Env, user: Address) -> Vec<u64> {
        env.storage().persistent()
            .get(&LoanDataKey::UserLoans(user))
            .unwrap_or(Vec::new(&env))
    }

    pub fn get_active_loans(env: Env) -> Vec<u64> {
        env.storage().persistent()
            .get(&LoanDataKey::ActiveLoans)
            .unwrap_or(Vec::new(&env))
    }

    pub fn can_borrow(env: Env, user: Address, amount: u128) -> bool {
        let credit_score_contract: Address = env.storage().instance()
            .get(&Symbol::new(&env, "credit_score_contract"))
            .unwrap();
        
        let credit_score_data = CreditScoreContractClient::new(&env, &credit_score_contract)
            .get_credit_score(&user);
        
        // Check minimum credit score
        if credit_score_data.score < 500 {
            return false;
        }
        
        // Check existing active loans
        let user_loans: Vec<u64> = env.storage().persistent()
            .get(&LoanDataKey::UserLoans(user.clone()))
            .unwrap_or(Vec::new(&env));
        
        let mut active_loan_count = 0;
        let mut total_active_debt = 0u128;
        
        for loan_id in user_loans.iter() {
            let loan: Loan = env.storage().persistent()
                .get(&LoanDataKey::Loan(*loan_id))
                .unwrap();
            
            if loan.status == LoanStatus::Active {
                active_loan_count += 1;
                total_active_debt += Self::calculate_total_due(&loan) - loan.repaid_amount;
            }
        }
        
        // Maximum 3 active loans
        if active_loan_count >= 3 {
            return false;
        }
        
        // Maximum debt based on credit score
        let max_debt = match credit_score_data.score {
            800..=1000 => amount * 10,
            700..=799 => amount * 7,
            600..=699 => amount * 5,
            500..=599 => amount * 3,
            _ => amount,
        };
        
        total_active_debt + amount <= max_debt
    }

    pub fn get_loan_statistics(env: Env) -> Map<String, u64> {
        let mut stats = Map::new(&env);
        
        let active_loans: Vec<u64> = env.storage().persistent()
            .get(&LoanDataKey::ActiveLoans)
            .unwrap_or(Vec::new(&env));
        
        stats.set(String::from_str(&env, "active_loans"), active_loans.len() as u64);
        
        let loan_counter: u64 = env.storage().instance()
            .get(&LoanDataKey::LoanCounter)
            .unwrap_or(0);
        stats.set(String::from_str(&env, "total_loans"), loan_counter);
        
        stats
    }
}

// Client for interacting with CreditScore contract
#[contractclient(name = "CreditScoreContractClient")]
pub trait CreditScoreContract {
    fn get_credit_score(env: &Env, user: &Address) -> super::CreditScoreData;
}
