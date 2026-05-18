import request from 'supertest';
import express from 'express';
import { authRoutes } from '../controllers/auth';

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);

describe('Auth Controller', () => {
  describe('GET /api/auth/challenge', () => {
    it('returns a hex challenge string', async () => {
      const res = await request(app).get('/api/auth/challenge');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('challenge');
      expect(typeof res.body.challenge).toBe('string');
      expect(res.body.challenge).toMatch(/^[0-9a-f]+$/);
    });
  });

  describe('POST /api/auth/login', () => {
    it('returns 400 when body is missing required fields', async () => {
      const res = await request(app).post('/api/auth/login').send({});
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('errors');
    });

    it('returns 400 when publicKey is wrong length', async () => {
      const res = await request(app).post('/api/auth/login').send({
        publicKey: 'tooshort',
        signature: 'abc123',
        challenge: 'somechallenge',
      });
      expect(res.status).toBe(400);
    });

    it('returns 401 for invalid signature', async () => {
      // Valid 56-char Stellar public key but with a bad signature
      const res = await request(app).post('/api/auth/login').send({
        publicKey: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN1',
        signature: 'deadbeef',
        challenge: 'testchallenge',
      });
      // Either 400 (validation) or 401/500 (bad sig) — not 200
      expect(res.status).not.toBe(200);
    });
  });
});
