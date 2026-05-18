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

jest.mock('../services/stellarService', () => ({
  stellarService: {
    canBorrow: jest.fn().mockResolvedValue(true),
    createLoan: jest.fn().mockResolvedValue({ hash: 'testhash', returnValue: 1 }),
    getLoan: jest.fn().mockResolvedValue({
      hash: 'testhash',
      returnValue: { id: 1, borrower: userKey, amount: '1000', status: 'active' },
    }),
    getUserLoans: jest.fn().mockResolvedValue({ hash: 'testhash', returnValue: [] }),
    repayLoan: jest.fn().mockResolvedValue({ hash: 'testhash' }),
    approveLoan: jest.fn().mockResolvedValue({ hash: 'testhash' }),
    markDefault: jest.fn().mockResolvedValue({ hash: 'testhash' }),
    getActiveLoans: jest.fn().mockResolvedValue({ hash: 'testhash', returnValue: [] }),
    getLoanStatistics: jest.fn().mockResolvedValue({ hash: 'testhash', returnValue: {} }),
    getCreditScore: jest.fn().mockResolvedValue({ returnValue: { score: 750 } }),
  },
}));

import { loanRoutes } from '../controllers/loan';

const app = express();
app.use(express.json());
app.use('/api/loans', loanRoutes);

const token = jwt.sign({ publicKey: userKey, isAdmin: false }, 'secret', { expiresIn: '1h' });
const authHeader = `Bearer ${token}`;
const adminToken = jwt.sign({ publicKey: userKey, isAdmin: true }, 'secret', { expiresIn: '1h' });
const adminHeader = `Bearer ${adminToken}`;

describe('Loan Routes', () => {
  describe('POST /api/loans/apply', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).post('/api/loans/apply').send({});
      expect(res.status).toBe(401);
    });

    it('returns 400 with invalid body', async () => {
      const res = await request(app)
        .post('/api/loans/apply')
        .set('Authorization', authHeader)
        .send({ borrowerPublicKey: userKey });
      expect(res.status).toBe(400);
    });

    it('creates a loan successfully', async () => {
      const res = await request(app)
        .post('/api/loans/apply')
        .set('Authorization', authHeader)
        .send({ borrowerPublicKey: userKey, amount: 1000, durationMonths: 12 });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('loanId');
    });
  });

  describe('GET /api/loans/user/:userPublicKey', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get(`/api/loans/user/${userKey}`);
      expect(res.status).toBe(401);
    });

    it('returns user loans', async () => {
      const res = await request(app)
        .get(`/api/loans/user/${userKey}`)
        .set('Authorization', authHeader);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('loans');
    });
  });

  describe('GET /api/loans/admin/active', () => {
    it('returns 403 for non-admin', async () => {
      const res = await request(app)
        .get('/api/loans/admin/active')
        .set('Authorization', authHeader);
      expect(res.status).toBe(403);
    });

    it('returns active loans for admin', async () => {
      const res = await request(app)
        .get('/api/loans/admin/active')
        .set('Authorization', adminHeader);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('loans');
    });
  });

  describe('POST /api/loans/check-eligibility', () => {
    it('returns eligibility info', async () => {
      const res = await request(app)
        .post('/api/loans/check-eligibility')
        .set('Authorization', authHeader)
        .send({ userPublicKey: userKey, amount: 500 });
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('canBorrow');
    });
  });
});
