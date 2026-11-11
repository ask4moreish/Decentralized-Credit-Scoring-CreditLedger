import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import {
  connectDatabase,
  db,
  disconnectDatabase,
  isDatabaseAvailable,
} from '../config/database';
import {
  connectRedis,
  disconnectRedis,
  isRedisAvailable,
  redisCache,
} from '../config/redis';
import { authRoutes } from '../controllers/auth';
import { creditScoreRoutes } from '../controllers/creditScore';
import { idempotencyMiddleware } from '../middleware/idempotency';
import { stellarService } from '../services/stellarService';
import { dbService } from '../services/dbService';

const describeWithInfra = process.env.TEST_REQUIRE_DB === '1' ? describe : describe.skip;

describeWithInfra('Live PostgreSQL & Redis Integration Verification', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use('/api/credit-score', creditScoreRoutes);

  let idemCount = 0;
  app.post('/api/test-idempotency', idempotencyMiddleware, (req, res) => {
    idemCount += 1;
    res.status(201).json({ count: idemCount, amount: req.body.amount });
  });

  const userKp = Keypair.random();
  const verifierKp = Keypair.random();
  const issuerKp = Keypair.random();

  beforeAll(async () => {
    await connectDatabase();
    await connectRedis();
    expect(isDatabaseAvailable()).toBe(true);
    expect(isRedisAvailable()).toBe(true);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await disconnectRedis();
    await disconnectDatabase();
  });

  test('verifies all hardened Knex migration tables exist in live PostgreSQL', async () => {
    const rows = await db('information_schema.tables')
      .select('table_name')
      .where({ table_schema: 'public' });
    const tableNames = rows.map((r: { table_name: string }) => r.table_name);

    for (const expectedTable of [
      'users',
      'credit_score_cache',
      'loans',
      'vouches',
      'user_sessions',
      'encrypted_financial_records',
      'consent_grants',
      'idempotency_keys',
      'stellar_transactions',
      'score_snapshots',
      'lender_positions',
      'audit_logs',
      'knex_migrations',
    ]) {
      expect(tableNames).toContain(expectedTable);
    }
  });

  test('live Redis atomic getAndDelete blocks concurrent challenge replay + Postgres rotates refresh sessions', async () => {
    // Direct Redis atomic getAndDelete concurrency race
    const raceKey = `test:race:${crypto.randomUUID()}`;
    await redisCache.set(raceKey, { nonce: 'live' }, 60);
    const raceResults = await Promise.all([
      redisCache.getAndDelete<{ nonce: string }>(raceKey),
      redisCache.getAndDelete<{ nonce: string }>(raceKey),
      redisCache.getAndDelete<{ nonce: string }>(raceKey),
    ]);
    const winners = raceResults.filter(Boolean);
    expect(winners).toHaveLength(1);

    // Full HTTP challenge -> Ed25519 login -> single-use refresh rotation -> reuse attack family revocation
    const chRes = await request(app).get('/api/auth/challenge');
    expect(chRes.status).toBe(200);
    const sig = userKp.sign(Buffer.from(chRes.body.challenge, 'utf8')).toString('hex');

    const loginRes = await request(app).post('/api/auth/login').send({
      publicKey: userKp.publicKey(),
      challenge: chRes.body.challenge,
      signature: sig,
      role: 'borrower',
    });
    expect(loginRes.status).toBe(200);
    const access1 = loginRes.body.token;
    const refresh1 = loginRes.body.refreshToken;

    const sessionRows = await db('user_sessions').where({ user_public_key: userKp.publicKey() });
    expect(sessionRows.length).toBeGreaterThanOrEqual(1);

    const refRes = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: refresh1 });
    expect(refRes.status).toBe(200);
    expect(refRes.body.refreshToken).not.toBe(refresh1);

    // Presenting old refresh token again must trigger family revocation in PostgreSQL
    const reuseRes = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: refresh1 });
    expect(reuseRes.status).toBe(401);

    const postCompromiseRefresh = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: refRes.body.refreshToken });
    expect(postCompromiseRefresh.status).toBe(401);
    expect(access1).toBeTruthy();
  });

  test('persists AES-256-GCM records, consent grants, snapshots, erasure & audit logs in PostgreSQL', async () => {
    const chRes = await request(app).get('/api/auth/challenge');
    const sig = userKp.sign(Buffer.from(chRes.body.challenge, 'utf8')).toString('hex');
    const login = await request(app).post('/api/auth/login').send({
      publicKey: userKp.publicKey(),
      challenge: chRes.body.challenge,
      signature: sig,
    });
    const token = login.body.token;

    jest
      .spyOn(stellarService, 'prepareSubmitSignedAttestationTx')
      .mockResolvedValue('UNSIGNED_PG_ATT_XDR');

    const now = Math.floor(Date.now() / 1000);
    const attId = crypto.randomBytes(32).toString('hex');
    const commitHex = crypto.randomBytes(32).toString('hex');
    const prep = await request(app)
      .post('/api/credit-score/attestations/prepare')
      .set('Authorization', `Bearer ${token}`)
      .send({
        subjectPublicKey: userKp.publicKey(),
        issuerPublicKey: issuerKp.publicKey(),
        kind: 1,
        metricScore: 88,
        amount: '500.1234567',
        durationMonths: 6,
        issuedAt: now,
        expiresAt: now + 86400 * 90,
        signatureHex: 'ab'.repeat(64),
        attestationIdHex: attId,
        recordCommitmentHex: commitHex,
        rawFinancialDetails: {
          monthlyIncome: 5200,
          ssn: '000-00-9999',
          accountNumber: 'PG-PRIV-001',
        },
      });
    expect(prep.status).toBe(200);

    const pgEncRows = await db('encrypted_financial_records').where({
      user_public_key: userKp.publicKey(),
    });
    expect(pgEncRows.length).toBeGreaterThanOrEqual(1);
    expect(pgEncRows[0].ciphertext).not.toContain('PG-PRIV-001');

    // Grant & revoke selective consent in Postgres
    const grantRes = await request(app)
      .post(`/api/credit-score/${userKp.publicKey()}/consent`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        granteePublicKey: verifierKp.publicKey(),
        scope: ['monthlyIncome', 'ssn'],
        recordIds: [attId],
      });
    expect(grantRes.status).toBe(201);

    const revRes = await request(app)
      .post(`/api/credit-score/${userKp.publicKey()}/consent/${grantRes.body.grantId}/revoke`)
      .set('Authorization', `Bearer ${token}`);
    expect(revRes.status).toBe(200);

    // Erase private encrypted records & check audit log persistence
    const eraseRes = await request(app)
      .delete(`/api/credit-score/${userKp.publicKey()}/privacy`)
      .set('Authorization', `Bearer ${token}`);
    expect(eraseRes.status).toBe(200);
    expect(eraseRes.body.deletedRecords).toBeGreaterThanOrEqual(1);

    const afterEraseRows = await db('encrypted_financial_records').where({
      user_public_key: userKp.publicKey(),
    });
    expect(afterEraseRows).toHaveLength(0);

    const auditRows = await db('audit_logs').where({
      actor_public_key: userKp.publicKey(),
      action: 'private_records_erased',
    });
    expect(auditRows.length).toBeGreaterThanOrEqual(1);

    // Persist credit score snapshot & verify PostgreSQL row + stellar_transactions tracking
    await dbService.upsertCreditScore({
      publicKey: userKp.publicKey(),
      score: 79,
      paymentHistoryScore: 88,
      savingsScore: 70,
      repaymentScore: 75,
      communityScore: 60,
      activityScore: 60,
      modelVersion: 2,
    });
    const snaps = await db('score_snapshots').where({ user_public_key: userKp.publicKey() });
    expect(snaps.length).toBeGreaterThanOrEqual(1);
  });

  test('persists PostgreSQL Idempotency-Key responses & Stellar tx reconciliation states', async () => {
    const key = `pg-idem-${crypto.randomUUID()}`;
    const r1 = await request(app)
      .post('/api/test-idempotency')
      .set('Idempotency-Key', key)
      .send({ amount: '123.4567890' });
    expect(r1.status).toBe(201);

    const r2 = await request(app)
      .post('/api/test-idempotency')
      .set('Idempotency-Key', key)
      .send({ amount: '123.4567890' });
    expect(r2.status).toBe(201);
    expect(r2.headers['x-idempotent-replay']).toBe('true');

    const conflict = await request(app)
      .post('/api/test-idempotency')
      .set('Idempotency-Key', key)
      .send({ amount: '999' });
    expect(conflict.status).toBe(409);

    const pgKey = await db('idempotency_keys').where({ idempotency_key: key }).first();
    expect(pgKey).toBeTruthy();

    const txHash = `pg_tx_${crypto.randomBytes(12).toString('hex')}`;
    await dbService.recordStellarTx({
      txHash,
      operationType: 'loan_repay',
      actorPublicKey: userKp.publicKey(),
      status: 'pending',
    });
    jest.spyOn(stellarService as any, 'queryTransactionJsonRpc').mockResolvedValue({
      status: 'SUCCESS',
      ledger: 5681750,
    });
    const rec = await stellarService.reconcilePendingTransactions();
    expect(rec.reconciled).toBeGreaterThanOrEqual(1);

    const pgTx = await db('stellar_transactions').where({ tx_hash: txHash }).first();
    expect(pgTx.status).toBe('confirmed');
    expect(Number(pgTx.ledger_sequence)).toBe(5681750);
  });
});
