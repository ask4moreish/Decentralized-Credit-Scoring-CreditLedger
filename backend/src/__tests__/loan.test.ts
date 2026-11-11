import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Keypair } from '@stellar/stellar-sdk';
import { loanRoutes } from '../controllers/loan';
import { stellarService } from '../services/stellarService';
import { dbService, resetTestMemoryDb } from '../services/dbService';
import { resolveJwtSecret } from '../middleware/auth';
import { disconnectDatabase } from '../config/database';

describe('Loans, Lender Pool, Collateral & Admin Endpoints', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/loans', loanRoutes);

  const borrowerKp = Keypair.random();
  const otherKp = Keypair.random();
  const lenderKp = Keypair.random();
  const adminKp = Keypair.random();
  const secret = resolveJwtSecret();

  function signJwt(publicKey: string, role: string, roles: string[], isAdmin = false, jti = 'jti-1') {
    return jwt.sign({ publicKey, role, roles, isAdmin, jti }, secret, {
      algorithm: 'HS256',
      issuer: 'creditledger-api',
    });
  }

  const borrowerToken = signJwt(borrowerKp.publicKey(), 'borrower', ['borrower'], false, 'loan-b');
  const otherToken = signJwt(otherKp.publicKey(), 'borrower', ['borrower'], false, 'loan-o');
  const lenderToken = signJwt(lenderKp.publicKey(), 'lender', ['borrower', 'lender'], false, 'loan-l');
  const adminToken = signJwt(adminKp.publicKey(), 'admin', ['admin', 'lender', 'borrower'], true, 'loan-a');

  beforeEach(() => {
    resetTestMemoryDb();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  test('lender prepare-deposit & prepare-withdraw enforce role and ownership, convert stroops', async () => {
    // Plain borrower without lender role gets 403
    const forbiddenRole = await request(app)
      .post('/api/loans/prepare-deposit')
      .set('Authorization', `Bearer ${borrowerToken}`)
      .send({ lenderPublicKey: borrowerKp.publicKey(), amount: '100' });
    expect(forbiddenRole.status).toBe(403);

    // Lender cannot prepare deposit for another lender
    const idorAttempt = await request(app)
      .post('/api/loans/prepare-deposit')
      .set('Authorization', `Bearer ${lenderToken}`)
      .send({ lenderPublicKey: otherKp.publicKey(), amount: '100' });
    expect(idorAttempt.status).toBe(403);

    const depSpy = jest
      .spyOn(stellarService, 'prepareDepositLiquidityTx')
      .mockResolvedValue('UNSIGNED_DEPOSIT_XDR');
    const witSpy = jest
      .spyOn(stellarService, 'prepareWithdrawLiquidityTx')
      .mockResolvedValue('UNSIGNED_WITHDRAW_XDR');

    const depRes = await request(app)
      .post('/api/loans/prepare-deposit')
      .set('Authorization', `Bearer ${lenderToken}`)
      .send({ lenderPublicKey: lenderKp.publicKey(), amount: '250.5' });
    expect(depRes.status).toBe(200);
    expect(depRes.body.xdr).toBe('UNSIGNED_DEPOSIT_XDR');
    expect(depSpy).toHaveBeenCalledWith(lenderKp.publicKey(), '2505000000');

    const witRes = await request(app)
      .post('/api/loans/prepare-withdraw')
      .set('Authorization', `Bearer ${lenderToken}`)
      .send({ lenderPublicKey: lenderKp.publicKey(), amount: '100' });
    expect(witRes.status).toBe(200);
    expect(witSpy).toHaveBeenCalledWith(lenderKp.publicKey(), '1000000000');
  });

  test('borrower prepare-apply enforces eligibility & collateral LTV before building XDR', async () => {
    jest.spyOn(stellarService, 'canBorrow').mockResolvedValue(true);
    jest.spyOn(stellarService, 'getRequiredCollateral').mockResolvedValue('5000000000'); // 500 XLM

    const underCol = await request(app)
      .post('/api/loans/prepare-apply')
      .set('Authorization', `Bearer ${borrowerToken}`)
      .send({
        borrowerPublicKey: borrowerKp.publicKey(),
        amount: '400',
        durationMonths: 6,
        collateralAmount: '100',
      });
    expect(underCol.status).toBe(400);
    expect(underCol.body.requiredCollateralStroops).toBe('5000000000');

    const prepSpy = jest
      .spyOn(stellarService, 'prepareCreateLoanTx')
      .mockResolvedValue('UNSIGNED_CREATE_LOAN_XDR');
    const validCol = await request(app)
      .post('/api/loans/prepare-apply')
      .set('Authorization', `Bearer ${borrowerToken}`)
      .send({
        borrowerPublicKey: borrowerKp.publicKey(),
        amount: '400',
        durationMonths: 6,
        collateralAmount: '500',
      });
    expect(validCol.status).toBe(200);
    expect(validCol.body.xdr).toBe('UNSIGNED_CREATE_LOAN_XDR');
    expect(prepSpy).toHaveBeenCalledWith(
      borrowerKp.publicKey(),
      '4000000000',
      6,
      '5000000000'
    );
  });

  test('enforces ownership on prepare-repay, prepare-cancel, and GET /api/loans/:loanId', async () => {
    jest.spyOn(stellarService, 'getLoan').mockResolvedValue({
      returnValue: {
        id: 7,
        borrower: borrowerKp.publicKey(),
        amount: '4000000000',
        status: 'Active',
      },
    });

    expect(
      (
        await request(app)
          .post('/api/loans/prepare-repay')
          .set('Authorization', `Bearer ${otherToken}`)
          .send({ loanId: 7, amount: '50' })
      ).status
    ).toBe(403);

    expect(
      (
        await request(app)
          .post('/api/loans/prepare-cancel')
          .set('Authorization', `Bearer ${otherToken}`)
          .send({ loanId: 7 })
      ).status
    ).toBe(403);

    expect(
      (await request(app).get('/api/loans/7').set('Authorization', `Bearer ${otherToken}`)).status
    ).toBe(403);
  });

  test('submit confirms on Soroban before DB write and honors Idempotency-Key', async () => {
    const subSpy = jest.spyOn(stellarService, 'submitTransaction').mockResolvedValue({
      hash: 'txhash_loan_001',
      ledger: 5682000,
      returnValue: 1,
    });
    jest.spyOn(stellarService, 'getLoan').mockResolvedValue({
      returnValue: {
        id: 1,
        borrower: borrowerKp.publicKey(),
        amount: '1000000000',
        interest_rate: 8,
        duration_months: 12,
        status: 'Pending',
        credit_score_used: 85,
        collateral_amount: '0',
        collateral_locked: false,
        scheduled_interest: '80000000',
      },
    });

    const body = {
      signedXDR: 'SIGNED_XDR_BLOB',
      action: 'apply',
      borrowerPublicKey: borrowerKp.publicKey(),
      amount: '100',
      durationMonths: 12,
    };

    const res1 = await request(app)
      .post('/api/loans/submit')
      .set('Authorization', `Bearer ${borrowerToken}`)
      .set('Idempotency-Key', 'loan-submit-idem-1')
      .send(body);
    expect(res1.status).toBe(200);
    expect(res1.body.transactionHash).toBe('txhash_loan_001');

    const storedLoan = await dbService.getLoanById(1);
    expect(storedLoan).toBeTruthy();
    expect(storedLoan.tx_hash).toBe('txhash_loan_001');

    const replay = await request(app)
      .post('/api/loans/submit')
      .set('Authorization', `Bearer ${borrowerToken}`)
      .set('Idempotency-Key', 'loan-submit-idem-1')
      .send(body);
    expect(replay.status).toBe(200);
    expect(replay.headers['x-idempotent-replay']).toBe('true');
    expect(subSpy).toHaveBeenCalledTimes(1);
  });

  test('pool state, lender balance, and admin RBAC endpoints work cleanly', async () => {
    jest.spyOn(stellarService, 'getPoolState').mockResolvedValue({
      returnValue: {
        total_shares: 10000000000n,
        available_cash: 7500000000n,
        outstanding_principal: 2500000000n,
        total_interest_earned: 120000000n,
        total_collateral_locked: 5000000000n,
        total_defaulted_principal: 0n,
        total_recovered: 0n,
      },
    });
    jest.spyOn(stellarService, 'getLenderBalance').mockResolvedValue('7500000000');

    const poolRes = await request(app)
      .get('/api/loans/pool')
      .set('Authorization', `Bearer ${lenderToken}`);
    expect(poolRes.status).toBe(200);
    expect(poolRes.body.data.availableCash).toBe('750');
    expect(poolRes.body.data.outstandingPrincipal).toBe('250');

    const balRes = await request(app)
      .get(`/api/loans/lender/${lenderKp.publicKey()}`)
      .set('Authorization', `Bearer ${lenderToken}`);
    expect(balRes.status).toBe(200);
    expect(balRes.body.data.balanceFormatted).toBe('750');

    // Non-admin blocked from admin endpoints
    expect(
      (await request(app).get('/api/loans/admin/active').set('Authorization', `Bearer ${lenderToken}`))
        .status
    ).toBe(403);
    expect(
      (await request(app).post('/api/loans/1/approve').set('Authorization', `Bearer ${borrowerToken}`))
        .status
    ).toBe(403);

    jest.spyOn(stellarService, 'approveLoan').mockResolvedValue({
      hash: 'approve_hash_1',
      ledger: 5682050,
      returnValue: null,
    });
    const appRes = await request(app)
      .post('/api/loans/1/approve')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(appRes.status).toBe(200);
    expect(appRes.body.transactionHash).toBe('approve_hash_1');
  });
});
