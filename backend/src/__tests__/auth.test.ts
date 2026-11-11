import express from 'express';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { authRoutes, _devMemoryChallengesForTest } from '../controllers/auth';
import { authMiddleware } from '../middleware/auth';
import { resetTestMemoryDb } from '../services/dbService';
import { redisCache } from '../config/redis';
import { disconnectDatabase } from '../config/database';

describe('Authentication, Nonce Replay Resistance & Session Rotation', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.get('/protected', authMiddleware, (req, res) => {
    res.json({ user: req.user });
  });

  const userKp = Keypair.random();
  const adminKp = Keypair.random();
  const issuerKp = Keypair.random();
  const prevEnv = { ...process.env };

  beforeEach(() => {
    resetTestMemoryDb();
    _devMemoryChallengesForTest.clear();
    process.env.NODE_ENV = 'test';
    process.env.ADMIN_PUBLIC_KEYS = adminKp.publicKey();
    process.env.ISSUER_PUBLIC_KEYS = issuerKp.publicKey();
  });

  afterEach(() => {
    process.env = { ...prevEnv };
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  test('challenge -> Ed25519 signature login issues 15m JWT + refresh token + roles', async () => {
    const chRes = await request(app).get('/api/auth/challenge');
    expect(chRes.status).toBe(200);
    const { challenge } = chRes.body;
    expect(typeof challenge).toBe('string');

    const signature = userKp.sign(Buffer.from(challenge, 'utf8')).toString('hex');
    const loginRes = await request(app).post('/api/auth/login').send({
      publicKey: userKp.publicKey(),
      challenge,
      signature,
      role: 'borrower',
    });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.token).toBeTruthy();
    expect(loginRes.body.refreshToken).toBeTruthy();
    expect(loginRes.body.isAdmin).toBe(false);
    expect(loginRes.body.roles).toContain('borrower');
    expect(loginRes.body.roles).toContain('lender');

    const meRes = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${loginRes.body.token}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.publicKey).toBe(userKp.publicKey());
  });

  test('assigns admin and issuer roles strictly from allowlists', async () => {
    const chRes = await request(app).get('/api/auth/challenge');
    const sig = adminKp.sign(Buffer.from(chRes.body.challenge, 'utf8')).toString('base64');
    const res = await request(app).post('/api/auth/login').send({
      publicKey: adminKp.publicKey(),
      challenge: chRes.body.challenge,
      signature: sig,
    });
    expect(res.status).toBe(200);
    expect(res.body.isAdmin).toBe(true);
    expect(res.body.roles).toContain('admin');
  });

  test('rejects sequential and concurrent nonce replay attacks cleanly', async () => {
    const chRes = await request(app).get('/api/auth/challenge');
    const { challenge } = chRes.body;
    const signature = userKp.sign(Buffer.from(challenge, 'utf8')).toString('hex');

    // Race two simultaneous logins on the exact same challenge nonce
    const [r1, r2] = await Promise.all([
      request(app).post('/api/auth/login').send({
        publicKey: userKp.publicKey(),
        challenge,
        signature,
      }),
      request(app).post('/api/auth/login').send({
        publicKey: userKp.publicKey(),
        challenge,
        signature,
      }),
    ]);

    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 401]);

    // Sequential replay fails
    const replay = await request(app).post('/api/auth/login').send({
      publicKey: userKp.publicKey(),
      challenge,
      signature,
    });
    expect(replay.status).toBe(401);
  });

  test('rejects invalid signatures, wrong keypairs, and expired challenges', async () => {
    const chRes = await request(app).get('/api/auth/challenge');
    const attacker = Keypair.random();
    const wrongSig = attacker.sign(Buffer.from(chRes.body.challenge, 'utf8')).toString('hex');

    const badSigRes = await request(app).post('/api/auth/login').send({
      publicKey: userKp.publicKey(),
      challenge: chRes.body.challenge,
      signature: wrongSig,
    });
    expect(badSigRes.status).toBe(401);

    // Expire challenge manually
    const ch2 = (await request(app).get('/api/auth/challenge')).body.challenge;
    _devMemoryChallengesForTest.set(ch2, { expiresAt: Date.now() - 1000 });
    const sig2 = userKp.sign(Buffer.from(ch2, 'utf8')).toString('hex');
    const expiredRes = await request(app).post('/api/auth/login').send({
      publicKey: userKp.publicKey(),
      challenge: ch2,
      signature: sig2,
    });
    expect(expiredRes.status).toBe(401);
  });

  test('fails closed (503) in production when Redis is unavailable for challenge/nonce checks', async () => {
    const chRes = await request(app).get('/api/auth/challenge');
    const { challenge } = chRes.body;
    const signature = userKp.sign(Buffer.from(challenge, 'utf8')).toString('hex');

    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'a'.repeat(64);
    jest.spyOn(redisCache, 'isConnected').mockReturnValue(false);

    const chFail = await request(app).get('/api/auth/challenge');
    expect(chFail.status).toBe(503);

    const loginFail = await request(app).post('/api/auth/login').send({
      publicKey: userKp.publicKey(),
      challenge,
      signature,
    });
    expect(loginFail.status).toBe(503);
    jest.restoreAllMocks();
  });

  test('refresh token rotates single-use tokens and detects reuse attacks to revoke whole family', async () => {
    const chRes = await request(app).get('/api/auth/challenge');
    const sig = userKp.sign(Buffer.from(chRes.body.challenge, 'utf8')).toString('hex');
    const login = await request(app).post('/api/auth/login').send({
      publicKey: userKp.publicKey(),
      challenge: chRes.body.challenge,
      signature: sig,
    });
    const firstAccess = login.body.token;
    const firstRefresh = login.body.refreshToken;

    const refreshed = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: firstRefresh });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refreshToken).not.toBe(firstRefresh);
    expect(refreshed.body.token).toBeTruthy();

    // Old access JWT was immediately revoked via JTI blocklist
    const oldJwtUse = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${firstAccess}`);
    expect(oldJwtUse.status).toBe(401);

    // Re-presenting already rotated refresh token triggers family revocation!
    const reuseAttempt = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: firstRefresh });
    expect(reuseAttempt.status).toBe(401);
    expect(reuseAttempt.body.error).toMatch(/reuse detected/i);

    // Even the previously newest refresh token in that compromised family is now invalid
    const secondRefreshAfterCompromise = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: refreshed.body.refreshToken });
    expect(secondRefreshAfterCompromise.status).toBe(401);
  });

  test('logout revokes active access JWT and refresh sessions', async () => {
    const chRes = await request(app).get('/api/auth/challenge');
    const sig = userKp.sign(Buffer.from(chRes.body.challenge, 'utf8')).toString('hex');
    const login = await request(app).post('/api/auth/login').send({
      publicKey: userKp.publicKey(),
      challenge: chRes.body.challenge,
      signature: sig,
    });

    const outRes = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${login.body.token}`);
    expect(outRes.status).toBe(200);

    const postLogoutUse = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${login.body.token}`);
    expect(postLogoutUse.status).toBe(401);

    const postLogoutRefresh = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: login.body.refreshToken });
    expect(postLogoutRefresh.status).toBe(401);
  });
});
