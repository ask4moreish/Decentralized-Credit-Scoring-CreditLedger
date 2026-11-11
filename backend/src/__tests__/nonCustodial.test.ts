import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Keypair } from '@stellar/stellar-sdk';
import { vouchRoutes } from '../controllers/vouch';
import { loanRoutes } from '../controllers/loan';
import { creditScoreRoutes } from '../controllers/creditScore';
import { stellarService } from '../services/stellarService';
import { dbService, resetTestMemoryDb } from '../services/dbService';
import { resolveJwtSecret } from '../middleware/auth';
import { disconnectDatabase } from '../config/database';

describe('Non-Custodial Enforcement & Community Vouch Escrow Routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/vouch', vouchRoutes);
  app.use('/api/loans', loanRoutes);
  app.use('/api/credit-score', creditScoreRoutes);

  const voucherKp = Keypair.random();
  const voucheeKp = Keypair.random();
  const attackerKp = Keypair.random();
  const secret = resolveJwtSecret();

  function makeJwt(publicKey: string) {
    return jwt.sign({ publicKey, role: 'borrower', roles: ['borrower'], isAdmin: false }, secret, {
      algorithm: 'HS256',
      issuer: 'creditledger-api',
    });
  }

  const voucherToken = makeJwt(voucherKp.publicKey());
  const attackerToken = makeJwt(attackerKp.publicKey());

  beforeEach(() => {
    resetTestMemoryDb();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  test('removed legacy custodial endpoints stay offline (404)', async () => {
    const legacy1 = await request(app)
      .post('/api/credit-score/payment-history')
      .set('Authorization', `Bearer ${voucherToken}`)
      .send({ userSecret: 'SSECRET', onTimePayments: 99 });
    expect(legacy1.status).toBe(404);

    const legacy2 = await request(app)
      .post('/api/loans/apply')
      .set('Authorization', `Bearer ${voucherToken}`)
      .send({ userSecret: 'SSECRET', amount: 100 });
    expect(legacy2.status).toBe(404);

    const legacy3 = await request(app)
      .post('/api/vouch/create')
      .set('Authorization', `Bearer ${voucherToken}`)
      .send({ userSecret: 'SSECRET', trustScore: 100 });
    expect(legacy3.status).toBe(404);
  });

  test('prepare-create ignores any caller-supplied trustScore and passes 5 protocol args only', async () => {
    const prepSpy = jest
      .spyOn(stellarService, 'prepareCreateVouchTx')
      .mockResolvedValue('UNSIGNED_ESCROW_VOUCH_XDR');

    const res = await request(app)
      .post('/api/vouch/prepare-create')
      .set('Authorization', `Bearer ${voucherToken}`)
      .send({
        voucherPublicKey: voucherKp.publicKey(),
        voucheePublicKey: voucheeKp.publicKey(),
        amount: '150',
        trustScore: 100, // Should NEVER be forwarded to contract!
        reason: 'Colleague verification',
        durationMonths: 6,
      });

    expect(res.status).toBe(200);
    expect(res.body.xdr).toBe('UNSIGNED_ESCROW_VOUCH_XDR');
    expect(res.body.amountStroops).toBe('1500000000');
    expect(prepSpy).toHaveBeenCalledWith(
      voucherKp.publicKey(),
      voucheeKp.publicKey(),
      '1500000000',
      'Colleague verification',
      6
    );
  });

  test('enforces ownership, blocks self-vouching, and supports revoke/expire/withdraw + submit', async () => {
    const selfRes = await request(app)
      .post('/api/vouch/prepare-create')
      .set('Authorization', `Bearer ${voucherToken}`)
      .send({
        voucherPublicKey: voucherKp.publicKey(),
        voucheePublicKey: voucherKp.publicKey(),
        amount: '50',
        reason: 'Self vouch attempt',
        durationMonths: 3,
      });
    expect(selfRes.status).toBe(400);

    const idorRevoke = await request(app)
      .post('/api/vouch/5/prepare-revoke')
      .set('Authorization', `Bearer ${attackerToken}`)
      .send({ voucherPublicKey: voucherKp.publicKey() });
    expect(idorRevoke.status).toBe(403);

    jest.spyOn(stellarService, 'prepareRevokeVouchTx').mockResolvedValue('XDR_REVOKE');
    jest.spyOn(stellarService, 'prepareExpireVouchTx').mockResolvedValue('XDR_EXPIRE');
    jest.spyOn(stellarService, 'prepareWithdrawRemainingVouchTx').mockResolvedValue('XDR_WITHDRAW');
    jest.spyOn(stellarService, 'submitTransaction').mockResolvedValue({
      hash: 'txhash_vouch_1',
      ledger: 5682100,
      returnValue: 5,
    });
    jest.spyOn(stellarService, 'getVouch').mockResolvedValue({
      returnValue: {
        id: 5,
        voucher: voucherKp.publicKey(),
        vouchee: voucheeKp.publicKey(),
        amount: 1500000000n,
        escrowed_balance: 1500000000n,
        trust_score: 78,
        reason: 'Community peer',
      },
    });

    expect(
      (
        await request(app)
          .post('/api/vouch/5/prepare-revoke')
          .set('Authorization', `Bearer ${voucherToken}`)
          .send({ voucherPublicKey: voucherKp.publicKey() })
      ).body.xdr
    ).toBe('XDR_REVOKE');
    expect(
      (
        await request(app)
          .post('/api/vouch/5/prepare-expire')
          .set('Authorization', `Bearer ${voucherToken}`)
      ).body.xdr
    ).toBe('XDR_EXPIRE');
    expect(
      (
        await request(app)
          .post('/api/vouch/5/prepare-withdraw')
          .set('Authorization', `Bearer ${voucherToken}`)
      ).body.xdr
    ).toBe('XDR_WITHDRAW');

    const submitRes = await request(app)
      .post('/api/vouch/submit')
      .set('Authorization', `Bearer ${voucherToken}`)
      .send({
        signedXDR: 'SIGNED_VOUCH_XDR',
        action: 'create',
        voucherPublicKey: voucherKp.publicKey(),
        voucheePublicKey: voucheeKp.publicKey(),
        amount: '150',
        reason: 'Community peer',
      });
    expect(submitRes.status).toBe(200);
    expect(submitRes.body.transactionHash).toBe('txhash_vouch_1');

    const storedVouches = await dbService.getUserVouches(voucherKp.publicKey());
    expect(storedVouches).toHaveLength(1);
    expect(storedVouches[0].trust_score).toBe(78);

    // Cross-user GET vouches blocked with 403
    expect(
      (
        await request(app)
          .get(`/api/vouch/user/${voucherKp.publicKey()}`)
          .set('Authorization', `Bearer ${attackerToken}`)
      ).status
    ).toBe(403);
  });
});
