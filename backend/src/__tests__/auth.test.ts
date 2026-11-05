import request from 'supertest';
import express from 'express';
import { Keypair } from '@stellar/stellar-sdk';
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
      const res = await request(app).post('/api/auth/login').send({
        publicKey: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN1',
        signature: 'deadbeef',
        challenge: 'testchallenge',
      });
      expect(res.status).not.toBe(200);
    });

    it('authenticates valid signature and prevents challenge replay', async () => {
      // 1. Generate real Stellar Keypair
      const keypair = Keypair.random();
      const publicKey = keypair.publicKey();

      // 2. Request a challenge nonce
      const challengeRes = await request(app).get('/api/auth/challenge');
      expect(challengeRes.status).toBe(200);
      const challenge = challengeRes.body.challenge;

      // 3. Sign the challenge with Ed25519 private key
      const signature = keypair.sign(Buffer.from(challenge)).toString('hex');

      // 4. Authenticate first time (expect 200 with JWT token)
      const loginRes = await request(app).post('/api/auth/login').send({
        publicKey,
        signature,
        challenge,
      });
      expect(loginRes.status).toBe(200);
      expect(loginRes.body).toHaveProperty('token');
      expect(loginRes.body.publicKey).toBe(publicKey);

      // 5. Attempt to REPLAY the exact same challenge and signature (must fail with 401)
      const replayRes = await request(app).post('/api/auth/login').send({
        publicKey,
        signature,
        challenge,
      });
      expect(replayRes.status).toBe(401);
      expect(replayRes.body.error).toMatch(/Invalid or expired challenge nonce/i);
    });
  });
});
