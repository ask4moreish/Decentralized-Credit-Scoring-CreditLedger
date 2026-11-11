#![cfg(test)]

use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::{
    testutils::{storage::Persistent as _, Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    Address, BytesN, Env, IntoVal, String, Vec,
};

use crate::{
    AttestationInput, CreditScoreContract, CreditScoreContractClient, CreditScoreError,
    SelfReportInput, ATTESTATION_KIND_PAYMENT, ATTESTATION_KIND_SAVINGS, MAX_BATCH_SIZE,
    SCORING_MODEL_VERSION,
};

fn test_signing_key(seed: u8) -> (SigningKey, BytesN<32>) {
    let sk = SigningKey::from_bytes(&[seed; 32]);
    let pk = BytesN::from_array(&Env::default(), &sk.verifying_key().to_bytes());
    (sk, pk)
}

fn setup() -> (Env, Address, CreditScoreContractClient<'static>) {
    let env = Env::default();
    env.ledger().with_mut(|li| {
        li.timestamp = 1_750_000_000;
        li.sequence_number = 10_000;
    });
    env.mock_all_auths();
    let contract_id = env.register(CreditScoreContract, ());
    let client = CreditScoreContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    (env, admin, client)
}

fn b32(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

#[test]
fn test_initialize_requires_admin_auth_and_single_run() {
    let env = Env::default();
    let contract_id = env.register(CreditScoreContract, ());
    let client = CreditScoreContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let attacker = Address::generate(&env);

    // Without auth, initialize must fail (unauthorized seizure prevented)
    let no_auth = client.try_initialize(&admin);
    assert!(no_auth.is_err());

    // Wrong signer mocking for attacker does not satisfy admin.require_auth()
    env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "initialize",
            args: (&admin,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    let wrong_signer = client.try_initialize(&admin);
    assert!(wrong_signer.is_err());

    // Genuine admin auth succeeds once
    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "initialize",
            args: (&admin,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.initialize(&admin);
    assert_eq!(client.get_admin(), admin);

    // Second initialization is rejected with AlreadyInitialized (#1)
    env.mock_all_auths();
    let reinit = client.try_initialize(&attacker);
    assert_eq!(reinit, Err(Ok(CreditScoreError::AlreadyInitialized)));
    assert_eq!(client.get_admin(), admin);
}

#[test]
fn test_two_step_admin_handover_and_old_admin_revocation() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(CreditScoreContract, ());
    let client = CreditScoreContractClient::new(&env, &contract_id);
    let admin1 = Address::generate(&env);
    let admin2 = Address::generate(&env);
    let attacker = Address::generate(&env);
    client.initialize(&admin1);

    // Proposing same admin or accepting before proposing fails
    assert_eq!(
        client.try_propose_admin(&admin1),
        Err(Ok(CreditScoreError::SameAdmin))
    );
    assert_eq!(
        client.try_accept_admin(),
        Err(Ok(CreditScoreError::NoPendingAdmin))
    );

    // Step 1: admin1 proposes admin2
    client.propose_admin(&admin2);
    assert_eq!(client.get_pending_admin(), Some(admin2.clone()));
    assert_eq!(client.get_admin(), admin1);

    // Unauthorized caller cannot steal accept_admin
    env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "accept_admin",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(client.try_accept_admin().is_err());

    // Step 2: admin2 explicitly accepts
    env.mock_auths(&[MockAuth {
        address: &admin2,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "accept_admin",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.accept_admin();
    assert_eq!(client.get_admin(), admin2);
    assert_eq!(client.get_pending_admin(), None);

    // Old admin1 has lost privileges cleanly
    env.mock_auths(&[MockAuth {
        address: &admin1,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "pause",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(client.try_pause().is_err());
}

#[test]
fn test_pause_blocks_mutations_until_unpaused() {
    let (env, _admin, client) = setup();
    let issuer = Address::generate(&env);
    let (_sk, pk) = test_signing_key(7);

    client.pause();
    assert!(client.is_paused());

    let res = client.try_register_issuer(
        &issuer,
        &BytesN::from_array(&env, &pk.to_array()),
        &1u32,
        &String::from_str(&env, "M-Pesa Partner"),
        &String::from_str(&env, "https://issuer.example"),
    );
    assert_eq!(res, Err(Ok(CreditScoreError::ContractPaused)));

    client.unpause();
    assert!(!client.is_paused());
    client.register_issuer(
        &issuer,
        &BytesN::from_array(&env, &pk.to_array()),
        &1u32,
        &String::from_str(&env, "M-Pesa Partner"),
        &String::from_str(&env, "https://issuer.example"),
    );
    assert!(client.is_issuer_authorized(&issuer));
}

#[test]
fn test_self_reported_records_never_inflate_credit_score() {
    let (env, _admin, client) = setup();
    let user = Address::generate(&env);
    let now = env.ledger().timestamp();

    // Self-report payment & savings records with max claimed scores
    client.submit_self_reported_record(
        &user,
        &SelfReportInput {
            kind: ATTESTATION_KIND_PAYMENT,
            record_commitment: b32(&env, 11),
            claimed_amount: 1_000_000u128,
            claimed_metric: 100u32,
            duration_months: 0u32,
            timestamp: now,
        },
    );
    client.submit_self_reported_record(
        &user,
        &SelfReportInput {
            kind: ATTESTATION_KIND_SAVINGS,
            record_commitment: b32(&env, 12),
            claimed_amount: 5_000_000u128,
            claimed_metric: 100u32,
            duration_months: 24u32,
            timestamp: now,
        },
    );

    let breakdown = client.get_score_breakdown(&user);
    assert_eq!(breakdown.score, 0);
    assert_eq!(breakdown.payment_history_score, 0);
    assert_eq!(breakdown.savings_score, 0);
    assert_eq!(breakdown.self_reported_count, 2);
    assert_eq!(breakdown.verified_payment_count, 0);
    assert_eq!(breakdown.verified_savings_count, 0);
    assert!(!client.is_creditworthy(&user, &1));
}

#[test]
fn test_signed_attestation_ed25519_verification_replay_and_tamper_resistance() {
    let (env, _admin, client) = setup();
    let issuer = Address::generate(&env);
    let borrower = Address::generate(&env);
    let other_user = Address::generate(&env);
    let now = env.ledger().timestamp();

    let (sk, pk_raw) = test_signing_key(42);
    let pk = BytesN::from_array(&env, &pk_raw.to_array());

    client.register_issuer(
        &issuer,
        &pk,
        &2u32,
        &String::from_str(&env, "Trusted Mobile Money"),
        &String::from_str(&env, "https://momo.example"),
    );

    let input = AttestationInput {
        attestation_id: b32(&env, 0xAA),
        subject: borrower.clone(),
        kind: ATTESTATION_KIND_PAYMENT,
        record_commitment: b32(&env, 0xBB),
        metric_score: 92,
        amount_units: 250_000,
        duration_months: 0,
        issued_at: now - 3600,
        expires_at: now + 30 * 86_400,
    };

    let msg = client.build_attestation_message(&issuer, &input);
    let mut msg_buf = [0u8; 512];
    let msg_len = msg.len() as usize;
    msg.copy_into_slice(&mut msg_buf[..msg_len]);
    let sig_bytes = sk.sign(&msg_buf[..msg_len]).to_bytes();
    let signature = BytesN::from_array(&env, &sig_bytes);

    // Tampered metric score fails ed25519_verify
    let mut tampered = input.clone();
    tampered.metric_score = 100;
    assert!(client
        .try_submit_signed_attestation(&borrower, &issuer, &tampered, &signature)
        .is_err());

    // Wrong subject fails unauthorized
    assert_eq!(
        client.try_submit_signed_attestation(&other_user, &issuer, &input, &signature),
        Err(Ok(CreditScoreError::Unauthorized))
    );

    // Valid signature succeeds and updates score
    client.submit_signed_attestation(&borrower, &issuer, &input, &signature);
    let breakdown = client.get_score_breakdown(&borrower);
    assert_eq!(breakdown.verified_payment_count, 1);
    assert_eq!(breakdown.payment_history_score, 92);
    assert!(breakdown.score > 0);
    assert_eq!(breakdown.model_version, SCORING_MODEL_VERSION);

    // Duplicate/replay with same attestation_id is rejected
    assert_eq!(
        client.try_submit_signed_attestation(&borrower, &issuer, &input, &signature),
        Err(Ok(CreditScoreError::DuplicateAttestation))
    );
}

#[test]
fn test_issuer_rotation_preserves_old_valid_attestations_while_blocking_old_key() {
    let (env, _admin, client) = setup();
    let issuer1 = Address::generate(&env);
    let issuer2 = Address::generate(&env);
    let borrower = Address::generate(&env);
    let now = env.ledger().timestamp();

    let (_sk1, pk1_raw) = test_signing_key(1);
    let (_sk2, pk2_raw) = test_signing_key(2);
    client.register_issuer(
        &issuer1,
        &BytesN::from_array(&env, &pk1_raw.to_array()),
        &1u32,
        &String::from_str(&env, "Bank One"),
        &String::from_str(&env, "https://bank1.example"),
    );

    let pay_input = AttestationInput {
        attestation_id: b32(&env, 0x10),
        subject: borrower.clone(),
        kind: ATTESTATION_KIND_PAYMENT,
        record_commitment: b32(&env, 0x20),
        metric_score: 90,
        amount_units: 100_000,
        duration_months: 0,
        issued_at: now - 100,
        expires_at: now + 90 * 86_400,
    };
    client.submit_attestation(&issuer1, &pay_input);

    client.rotate_issuer_key(
        &issuer1,
        &issuer2,
        &BytesN::from_array(&env, &pk2_raw.to_array()),
    );
    assert!(!client.is_issuer_authorized(&issuer1));
    assert!(client.is_issuer_authorized(&issuer2));

    // Old issuer key can no longer submit new attestations
    let blocked_input = AttestationInput {
        attestation_id: b32(&env, 0x11),
        subject: borrower.clone(),
        kind: ATTESTATION_KIND_SAVINGS,
        record_commitment: b32(&env, 0x21),
        metric_score: 90,
        amount_units: 200_000,
        duration_months: 12,
        issued_at: now,
        expires_at: now + 90 * 86_400,
    };
    assert_eq!(
        client.try_submit_attestation(&issuer1, &blocked_input),
        Err(Ok(CreditScoreError::IssuerNotAuthorized))
    );

    // Rotated issuer2 can submit new savings attestation, while prior attestation1 remains trusted
    client.submit_attestation(&issuer2, &blocked_input);
    let bd = client.get_score_breakdown(&borrower);
    assert_eq!(bd.verified_payment_count, 1);
    assert_eq!(bd.verified_savings_count, 1);
    assert!(bd.score >= 60);
}

#[test]
fn test_issuer_revocation_and_attestation_expiry_and_loan_defaults() {
    let (env, _admin, client) = setup();
    let issuer = Address::generate(&env);
    let loan_manager = Address::generate(&env);
    let borrower = Address::generate(&env);
    let now = env.ledger().timestamp();

    let (_sk, pk_raw) = test_signing_key(5);
    client.register_issuer(
        &issuer,
        &BytesN::from_array(&env, &pk_raw.to_array()),
        &1u32,
        &String::from_str(&env, "Credit Bureau"),
        &String::from_str(&env, "https://bureau.example"),
    );
    client.set_loan_manager_contract(&loan_manager);

    let pay = AttestationInput {
        attestation_id: b32(&env, 0x31),
        subject: borrower.clone(),
        kind: ATTESTATION_KIND_PAYMENT,
        record_commitment: b32(&env, 0x41),
        metric_score: 90,
        amount_units: 100_000,
        duration_months: 0,
        issued_at: now - 10,
        expires_at: now + 1_000,
    };
    let sav = AttestationInput {
        attestation_id: b32(&env, 0x32),
        subject: borrower.clone(),
        kind: ATTESTATION_KIND_SAVINGS,
        record_commitment: b32(&env, 0x42),
        metric_score: 90,
        amount_units: 500_000,
        duration_months: 12,
        issued_at: now - 10,
        expires_at: now + 20_000,
    };
    client.submit_attestation(&issuer, &pay);
    client.submit_attestation(&issuer, &sav);

    let score_before = client.get_credit_score(&borrower).score;
    assert!(score_before >= 60);

    // Advance past payment attestation expiry (1_000s) -> payment drops dynamically
    env.ledger().with_mut(|li| {
        li.timestamp = now + 2_000;
    });
    let after_exp = client.get_score_breakdown(&borrower);
    assert_eq!(after_exp.verified_payment_count, 0);
    assert_eq!(after_exp.verified_savings_count, 1);
    assert!(after_exp.score < score_before);

    // On-time repayment increases standing; default slashes score severely
    client.record_loan_outcome(&borrower, &true, &false);
    let after_repay = client.get_score_breakdown(&borrower);
    assert_eq!(after_repay.repaid_loans, 1);

    client.record_loan_outcome(&borrower, &false, &true);
    let after_default = client.get_score_breakdown(&borrower);
    assert_eq!(after_default.defaulted_loans, 1);
    assert!(after_default.default_penalty >= 25);
    assert!(after_default.score < after_repay.score);

    // Revoking issuer invalidates remaining attestations immediately
    client.revoke_issuer(&issuer);
    let after_revoke = client.get_score_breakdown(&borrower);
    assert_eq!(after_revoke.verified_savings_count, 0);
}

#[test]
fn test_batch_limits_pagination_and_ttl_extension() {
    let (env, _admin, client) = setup();
    let contract_id = client.address.clone();
    let issuer = Address::generate(&env);
    let borrower = Address::generate(&env);
    let now = env.ledger().timestamp();

    let (_sk, pk_raw) = test_signing_key(9);
    client.register_issuer(
        &issuer,
        &BytesN::from_array(&env, &pk_raw.to_array()),
        &3u32,
        &String::from_str(&env, "Batch Provider"),
        &String::from_str(&env, "https://batch.example"),
    );

    // Oversized batch (> MAX_BATCH_SIZE) rejected
    let mut too_many = Vec::new(&env);
    for idx in 1..=(MAX_BATCH_SIZE + 1) {
        too_many.push_back(AttestationInput {
            attestation_id: b32(&env, idx as u8),
            subject: borrower.clone(),
            kind: ATTESTATION_KIND_PAYMENT,
            record_commitment: b32(&env, (idx + 50) as u8),
            metric_score: 85,
            amount_units: 10_000,
            duration_months: 0,
            issued_at: now,
            expires_at: now + 86_400,
        });
    }
    assert_eq!(
        client.try_batch_submit_attestations(&issuer, &too_many),
        Err(Ok(CreditScoreError::BatchTooLarge))
    );

    // Valid batch of 4 items
    let mut batch = Vec::new(&env);
    for idx in 1..=4u8 {
        batch.push_back(AttestationInput {
            attestation_id: b32(&env, idx),
            subject: borrower.clone(),
            kind: ATTESTATION_KIND_PAYMENT,
            record_commitment: b32(&env, idx + 40),
            metric_score: 85,
            amount_units: 10_000,
            duration_months: 0,
            issued_at: now,
            expires_at: now + 86_400,
        });
    }
    assert_eq!(client.batch_submit_attestations(&issuer, &batch), 4);

    // Bounded pagination across pages (2, 2, 0) & invalid limit 0 rejected
    assert_eq!(
        client.try_get_user_attestations_page(&borrower, &0, &0),
        Err(Ok(CreditScoreError::InvalidPageLimit))
    );
    let p1 = client.get_user_attestations_page(&borrower, &0, &2);
    let p2 = client.get_user_attestations_page(&borrower, &2, &2);
    assert_eq!(p1.len(), 2);
    assert_eq!(p2.len(), 2);
    assert_ne!(
        p1.get(0).unwrap().attestation_id,
        p2.get(0).unwrap().attestation_id
    );

    // Simulate long inactivity (advance ledger sequence below threshold) and keeper TTL extension
    env.ledger().with_mut(|li| {
        li.sequence_number += 2_100_000;
    });
    let extended = client.extend_user_ttl(&borrower, &10);
    assert!(extended > 0);
    env.as_contract(&contract_id, || {
        let ttl = env
            .storage()
            .persistent()
            .get_ttl(&crate::types::DataKey::UserCreditScore(borrower.clone()));
        assert!(ttl >= 2_500_000);
    });
}

#[test]
fn test_community_vouch_hooks_and_attestation_revocation() {
    let (env, _admin, client) = setup();
    let issuer = Address::generate(&env);
    let cv_contract = Address::generate(&env);
    let voucher = Address::generate(&env);
    let user = Address::generate(&env);
    let now = env.ledger().timestamp();

    let (_sk, pk_raw) = test_signing_key(3);
    client.register_issuer(
        &issuer,
        &BytesN::from_array(&env, &pk_raw.to_array()),
        &1u32,
        &String::from_str(&env, "Fintech Co"),
        &String::from_str(&env, "https://fintech.example"),
    );
    client.set_community_vouch_contract(&cv_contract);

    let att_id = b32(&env, 0x77);
    client.submit_attestation(
        &issuer,
        &AttestationInput {
            attestation_id: att_id.clone(),
            subject: user.clone(),
            kind: ATTESTATION_KIND_PAYMENT,
            record_commitment: b32(&env, 0x78),
            metric_score: 90,
            amount_units: 100_000,
            duration_months: 0,
            issued_at: now,
            expires_at: now + 86_400,
        },
    );

    client.add_community_vouch(
        &1u64,
        &user,
        &voucher,
        &600_000u128,
        &80u32,
        &(now + 86_400),
    );
    let with_vouch = client.get_credit_score(&user);
    assert!(with_vouch.community_score >= 80);

    client.remove_community_vouch(&user, &1u64);
    let without_vouch = client.get_credit_score(&user);
    assert_eq!(without_vouch.community_score, 0);

    client.revoke_attestation(&issuer, &att_id);
    assert_eq!(client.get_credit_score(&user).score, 0);
}
