use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum CreditScoreError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    ContractPaused = 4,
    InvalidInput = 5,
    InvalidScoreRange = 6,
    InvalidTimestamp = 7,
    NoPendingAdmin = 8,
    SameAdmin = 9,
    IssuerNotAuthorized = 10,
    IssuerAlreadyExists = 11,
    DuplicateAttestation = 12,
    AttestationNotFound = 13,
    AttestationRevoked = 14,
    AttestationExpired = 15,
    InvalidSignature = 16,
    BatchTooLarge = 17,
    InvalidPageLimit = 18,
    ArithmeticOverflow = 19,
}
