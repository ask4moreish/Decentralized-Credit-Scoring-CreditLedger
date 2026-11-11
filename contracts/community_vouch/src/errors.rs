use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum VouchError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    ContractPaused = 4,
    InvalidInput = 5,
    NoPendingAdmin = 6,
    SameAdmin = 7,
    VouchNotFound = 8,
    VouchAlreadyInactive = 9,
    VouchNotExpired = 10,
    VouchAlreadyWithdrawn = 11,
    SelfVouchNotAllowed = 12,
    DuplicateActiveVouch = 13,
    ExceedsMaxVouchAmount = 14,
    MaxActiveVouchesReached = 15,
    CooldownActive = 16,
    InvalidPageLimit = 17,
    InsufficientEscrow = 18,
    ArithmeticOverflow = 19,
}
