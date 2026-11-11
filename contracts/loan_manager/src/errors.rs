use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum LoanManagerError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    ContractPaused = 4,
    InvalidInput = 5,
    NoPendingAdmin = 6,
    SameAdmin = 7,
    LoanNotFound = 8,
    InvalidLoanStatus = 9,
    InsufficientCreditScore = 10,
    InsufficientCollateral = 11,
    InsufficientPoolLiquidity = 12,
    InsufficientAvailableLiquidity = 13,
    InsufficientLenderBalance = 14,
    RepaymentExceedsDue = 15,
    LoanNotYetDue = 16,
    TooManyActiveLoans = 17,
    ExceedsTierLimit = 18,
    CollateralNotLocked = 19,
    InvalidPageLimit = 20,
    ZeroDeposit = 21,
    ArithmeticOverflow = 22,
}
