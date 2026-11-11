import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Keypair } from '@stellar/stellar-sdk';
import {
  authMiddleware,
  requireAdmin,
  requireRoles,
  resolveJwtSecret,
  revokeAccessJti,
} from '../middleware/auth';
import { disconnectDatabase } from '../config/database';

describe('Auth, JTI Revocation & RBAC Middleware', () => {
  const app = express();
  app.use(express.json());
  app.get('/user', authMiddleware, (req, res) => res.json({ user: req.user }));
  app.get('/admin', authMiddleware, requireAdmin, (req, res) => res.json({ ok: true }));
  app.get('/issuer', authMiddleware, requireRoles('issuer', 'admin'), (req, res) =>
    res.json({ ok: true })
  );

  const userKey = Keypair.random().publicKey();
  const issuerKey = Keypair.random().publicKey();
  const adminKey = Keypair.random().publicKey();
  const testSecret = resolveJwtSecret();

  afterAll(async () => {
    await disconnectDatabase();
  });

  test('rejects missing, wrong-issuer, wrong-secret, and revoked tokens with 401', async () => {
    expect((await request(app).get('/user')).status).toBe(401);

    const wrongSecret = jwt.sign({ publicKey: userKey }, 'wrong-secret-key', {
      algorithm: 'HS256',
      issuer: 'creditledger-api',
    });
    expect(
      (await request(app).get('/user').set('Authorization', `Bearer ${wrongSecret}`)).status
    ).toBe(401);

    const wrongIssuer = jwt.sign({ publicKey: userKey }, testSecret, {
      algorithm: 'HS256',
      issuer: 'other-issuer',
    });
    expect(
      (await request(app).get('/user').set('Authorization', `Bearer ${wrongIssuer}`)).status
    ).toBe(401);

    const jti = 'jti-revoked-001';
    const revokedToken = jwt.sign({ publicKey: userKey, jti }, testSecret, {
      algorithm: 'HS256',
      issuer: 'creditledger-api',
    });
    await revokeAccessJti(jti, 60);
    expect(
      (await request(app).get('/user').set('Authorization', `Bearer ${revokedToken}`)).status
    ).toBe(401);
  });

  test('authenticates valid Bearer or cl_access cookie tokens and enforces RBAC', async () => {
    const borrowerToken = jwt.sign(
      { publicKey: userKey, role: 'borrower', roles: ['borrower'], isAdmin: false, jti: 'j-b1' },
      testSecret,
      { algorithm: 'HS256', issuer: 'creditledger-api' }
    );
    const issuerToken = jwt.sign(
      { publicKey: issuerKey, role: 'issuer', roles: ['issuer'], isAdmin: false, jti: 'j-i1' },
      testSecret,
      { algorithm: 'HS256', issuer: 'creditledger-api' }
    );
    const adminToken = jwt.sign(
      { publicKey: adminKey, role: 'admin', roles: ['admin'], isAdmin: true, jti: 'j-a1' },
      testSecret,
      { algorithm: 'HS256', issuer: 'creditledger-api' }
    );

    const cookieRes = await request(app)
      .get('/user')
      .set('Cookie', `cl_access=${encodeURIComponent(borrowerToken)}`);
    expect(cookieRes.status).toBe(200);
    expect(cookieRes.body.user.publicKey).toBe(userKey);

    expect(
      (await request(app).get('/admin').set('Authorization', `Bearer ${borrowerToken}`)).status
    ).toBe(403);
    expect(
      (await request(app).get('/issuer').set('Authorization', `Bearer ${borrowerToken}`)).status
    ).toBe(403);

    expect(
      (await request(app).get('/issuer').set('Authorization', `Bearer ${issuerToken}`)).status
    ).toBe(200);
    expect(
      (await request(app).get('/admin').set('Authorization', `Bearer ${issuerToken}`)).status
    ).toBe(403);

    expect(
      (await request(app).get('/admin').set('Authorization', `Bearer ${adminToken}`)).status
    ).toBe(200);
    expect(
      (await request(app).get('/issuer').set('Authorization', `Bearer ${adminToken}`)).status
    ).toBe(200);
  });
});
