import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Keypair } from '@stellar/stellar-sdk';
import { creditScoreRoutes } from '../controllers/creditScore';
import { stellarService } from '../services/stellarService';
import { dbService, resetTestMemoryDb } from '../services/dbService';
import { resolveJwtSecret } from '../middleware/auth';
import { disconnectDatabase } from '../config/database';

describe('Credit Score, Attestations, Privacy Consent & Trends Routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/credit-score', creditScoreRoutes);

  const userKp = Keypair.random();
  const otherKp = Keypair.random();
  const issuerKp = Keypair.random();
  const verifierKp = Keypair.random();
  const adminKp = Keypair.random();
  const secret = resolveJwtSecret();

  function signJwt(publicKey: string, role: string, roles: string[], isAdmin = false, jti = 'cs-1') {
    return jwt.sign({ publicKey, role, roles, isAdmin, jti }, secret, {
      algorithm: 'HS256',
      issuer: 'creditledger-api',
    });
  }

  const userToken = signJwt(userKp.publicKey(), 'borrower', ['borrower', 'lender'], false, 'cs-u');
  const otherToken = signJwt(otherKp.publicKey(), 'borrower', ['borrower'], false, 'cs-o');
  const verifierToken = signJwt(verifierKp.publicKey(), 'lender', ['lender'], false, 'cs-v');
  const issuerToken = signJwt(issuerKp.publicKey(), 'issuer', ['issuer'], false, 'cs-i');
  const adminToken = signJwt(adminKp.publicKey(), 'admin', ['admin', 'issuer'], true, 'cs-a');

  beforeEach(() => {
    resetTestMemoryDb();
    process.env.CREDIT_SCORE_CONTRACT =
      'CBYH6SQZBYC7MWH4QF6FRGCKH2SW5EQD24RLK3EKOTMM5EYSQB7J65BZ';
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  test('blocks unauthenticated requests (401) and cross-user IDOR reads (403)', async () => {
    expect((await request(app).get(`/api/credit-score/${userKp.publicKey()}`)).status).toBe(401);
    expect((await request(app).get(`/api/credit-score/${userKp.publicKey()}/records`)).status).toBe(401);
    expect((await request(app).get(`/api/credit-score/${userKp.publicKey()}/breakdown`)).status).toBe(401);
    expect((await request(app).get(`/api/credit-score/${userKp.publicKey()}/trends`)).status).toBe(401);

    expect(
      (
        await request(app)
          .get(`/api/credit-score/${userKp.publicKey()}`)
          .set('Authorization', `Bearer ${otherToken}`)
      ).status
    ).toBe(403);
    expect(
      (
        await request(app)
          .get(`/api/credit-score/${userKp.publicKey()}/records`)
          .set('Authorization', `Bearer ${otherToken}`)
      ).status
    ).toBe(403);
  });

  test('issuer register/revoke enforce admin role and build-message enforces issuer/admin role', async () => {
    expect(
      (
        await request(app)
          .post('/api/credit-score/issuer/register')
          .set('Authorization', `Bearer ${userToken}`)
          .send({
            issuerPublicKey: issuerKp.publicKey(),
            category: 1,
            name: 'Trusted Utility Co',
            metadataUri: 'https://example.org/issuer.json',
          })
      ).status
    ).toBe(403);

    jest.spyOn(stellarService, 'registerIssuer').mockResolvedValue({
      hash: 'reg_issuer_hash',
      ledger: 5681200,
      returnValue: null,
    });
    const regOk = await request(app)
      .post('/api/credit-score/issuer/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        issuerPublicKey: issuerKp.publicKey(),
        category: 1,
        name: 'Trusted Utility Co',
        metadataUri: 'https://example.org/issuer.json',
      });
    expect(regOk.status).toBe(200);
    expect(regOk.body.transactionHash).toBe('reg_issuer_hash');

    const msgRes = await request(app)
      .post('/api/credit-score/issuer/build-message')
      .set('Authorization', `Bearer ${issuerToken}`)
      .send({
        subjectPublicKey: userKp.publicKey(),
        issuerPublicKey: issuerKp.publicKey(),
        kind: 1,
        metricScore: 92,
        amount: '1200',
        durationMonths: 12,
        financialData: { utilityProvider: 'PowerGrid', onTimeMonths: 12 },
      });
    expect(msgRes.status).toBe(200);
    expect(msgRes.body.attestationInput.amountUnits).toBe('12000000000');
    expect(msgRes.body.signingMessageHex).toBeTruthy();
  });

  test('encrypts private evidence at rest, enforces selective disclosure & revocation, and supports erasure', async () => {
    jest
      .spyOn(stellarService, 'prepareSubmitSignedAttestationTx')
      .mockResolvedValue('UNSIGNED_ATTESTATION_XDR');

    const attId = 'aa'.repeat(32);
    const commitHex = 'bb'.repeat(32);
    const sigHex = 'cc'.repeat(64);
    const now = Math.floor(Date.now() / 1000);

    const prepRes = await request(app)
      .post('/api/credit-score/attestations/prepare')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        subjectPublicKey: userKp.publicKey(),
        issuerPublicKey: issuerKp.publicKey(),
        kind: 1,
        metricScore: 90,
        amount: '500',
        durationMonths: 6,
        issuedAt: now,
        expiresAt: now + 86400 * 180,
        signatureHex: sigHex,
        attestationIdHex: attId,
        recordCommitmentHex: commitHex,
        rawFinancialDetails: {
          monthlyIncome: 4500,
          onTimeMonths: 12,
          accountNumber: 'PRIVATE-ACCT-999',
          ssn: '000-11-2222',
        },
      });
    expect(prepRes.status).toBe(200);
    expect(prepRes.body.xdr).toBe('UNSIGNED_ATTESTATION_XDR');

    // Stored record is AES-256-GCM ciphertext (not plaintext!)
    const storedRows = await dbService.getOwnerEncryptedRecords(userKp.publicKey());
    expect(storedRows).toHaveLength(1);
    expect(storedRows[0].ciphertext).toBeTruthy();
    expect(storedRows[0].iv).toBeTruthy();
    expect(storedRows[0].auth_tag).toBeTruthy();
    expect(storedRows[0].ciphertext).not.toContain('PRIVATE-ACCT-999');

    // Owner decrypts full record via authenticated /records route
    const ownerRecords = await request(app)
      .get(`/api/credit-score/${userKp.publicKey()}/records`)
      .set('Authorization', `Bearer ${userToken}`);
    expect(ownerRecords.status).toBe(200);
    expect(ownerRecords.body.data.records[0].details.monthlyIncome).toBe(4500);

    // Owner grants selective disclosure to verifier, even if forbidden keys included they are stripped
    const consentRes = await request(app)
      .post(`/api/credit-score/${userKp.publicKey()}/consent`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        granteePublicKey: verifierKp.publicKey(),
        scope: ['monthlyIncome', 'accountNumber', 'ssn'],
        recordIds: [attId],
      });
    expect(consentRes.status).toBe(201);
    const grantId = consentRes.body.grantId;

    // Unrelated user cannot use verifier's grant
    expect(
      (
        await request(app)
          .get(`/api/credit-score/${userKp.publicKey()}/disclose/${grantId}`)
          .set('Authorization', `Bearer ${otherToken}`)
      ).status
    ).toBe(403);

    // Authorized grantee only receives allowed non-PII claims
    const disclosed = await request(app)
      .get(`/api/credit-score/${userKp.publicKey()}/disclose/${grantId}`)
      .set('Authorization', `Bearer ${verifierToken}`);
    expect(disclosed.status).toBe(200);
    expect(disclosed.body.data[0].disclosedClaims).toEqual({ monthlyIncome: 4500 });
    expect(disclosed.body.data[0].disclosedClaims.ssn).toBeUndefined();

    // Revoke consent blocks subsequent disclosure
    const revRes = await request(app)
      .post(`/api/credit-score/${userKp.publicKey()}/consent/${grantId}/revoke`)
      .set('Authorization', `Bearer ${userToken}`);
    expect(revRes.status).toBe(200);
    expect(
      (
        await request(app)
          .get(`/api/credit-score/${userKp.publicKey()}/disclose/${grantId}`)
          .set('Authorization', `Bearer ${verifierToken}`)
      ).status
    ).toBe(403);

    // Right to erasure removes owner's private encrypted records
    const eraseRes = await request(app)
      .delete(`/api/credit-score/${userKp.publicKey()}/privacy`)
      .set('Authorization', `Bearer ${userToken}`);
    expect(eraseRes.status).toBe(200);
    expect(eraseRes.body.deletedRecords).toBe(1);
    expect(await dbService.getOwnerEncryptedRecords(userKp.publicKey())).toHaveLength(0);
  });

  test('supplementary self-reports are labeled 0-weight and trends return real historical snapshots', async () => {
    jest.spyOn(stellarService, 'prepareSubmitSelfReportedTx').mockResolvedValue('UNSIGNED_SUPP_XDR');
    const suppRes = await request(app)
      .post('/api/credit-score/prepare-supplementary')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        userPublicKey: userKp.publicKey(),
        kind: 1,
        amount: '300',
        claimedMetric: 100,
        durationMonths: 12,
      });
    expect(suppRes.status).toBe(200);
    expect(suppRes.body.verified).toBe(false);
    expect(suppRes.body.note).toMatch(/NOT contribute/i);

    jest.spyOn(stellarService, 'getScoreBreakdown').mockResolvedValue({
      returnValue: {
        model_version: 2,
        score: 82,
        payment_history_score: 90,
        savings_score: 75,
        repayment_score: 80,
        community_score: 70,
        activity_score: 65,
        default_penalty: 0,
        verified_payment_count: 2,
        verified_savings_count: 1,
        active_vouch_count: 1,
        self_reported_count: 1,
        last_updated: 1700000000,
      },
    });

    const scoreRes = await request(app)
      .get(`/api/credit-score/${userKp.publicKey()}`)
      .set('Authorization', `Bearer ${userToken}`);
    expect(scoreRes.status).toBe(200);
    expect(scoreRes.body.data.score).toBe(82);

    const trendsRes = await request(app)
      .get(`/api/credit-score/${userKp.publicKey()}/trends`)
      .set('Authorization', `Bearer ${userToken}`);
    expect(trendsRes.status).toBe(200);
    expect(trendsRes.body.data.snapshots).toHaveLength(1);
    expect(trendsRes.body.data.currentScore).toBe(82);
  });
});
