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

#[test]
fn test_adversarial_attestation_and_cross_contract_guards() {
    let (env, admin, client) = setup();
    let issuer = Address::generate(&env);
    let attacker = Address::generate(&env);
    let borrower = Address::generate(&env);
    let lm_contract = Address::generate(&env);
    let cv_contract = Address::generate(&env);
    let now = env.ledger().timestamp();

    let (_sk, pk) = test_signing_key(21);
    client.register_issuer(
        &issuer,
        &BytesN::from_array(&env, &pk.to_array()),
        &1u32,
        &String::from_str(&env, "Security Bank"),
        &String::from_str(&env, "https://secbank.example"),
    );
    client.set_loan_manager_contract(&lm_contract);
    client.set_community_vouch_contract(&cv_contract);

    // 1. Self-attestation blocked even by an active authorized issuer
    assert_eq!(
        client.try_submit_attestation(
            &issuer,
            &AttestationInput {
                attestation_id: b32(&env, 0xA1),
                subject: issuer.clone(),
                kind: ATTESTATION_KIND_PAYMENT,
                record_commitment: b32(&env, 0xB1),
                metric_score: 99,
                amount_units: 100_000,
                duration_months: 0,
                issued_at: now,
                expires_at: now + 86_400,
            },
        ),
        Err(Ok(CreditScoreError::InvalidInput))
    );

    // 2. Future timestamp drift (> 300s) rejected
    assert_eq!(
        client.try_submit_attestation(
            &issuer,
            &AttestationInput {
                attestation_id: b32(&env, 0xA2),
                subject: borrower.clone(),
                kind: ATTESTATION_KIND_PAYMENT,
                record_commitment: b32(&env, 0xB2),
                metric_score: 90,
                amount_units: 100_000,
                duration_months: 0,
                issued_at: now + 301,
                expires_at: now + 86_400,
            },
        ),
        Err(Ok(CreditScoreError::InvalidTimestamp))
    );

    // 3. Already-expired attestation rejected on submission
    assert_eq!(
        client.try_submit_attestation(
            &issuer,
            &AttestationInput {
                attestation_id: b32(&env, 0xA3),
                subject: borrower.clone(),
                kind: ATTESTATION_KIND_PAYMENT,
                record_commitment: b32(&env, 0xB3),
                metric_score: 90,
                amount_units: 100_000,
                duration_months: 0,
                issued_at: now - 10_000,
                expires_at: now - 1,
            },
        ),
        Err(Ok(CreditScoreError::AttestationExpired))
    );

    // 4. Unauthorized cross-contract callers cannot spoof loan outcomes or community vouches
    env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "record_loan_outcome",
            args: (&borrower, true, false).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(client
        .try_record_loan_outcome(&borrower, &true, &false)
        .is_err());

    env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "add_community_vouch",
            args: (
                &99u64,
                &borrower,
                &attacker,
                &5_000_000u128,
                &100u32,
                &(now + 86_400),
            )
                .into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(client
        .try_add_community_vouch(
            &99u64,
            &borrower,
            &attacker,
            &5_000_000u128,
            &100u32,
            &(now + 86_400)
        )
        .is_err());

    // 5. Revoking issuer for cause immediately neutralizes its historical attestations
    env.mock_all_auths();
    client.submit_attestation(
        &issuer,
        &AttestationInput {
            attestation_id: b32(&env, 0xA4),
            subject: borrower.clone(),
            kind: ATTESTATION_KIND_PAYMENT,
            record_commitment: b32(&env, 0xB4),
            metric_score: 95,
            amount_units: 100_000,
            duration_months: 0,
            issued_at: now,
            expires_at: now + 86_400,
        },
    );
    assert!(client.get_credit_score(&borrower).score > 0);
    let _ = &admin;
    client.revoke_issuer(&issuer);
    assert_eq!(client.get_credit_score(&borrower).score, 0);
}

#[test]
fn test_synthetic_borrower_profiles_matrix_and_sensitivity() {
    let (env, _admin, client) = setup();
    let issuer = Address::generate(&env);
    let lm_contract = Address::generate(&env);
    let cv_contract = Address::generate(&env);
    let voucher_a = Address::generate(&env);
    let voucher_b = Address::generate(&env);
    let now = env.ledger().timestamp();

    let (_sk, pk) = test_signing_key(31);
    client.register_issuer(
        &issuer,
        &BytesN::from_array(&env, &pk.to_array()),
        &1u32,
        &String::from_str(&env, "Benchmark Attestor"),
        &String::from_str(&env, "https://bench.example"),
    );
    client.set_loan_manager_contract(&lm_contract);
    client.set_community_vouch_contract(&cv_contract);

    let add_att =
        |tag: u8, subj: &Address, kind: u32, metric: u32, dur: u32, age: u64, ttl: u64| {
            let mut id = [0u8; 32];
            id[0] = tag;
            let mut comm = [0u8; 32];
            comm[0] = tag.wrapping_add(100);
            client.submit_attestation(
                &issuer,
                &AttestationInput {
                    attestation_id: BytesN::from_array(&env, &id),
                    subject: subj.clone(),
                    kind,
                    record_commitment: BytesN::from_array(&env, &comm),
                    metric_score: metric,
                    amount_units: 200_000,
                    duration_months: dur,
                    issued_at: now - age,
                    expires_at: now + ttl,
                },
            );
        };

    // 1. Excellent borrower (Prime >= 80)
    let p_excellent = Address::generate(&env);
    for i in 1..=6u8 {
        add_att(
            i,
            &p_excellent,
            ATTESTATION_KIND_PAYMENT,
            92,
            0,
            1_000,
            365 * 86_400,
        );
    }
    add_att(
        10,
        &p_excellent,
        ATTESTATION_KIND_SAVINGS,
        88,
        12,
        1_000,
        365 * 86_400,
    );
    client.record_loan_outcome(&p_excellent, &true, &false);
    client.record_loan_outcome(&p_excellent, &true, &false);
    client.record_loan_outcome(&p_excellent, &true, &false);
    client.add_community_vouch(
        &1,
        &p_excellent,
        &voucher_a,
        &1_000_000u128,
        &90,
        &(now + 365 * 86_400),
    );

    // 2. Average borrower (Near-Prime 60..79)
    let p_average = Address::generate(&env);
    for i in 11..=13u8 {
        add_att(
            i,
            &p_average,
            ATTESTATION_KIND_PAYMENT,
            74,
            0,
            1_000,
            365 * 86_400,
        );
    }
    add_att(
        14,
        &p_average,
        ATTESTATION_KIND_SAVINGS,
        70,
        6,
        1_000,
        365 * 86_400,
    );
    client.record_loan_outcome(&p_average, &true, &false);

    // 3. High-risk borrower (Ineligible < 50 due to late payments + default penalty)
    let p_high_risk = Address::generate(&env);
    add_att(
        21,
        &p_high_risk,
        ATTESTATION_KIND_PAYMENT,
        55,
        0,
        1_000,
        365 * 86_400,
    );
    add_att(
        22,
        &p_high_risk,
        ATTESTATION_KIND_PAYMENT,
        50,
        0,
        1_000,
        365 * 86_400,
    );
    add_att(
        23,
        &p_high_risk,
        ATTESTATION_KIND_SAVINGS,
        45,
        2,
        1_000,
        365 * 86_400,
    );
    client.record_loan_outcome(&p_high_risk, &false, &false);
    client.record_loan_outcome(&p_high_risk, &false, &true);

    // 4. Limited history borrower (1 payment + 1 short savings, no prior loan outcomes, no vouches)
    let p_limited = Address::generate(&env);
    add_att(
        31,
        &p_limited,
        ATTESTATION_KIND_PAYMENT,
        72,
        0,
        1_000,
        365 * 86_400,
    );
    add_att(
        32,
        &p_limited,
        ATTESTATION_KIND_SAVINGS,
        68,
        3,
        1_000,
        365 * 86_400,
    );

    // 5. Inconsistent repayment borrower (volatile payments + 2 late repayments, 0 defaults)
    let p_inconsistent = Address::generate(&env);
    for (idx, metric) in [95u32, 42, 92, 46].iter().enumerate() {
        add_att(
            41 + idx as u8,
            &p_inconsistent,
            ATTESTATION_KIND_PAYMENT,
            *metric,
            0,
            1_000,
            365 * 86_400,
        );
    }
    add_att(
        45,
        &p_inconsistent,
        ATTESTATION_KIND_SAVINGS,
        60,
        4,
        1_000,
        365 * 86_400,
    );
    client.record_loan_outcome(&p_inconsistent, &false, &false);
    client.record_loan_outcome(&p_inconsistent, &false, &false);

    // 6. Community-backed borrower (same base financial signals as p_limited + 2 strong escrowed vouches)
    let p_community = Address::generate(&env);
    add_att(
        51,
        &p_community,
        ATTESTATION_KIND_PAYMENT,
        72,
        0,
        1_000,
        365 * 86_400,
    );
    add_att(
        52,
        &p_community,
        ATTESTATION_KIND_SAVINGS,
        68,
        3,
        1_000,
        365 * 86_400,
    );
    client.add_community_vouch(
        &2,
        &p_community,
        &voucher_a,
        &700_000u128,
        &85,
        &(now + 365 * 86_400),
    );
    client.add_community_vouch(
        &3,
        &p_community,
        &voucher_b,
        &500_000u128,
        &85,
        &(now + 365 * 86_400),
    );

    // 7. Defaulted previously good borrower
    let p_defaulted = Address::generate(&env);
    for i in 61..=64u8 {
        add_att(
            i,
            &p_defaulted,
            ATTESTATION_KIND_PAYMENT,
            88,
            0,
            1_000,
            365 * 86_400,
        );
    }
    add_att(
        65,
        &p_defaulted,
        ATTESTATION_KIND_SAVINGS,
        82,
        12,
        1_000,
        365 * 86_400,
    );
    client.record_loan_outcome(&p_defaulted, &true, &false);
    let pre_default = client.get_score_breakdown(&p_defaulted).score;
    client.record_loan_outcome(&p_defaulted, &false, &true);

    // 8. Missing data / self-reported only (must remain 0)
    let p_empty = Address::generate(&env);
    let p_self_only = Address::generate(&env);
    client.submit_self_reported_record(
        &p_self_only,
        &SelfReportInput {
            record_commitment: b32(&env, 0xEE),
            kind: ATTESTATION_KIND_PAYMENT,
            claimed_amount: 99_999_999,
            claimed_metric: 100,
            duration_months: 0,
            timestamp: now,
        },
    );

    let b_ex = client.get_score_breakdown(&p_excellent);
    let b_av = client.get_score_breakdown(&p_average);
    let b_hr = client.get_score_breakdown(&p_high_risk);
    let b_lim = client.get_score_breakdown(&p_limited);
    let b_inc = client.get_score_breakdown(&p_inconsistent);
    let b_com = client.get_score_breakdown(&p_community);
    let b_def = client.get_score_breakdown(&p_defaulted);
    let b_emp = client.get_score_breakdown(&p_empty);
    let b_self = client.get_score_breakdown(&p_self_only);

    // Bounds, exact breakdown verification, & risk-tier ordering checks
    for b in [
        &b_ex, &b_av, &b_hr, &b_lim, &b_inc, &b_com, &b_def, &b_emp, &b_self,
    ] {
        assert!(b.score <= 100);
    }
    assert_eq!(
        (
            b_ex.payment_history_score,
            b_ex.savings_score,
            b_ex.repayment_score,
            b_ex.community_score,
            b_ex.activity_score,
            b_ex.score
        ),
        (100, 100, 86, 100, 100, 97)
    );
    assert_eq!(
        (
            b_av.payment_history_score,
            b_av.savings_score,
            b_av.repayment_score,
            b_av.community_score,
            b_av.activity_score,
            b_av.score
        ),
        (79, 80, 62, 0, 60, 66)
    );
    assert_eq!(
        (
            b_hr.payment_history_score,
            b_hr.savings_score,
            b_hr.repayment_score,
            b_hr.community_score,
            b_hr.activity_score,
            b_hr.default_penalty,
            b_hr.score
        ),
        (52, 45, 3, 0, 60, 25, 11)
    );
    assert_eq!(
        (
            b_lim.payment_history_score,
            b_lim.savings_score,
            b_lim.repayment_score,
            b_lim.community_score,
            b_lim.activity_score,
            b_lim.score
        ),
        (72, 73, 50, 0, 30, 56)
    );
    assert_eq!(
        (
            b_inc.payment_history_score,
            b_inc.savings_score,
            b_inc.repayment_score,
            b_inc.community_score,
            b_inc.activity_score,
            b_inc.score
        ),
        (73, 65, 56, 0, 85, 61)
    );
    assert_eq!(
        (
            b_com.payment_history_score,
            b_com.savings_score,
            b_com.repayment_score,
            b_com.community_score,
            b_com.activity_score,
            b_com.score
        ),
        (72, 73, 50, 100, 60, 69)
    );
    assert_eq!(pre_default, 78);
    assert_eq!(
        (
            b_def.payment_history_score,
            b_def.savings_score,
            b_def.repayment_score,
            b_def.community_score,
            b_def.activity_score,
            b_def.default_penalty,
            b_def.score
        ),
        (93, 100, 12, 0, 85, 25, 43)
    );
    assert_eq!(b_emp.score, 0);
    assert_eq!(b_self.score, 0);
    assert!(b_com.score > b_lim.score);
    assert!(b_av.score > b_inc.score);

    // Expiration sensitivity: advancing past 365 days drops all expired attestations/vouches
    env.ledger().with_mut(|li| {
        li.timestamp = now + 400 * 86_400;
    });
    assert_eq!(client.get_credit_score(&p_limited).score, 0);
}
