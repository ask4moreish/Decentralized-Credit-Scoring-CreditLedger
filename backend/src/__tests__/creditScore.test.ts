import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

// Mock Redis and Stellar before importing routes
jest.mock('../config/redis', () => ({
  redisCache: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/stellarService', () => ({
  stellarService: {
    getCreditScore: jest.fn().mockResolvedValue({
      hash: 'testhash',
      returnValue: { score: 750, payment_history_score: 80, savings_score: 70, community_score: 60, activity_score: 50, last_updated: 0 },
    }),
    updatePaymentHistory: jest.fn().mockResolvedValue({ hash: 'testhash' }),
    updateSavingsData: jest.fn().mockResolvedValue({ hash: 'testhash' }),
  },
}));

import { creditScoreRoutes } from '../controllers/creditScore';

const app = express();
app.use(express.json());
app.use('/api/credit-score', creditScoreRoutes);

const userKey = 'GDTGVTV3MOO64CFHTSKBNATTMOZ7DRYCF7H2XGO7A74YM32PEFURJRKB';
const token = jwt.sign({ publicKey: userKey, isAdmin: false }, 'secret', { expiresIn: '1h' });
const authHeader = `Bearer ${token}`;

describe('Credit Score Routes', () => {
  describe('GET /api/credit-score/:userPublicKey', () => {
    it('returns credit score data', async () => {
      const res = await request(app).get(`/api/credit-score/${userKey}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('GET /api/credit-score/:userPublicKey/payment-history', () => {
    it('returns paginated payment history', async () => {
      const res = await request(app).get(`/api/credit-score/${userKey}/payment-history`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('paymentHistory');
      expect(res.body.data).toHaveProperty('total');
    });
  });

  describe('GET /api/credit-score/:userPublicKey/savings-data', () => {
    it('returns paginated savings data', async () => {
      const res = await request(app).get(`/api/credit-score/${userKey}/savings-data`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('savingsData');
    });
  });

  describe('GET /api/credit-score/:userPublicKey/trends', () => {
    it('returns trend data', async () => {
      const res = await request(app).get(`/api/credit-score/${userKey}/trends`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('currentScore');
    });
  });

  describe('POST /api/credit-score/payment-history', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).post('/api/credit-score/payment-history').send({});
      expect(res.status).toBe(401);
    });

    it('returns 400 with invalid body', async () => {
      const res = await request(app)
        .post('/api/credit-score/payment-history')
        .set('Authorization', authHeader)
        .send({ userPublicKey: userKey, payments: [] });
      expect(res.status).toBe(400);
    });

    it('updates payment history successfully', async () => {
      const res = await request(app)
        .post('/api/credit-score/payment-history')
        .set('Authorization', authHeader)
        .send({
          userPublicKey: userKey,
          payments: [{ amount: 100, timestamp: 1700000000, paymentType: 'mobile', consistencyScore: 80 }],
        });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('POST /api/credit-score/savings-data', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).post('/api/credit-score/savings-data').send({});
      expect(res.status).toBe(401);
    });

    it('updates savings data successfully', async () => {
      const res = await request(app)
        .post('/api/credit-score/savings-data')
        .set('Authorization', authHeader)
        .send({
          userPublicKey: userKey,
          amount: 500,
          timestamp: 1700000000,
          durationMonths: 6,
          regularityScore: 75,
        });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});
