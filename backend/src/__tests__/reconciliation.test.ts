import { Keypair } from '@stellar/stellar-sdk';
import { stellarService } from '../services/stellarService';
import { dbService, resetTestMemoryDb } from '../services/dbService';
import { disconnectDatabase } from '../config/database';

describe('Stellar Attestation Signing & PostgreSQL-Soroban Reconciliation', () => {
  beforeEach(() => {
    resetTestMemoryDb();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  test('builds deterministic domain-separated attestation message and verifies Ed25519 signature', () => {
    const issuerKp = Keypair.random();
    const subjectKp = Keypair.random();
    // Valid C... contract strkey (random address via mock or existing valid Testnet contract ID)
    const contractId = 'CBYH6SQZBYC7MWH4QF6FRGCKH2SW5EQD24RLK3EKOTMM5EYSQB7J65BZ';

    const input = {
      attestationIdHex: '11'.repeat(32),
      subjectPublicKey: subjectKp.publicKey(),
      kind: 1,
      recordCommitmentHex: '22'.repeat(32),
      metricScore: 95,
      amountUnits: '5000000000',
      durationMonths: 12,
      issuedAt: 1700000000,
      expiresAt: 1715552000,
    };

    const msgA = stellarService.buildAttestationSigningMessage(contractId, issuerKp.publicKey(), input);
    const msgB = stellarService.buildAttestationSigningMessage(contractId, issuerKp.publicKey(), input);
    expect(msgA.equals(msgB)).toBe(true);
    expect(msgA.length).toBe(258); // Matches Soroban build_attestation_message (to_xdr ScvAddress parity)

    const sigHex = stellarService.signAttestationWithKeypair(contractId, issuerKp, input);
    expect(sigHex).toHaveLength(128);
    expect(issuerKp.verify(msgA, Buffer.from(sigHex, 'hex'))).toBe(true);

    // Tampered metric invalidates signature
    const tampered = stellarService.buildAttestationSigningMessage(contractId, issuerKp.publicKey(), {
      ...input,
      metricScore: 99,
    });
    expect(issuerKp.verify(tampered, Buffer.from(sigHex, 'hex'))).toBe(false);
  });

  test('reconcilePendingTransactions reconciles SUCCESS, FAILED, and NOT_FOUND transactions cleanly', async () => {
    const actor = Keypair.random().publicKey();
    await dbService.recordStellarTx({
      txHash: 'hash_ok',
      operationType: 'loan_repay',
      actorPublicKey: actor,
      status: 'pending',
    });
    await dbService.recordStellarTx({
      txHash: 'hash_fail',
      operationType: 'loan_apply',
      actorPublicKey: actor,
      status: 'pending',
    });
    await dbService.recordStellarTx({
      txHash: 'hash_wait',
      operationType: 'vouch_create',
      actorPublicKey: actor,
      status: 'pending',
    });

    jest
      .spyOn(stellarService as any, 'queryTransactionJsonRpc')
      .mockImplementation(async (txHash: unknown) => {
        if (txHash === 'hash_ok') return { status: 'SUCCESS', ledger: 5681000 };
        if (txHash === 'hash_fail') return { status: 'FAILED', ledger: 5681001, resultXdr: 'tx_failed' };
        return { status: 'NOT_FOUND' };
      });

    const summary = await stellarService.reconcilePendingTransactions();
    expect(summary).toEqual({ reconciled: 1, failed: 1 });

    const okTx = await dbService.getStellarTx('hash_ok');
    const failTx = await dbService.getStellarTx('hash_fail');
    const waitTx = await dbService.getStellarTx('hash_wait');

    expect(okTx.status).toBe('confirmed');
    expect(okTx.ledger_sequence).toBe(5681000);
    expect(failTx.status).toBe('failed');
    expect(failTx.last_error).toBe('tx_failed');
    expect(waitTx.status).toBe('pending');
    expect(waitTx.retry_count).toBe(1);
  });
});
