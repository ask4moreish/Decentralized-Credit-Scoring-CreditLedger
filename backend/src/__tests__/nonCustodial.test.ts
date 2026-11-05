import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

jest.mock('../config/redis', () => ({
  redisCache: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
  },
}));

const userKey = 'GDTGVTV3MOO64CFHTSKBNATTMOZ7DRYCF7H2XGO7A74YM32PEFURJRKB';
const voucheeKey = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN1';

jest.mock('../services/stellarService', () => ({
  stellarService: {
    canBorrow: jest.fn().mockResolvedValue(true),
    prepareCreateLoanTx: jest.fn().mockResolvedValue('AAAA_MOCK_UNSIGNED_LOAN_XDR'),
    prepareRepayLoanTx: jest.fn().mockResolvedValue('AAAA_MOCK_UNSIGNED_REPAY_XDR'),
    prepareCreateVouchTx: jest.fn().mockResolvedValue('AAAA_MOCK_UNSIGNED_VOUCH_XDR'),
    prepareRevokeVouchTx: jest.fn().mockResolvedValue('AAAA_MOCK_UNSIGNED_REVOKE_VOUCH_XDR'),
    prepareUpdatePaymentHistoryTx: jest.fn().mockResolvedValue('AAAA_MOCK_UNSIGNED_PAYMENT_XDR'),
    prepareUpdateSavingsDataTx: jest.fn().mockResolvedValue('AAAA_MOCK_UNSIGNED_SAVINGS_XDR'),
    submitTransaction: jest.fn().mockResolvedValue({
      hash: 'mock_submitted_hash_123',
      returnValue: 42,
    }),
    getLoan: jest.fn().mockResolvedValue({
      returnValue: { id: 1, borrower: userKey, amount: '1000', status: 'active' },
    }),
    getCreditScore: jest.fn().mockResolvedValue({
      returnValue: { score: 85, payment_history_score: 85, savings_score: 80, community_score: 75, activity_score: 70, last_updated: 0 },
    }),
  },
}));

import { creditScoreRoutes } from '../controllers/creditScore';
import { loanRoutes } from '../controllers/loan';
import { vouchRoutes } from '../controllers/vouch';

const app = express();
app.use(express.json());
app.use('/api/credit-score', creditScoreRoutes);
app.use('/api/loans', loanRoutes);
app.use('/api/vouch', vouchRoutes);

const token = jwt.sign({ publicKey: userKey, isAdmin: false }, 'secret', { expiresIn: '1h' });
const authHeader = `Bearer ${token}`;

describe('Non-Custodial Freighter Workflow Endpoints', () => {
  it('prepares unsigned payment history transaction for user signing', async () => {
    const res = await request(app)
      .post('/api/credit-score/prepare-payment-history')
      .set('Authorization', authHeader)
      .send({
        userPublicKey: userKey,
        payments: [{ amount: 50, timestamp: 1700000000, paymentType: 'utility', consistencyScore: 90 }],
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.xdr).toBe('AAAA_MOCK_UNSIGNED_PAYMENT_XDR');
  });

  it('prepares unsigned savings data transaction for user signing', async () => {
    const res = await request(app)
      .post('/api/credit-score/prepare-savings-data')
      .set('Authorization', authHeader)
      .send({
        userPublicKey: userKey,
        amount: 500,
        timestamp: 1700000000,
        durationMonths: 6,
        regularityScore: 85,
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.xdr).toBe('AAAA_MOCK_UNSIGNED_SAVINGS_XDR');
  });

  it('prepares unsigned loan application transaction for user signing', async () => {
    const res = await request(app)
      .post('/api/loans/prepare-apply')
      .set('Authorization', authHeader)
      .send({
        borrowerPublicKey: userKey,
        amount: 250,
        durationMonths: 6,
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.xdr).toBe('AAAA_MOCK_UNSIGNED_LOAN_XDR');
  });

  it('prepares unsigned loan repayment transaction for user signing', async () => {
    const res = await request(app)
      .post('/api/loans/prepare-repay')
      .set('Authorization', authHeader)
      .send({
        loanId: 1,
        amount: 50,
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.xdr).toBe('AAAA_MOCK_UNSIGNED_REPAY_XDR');
  });

  it('prepares unsigned vouch creation transaction for user signing', async () => {
    const res = await request(app)
      .post('/api/vouch/prepare-create')
      .set('Authorization', authHeader)
      .send({
        voucherPublicKey: userKey,
        voucheePublicKey: voucheeKey,
        amount: 100,
        trustScore: 85,
        reason: 'Reliable community member',
        durationMonths: 12,
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.xdr).toBe('AAAA_MOCK_UNSIGNED_VOUCH_XDR');
  });

  it('prepares unsigned vouch revocation transaction for user signing', async () => {
    const res = await request(app)
      .post('/api/vouch/1/prepare-revoke')
      .set('Authorization', authHeader)
      .send({
        voucherPublicKey: userKey,
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.xdr).toBe('AAAA_MOCK_UNSIGNED_REVOKE_VOUCH_XDR');
  });

  it('submits signed transaction XDR to network', async () => {
    const res = await request(app)
      .post('/api/credit-score/submit-transaction')
      .set('Authorization', authHeader)
      .send({
        signedXDR: 'AAAA_SIGNED_MOCK_XDR',
        userPublicKey: userKey,
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.transactionHash).toBe('mock_submitted_hash_123');
  });
});
