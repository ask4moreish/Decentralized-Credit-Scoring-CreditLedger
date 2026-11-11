import crypto from 'node:crypto';
import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { StrKey } from '@stellar/stellar-sdk';
import { stellarService, AttestationPayloadInput } from '../services/stellarService';
import { redisCache } from '../config/redis';
import { dbService } from '../services/dbService';
import { logger } from '../utils/logger';
import { authMiddleware, requireAdmin, requireRoles } from '../middleware/auth';
import { idempotencyMiddleware } from '../middleware/idempotency';
import {
  computeRecordCommitment,
  decryptFinancialRecord,
  encryptFinancialRecord,
  filterDisclosedClaims,
} from '../services/privacyService';
import { parseDecimalToStroops } from '../utils/amounts';

const router = Router();

function ensureOwnerOrAdmin(req: Request, res: Response, targetPublicKey: string): boolean {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return false;
  }
  if (req.user.publicKey !== targetPublicKey && !req.user.isAdmin) {
    res.status(403).json({ error: 'Forbidden: cannot access or modify another user record' });
    return false;
  }
  return true;
}

// POST /api/credit-score/issuer/register (Admin only)
router.post(
  '/issuer/register',
  authMiddleware,
  requireAdmin,
  [
    body('issuerPublicKey').isString().isLength({ min: 56, max: 56 }),
    body('category').isInt({ min: 1, max: 4 }),
    body('name').isString().isLength({ min: 2, max: 96 }),
    body('metadataUri').isString().isLength({ max: 200 }),
    body('verificationKeyHex').optional().isHexadecimal().isLength({ min: 64, max: 64 }),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { issuerPublicKey, category, name, metadataUri, verificationKeyHex } = req.body;
      if (!StrKey.isValidEd25519PublicKey(issuerPublicKey)) {
        return res.status(400).json({ error: 'Invalid Stellar issuer public key' });
      }
      const result = await stellarService.registerIssuer({
        issuerPublicKey,
        category,
        name,
        metadataUri,
        verificationKeyHex,
      });
      await dbService.recordAuditLog({
        actorPublicKey: req.user!.publicKey,
        action: 'issuer_registered',
        resourceType: 'issuer',
        resourceId: issuerPublicKey,
        status: 'confirmed',
      });
      res.json({ success: true, transactionHash: result.hash });
    } catch (error) {
      logger.error('Error registering issuer:', error);
      res.status(500).json({ error: 'Failed to register issuer' });
    }
  }
);

// POST /api/credit-score/issuer/revoke (Admin only)
router.post(
  '/issuer/revoke',
  authMiddleware,
  requireAdmin,
  [body('issuerPublicKey').isString().isLength({ min: 56, max: 56 })],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { issuerPublicKey } = req.body;
      const result = await stellarService.revokeIssuer(issuerPublicKey);
      await dbService.recordAuditLog({
        actorPublicKey: req.user!.publicKey,
        action: 'issuer_revoked',
        resourceType: 'issuer',
        resourceId: issuerPublicKey,
        status: 'confirmed',
      });
      res.json({ success: true, transactionHash: result.hash });
    } catch (error) {
      logger.error('Error revoking issuer:', error);
      res.status(500).json({ error: 'Failed to revoke issuer' });
    }
  }
);

// POST /api/credit-score/attestations/prepare
// Prepares an unsigned non-custodial transaction for an authorized Ed25519-signed attestation
router.post(
  '/attestations/prepare',
  authMiddleware,
  idempotencyMiddleware,
  [
    body('subjectPublicKey').isString().isLength({ min: 56, max: 56 }),
    body('issuerPublicKey').isString().isLength({ min: 56, max: 56 }),
    body('kind').isInt({ min: 1, max: 2 }),
    body('metricScore').isInt({ min: 0, max: 100 }),
    body('amount').notEmpty(),
    body('durationMonths').isInt({ min: 0, max: 120 }),
    body('issuedAt').isInt({ min: 1 }),
    body('expiresAt').isInt({ min: 2 }),
    body('signatureHex').isHexadecimal().isLength({ min: 128, max: 128 }),
    body('attestationIdHex').isHexadecimal().isLength({ min: 64, max: 64 }),
    body('recordCommitmentHex').isHexadecimal().isLength({ min: 64, max: 64 }),
    body('rawFinancialDetails').optional().isObject(),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const {
        subjectPublicKey,
        issuerPublicKey,
        kind,
        metricScore,
        amount,
        durationMonths,
        issuedAt,
        expiresAt,
        signatureHex,
        attestationIdHex,
        recordCommitmentHex,
        rawFinancialDetails,
      } = req.body;

      if (!ensureOwnerOrAdmin(req, res, subjectPublicKey)) return;

      const amountStroops = parseDecimalToStroops(amount);
      const input: AttestationPayloadInput = {
        attestationIdHex,
        subjectPublicKey,
        kind,
        recordCommitmentHex,
        metricScore,
        amountUnits: amountStroops,
        durationMonths,
        issuedAt: Number(issuedAt),
        expiresAt: Number(expiresAt),
      };

      const unsignedXdr = await stellarService.prepareSubmitSignedAttestationTx(
        subjectPublicKey,
        issuerPublicKey,
        input,
        signatureHex
      );

      // Encrypt optional off-chain evidence at rest via AES-256-GCM before persisting
      if (rawFinancialDetails) {
        const encrypted = encryptFinancialRecord(rawFinancialDetails);
        await dbService.storeEncryptedRecord({
          id: attestationIdHex,
          ownerPublicKey: subjectPublicKey,
          issuerPublicKey,
          attestationId: attestationIdHex,
          recordKind: kind === 1 ? 'payment' : 'savings',
          recordCommitment: recordCommitmentHex,
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          verified: true,
          expiresAt: new Date(Number(expiresAt) * 1000),
        });
      }

      res.json({
        success: true,
        xdr: unsignedXdr,
        attestationId: attestationIdHex,
        recordCommitment: recordCommitmentHex,
      });
    } catch (error) {
      logger.error('Error preparing signed attestation tx:', error);
      res.status(500).json({ error: 'Failed to prepare signed attestation transaction' });
    }
  }
);

// POST /api/credit-score/prepare-supplementary
// Replaces insecure score-boosting self-report endpoints: only anchors non-authoritative metadata (0 score impact)
router.post(
  '/prepare-supplementary',
  authMiddleware,
  idempotencyMiddleware,
  [
    body('userPublicKey').isString().isLength({ min: 56, max: 56 }),
    body('kind').isInt({ min: 1, max: 2 }),
    body('amount').notEmpty(),
    body('claimedMetric').isInt({ min: 0, max: 100 }),
    body('durationMonths').isInt({ min: 0, max: 120 }),
    body('recordPayload').optional().isObject(),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { userPublicKey, kind, amount, claimedMetric, durationMonths, recordPayload } = req.body;
      if (!ensureOwnerOrAdmin(req, res, userPublicKey)) return;

      const timestamp = Math.floor(Date.now() / 1000);
      const offchainDoc = {
        ...(recordPayload || {}),
        kind,
        amount: String(amount),
        claimedMetric,
        durationMonths,
        timestamp,
      };
      const recordCommitment = computeRecordCommitment(offchainDoc);
      const encrypted = encryptFinancialRecord(offchainDoc);
      const recordId = crypto.randomUUID();

      await dbService.storeEncryptedRecord({
        id: recordId,
        ownerPublicKey: userPublicKey,
        recordKind: 'supplementary',
        recordCommitment,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        verified: false,
      });

      const unsignedXdr = await stellarService.prepareSubmitSelfReportedTx(userPublicKey, {
        kind,
        recordCommitmentHex: recordCommitment,
        claimedAmount: amount,
        claimedMetric,
        durationMonths,
        timestamp,
      });

      res.json({
        success: true,
        xdr: unsignedXdr,
        recordId,
        recordCommitment,
        verified: false,
        note: 'Supplementary self-reported data does NOT contribute to authoritative credit score.',
      });
    } catch (error) {
      logger.error('Error preparing supplementary transaction:', error);
      res.status(500).json({ error: 'Failed to prepare supplementary record transaction' });
    }
  }
);

// POST /api/credit-score/submit-transaction
router.post(
  '/submit-transaction',
  authMiddleware,
  idempotencyMiddleware,
  [
    body('signedXDR').isString().notEmpty(),
    body('userPublicKey').optional().isString().isLength({ min: 56, max: 56 }),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { signedXDR, userPublicKey } = req.body;
      const targetUser = userPublicKey || req.user!.publicKey;
      if (!ensureOwnerOrAdmin(req, res, targetUser)) return;

      const result = await stellarService.submitTransaction(signedXDR);
      await dbService.recordStellarTx({
        txHash: result.hash,
        operationType: 'credit_score_tx',
        actorPublicKey: req.user!.publicKey,
        status: 'confirmed',
        ledgerSequence: result.ledger,
      });

      // Refresh cached breakdown after confirmed on-chain settlement
      await redisCache.del(`credit_score:${targetUser}`);
      await redisCache.del(`user:profile:${targetUser}`);

      try {
        const fresh = await stellarService.getScoreBreakdown(targetUser);
        if (fresh.returnValue) {
          const b = fresh.returnValue;
          await dbService.upsertCreditScore({
            publicKey: targetUser,
            score: Number(b.score || 0),
            paymentHistoryScore: Number(b.payment_history_score || 0),
            savingsScore: Number(b.savings_score || 0),
            repaymentScore: Number(b.repayment_score || 0),
            communityScore: Number(b.community_score || 0),
            activityScore: Number(b.activity_score || 0),
            modelVersion: Number(b.model_version || 2),
          });
        }
      } catch {
        // Non-fatal if offline/mocked
      }

      res.json({
        success: true,
        transactionHash: result.hash,
        ledger: result.ledger,
        data: result.returnValue,
      });
    } catch (error) {
      logger.error('Error submitting credit score transaction:', error);
      res.status(500).json({ error: 'Failed to submit and confirm credit score transaction' });
    }
  }
);

// POST /api/credit-score/:userPublicKey/consent — Grant selective disclosure consent
router.post(
  '/:userPublicKey/consent',
  authMiddleware,
  [
    body('granteePublicKey').isString().isLength({ min: 56, max: 56 }),
    body('scope').isArray({ min: 1 }),
    body('recordIds').isArray(),
    body('ttlSeconds').optional().isInt({ min: 60, max: 2592000 }),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { userPublicKey } = req.params;
      if (!ensureOwnerOrAdmin(req, res, userPublicKey)) return;

      const grantId = crypto.randomUUID();
      const ttl = Number(req.body.ttlSeconds || 86400);
      await dbService.createConsentGrant({
        id: grantId,
        ownerPublicKey: userPublicKey,
        granteePublicKey: req.body.granteePublicKey,
        scope: req.body.scope,
        recordIds: req.body.recordIds,
        expiresAt: new Date(Date.now() + ttl * 1000),
      });

      res.status(201).json({ success: true, grantId, expiresInSeconds: ttl });
    } catch (error) {
      logger.error('Error creating consent grant:', error);
      res.status(500).json({ error: 'Failed to create selective disclosure grant' });
    }
  }
);

// POST /api/credit-score/:userPublicKey/consent/:grantId/revoke
router.post('/:userPublicKey/consent/:grantId/revoke', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userPublicKey, grantId } = req.params;
    if (!ensureOwnerOrAdmin(req, res, userPublicKey)) return;
    const revoked = await dbService.revokeConsentGrant(grantId, userPublicKey);
    if (!revoked) return res.status(404).json({ error: 'Active consent grant not found' });
    res.json({ success: true, message: 'Consent grant revoked' });
  } catch (error) {
    logger.error('Error revoking consent grant:', error);
    res.status(500).json({ error: 'Failed to revoke consent grant' });
  }
});

// GET /api/credit-score/:userPublicKey/disclose/:grantId — Selective disclosure read by authorized grantee
router.get('/:userPublicKey/disclose/:grantId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userPublicKey, grantId } = req.params;
    const grant = await dbService.getConsentGrant(grantId);
    if (!grant || grant.owner_public_key !== userPublicKey) {
      return res.status(404).json({ error: 'Consent grant not found' });
    }
    if (grant.revoked_at || new Date(grant.expires_at).getTime() <= Date.now()) {
      return res.status(403).json({ error: 'Consent grant expired or revoked' });
    }
    const requester = req.user!.publicKey;
    if (requester !== grant.grantee_public_key && requester !== userPublicKey && !req.user!.isAdmin) {
      return res.status(403).json({ error: 'Requester not authorized by consent grant' });
    }

    const allowedFields = JSON.parse(grant.scope_json) as string[];
    const recordIds = JSON.parse(grant.record_ids_json) as string[];
    const encryptedRows = await dbService.getOwnerEncryptedRecords(userPublicKey, recordIds);

    const disclosed = encryptedRows.map((row) => {
      const decrypted = decryptFinancialRecord({
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.auth_tag,
      });
      return {
        recordId: row.id,
        recordKind: row.record_kind,
        verified: Boolean(row.verified),
        issuerPublicKey: row.issuer_public_key,
        ...filterDisclosedClaims(decrypted, allowedFields, row.record_commitment),
      };
    });

    res.json({ success: true, data: disclosed });
  } catch (error) {
    logger.error('Error reading selectively disclosed records:', error);
    res.status(500).json({ error: 'Failed to disclose financial evidence' });
  }
});

// DELETE /api/credit-score/:userPublicKey/privacy — Off-chain PII/financial erasure policy
router.delete('/:userPublicKey/privacy', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userPublicKey } = req.params;
    if (!ensureOwnerOrAdmin(req, res, userPublicKey)) return;
    const deletedCount = await dbService.deleteOwnerPrivateRecords(userPublicKey);
    await dbService.recordAuditLog({
      actorPublicKey: req.user!.publicKey,
      action: 'private_records_erased',
      resourceType: 'user',
      resourceId: userPublicKey,
      status: 'ok',
      details: { deletedCount },
    });
    res.json({ success: true, deletedRecords: deletedCount });
  } catch (error) {
    logger.error('Error deleting private records:', error);
    res.status(500).json({ error: 'Failed to delete private records' });
  }
});

// GET /api/credit-score/:userPublicKey — Authenticated owner/admin credit score
router.get('/:userPublicKey', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userPublicKey } = req.params;
    if (!ensureOwnerOrAdmin(req, res, userPublicKey)) return;

    const cacheKey = `credit_score:${userPublicKey}`;
    let creditScore = await redisCache.get<any>(cacheKey);

    if (!creditScore) {
      try {
        const result = await stellarService.getScoreBreakdown(userPublicKey);
        if (result.returnValue) {
          const b = result.returnValue;
          creditScore = {
            model_version: Number(b.model_version ?? 2),
            score: Math.max(0, Math.min(100, Number(b.score ?? 0))),
            payment_history_score: Number(b.payment_history_score ?? 0),
            savings_score: Number(b.savings_score ?? 0),
            repayment_score: Number(b.repayment_score ?? 0),
            community_score: Number(b.community_score ?? 0),
            activity_score: Number(b.activity_score ?? 0),
            default_penalty: Number(b.default_penalty ?? 0),
            verified_payment_count: Number(b.verified_payment_count ?? 0),
            verified_savings_count: Number(b.verified_savings_count ?? 0),
            active_vouch_count: Number(b.active_vouch_count ?? 0),
            self_reported_count: Number(b.self_reported_count ?? 0),
            last_updated: Number(b.last_updated ?? 0),
          };
          await dbService.upsertCreditScore({
            publicKey: userPublicKey,
            score: creditScore.score,
            paymentHistoryScore: creditScore.payment_history_score,
            savingsScore: creditScore.savings_score,
            repaymentScore: creditScore.repayment_score,
            communityScore: creditScore.community_score,
            activityScore: creditScore.activity_score,
            modelVersion: creditScore.model_version,
          });
          await redisCache.set(cacheKey, creditScore, 120);
        }
      } catch {
        // Fallback to PostgreSQL cache if RPC unavailable
      }
    }

    if (!creditScore) {
      const dbScore = await dbService.getCachedCreditScore(userPublicKey);
      creditScore = dbScore
        ? {
            model_version: dbScore.model_version ?? 2,
            score: dbScore.score,
            payment_history_score: dbScore.payment_history_score,
            savings_score: dbScore.savings_score,
            repayment_score: dbScore.repayment_score ?? 0,
            community_score: dbScore.community_score,
            activity_score: dbScore.activity_score,
            last_updated: Math.floor(new Date(dbScore.last_updated).getTime() / 1000),
          }
        : {
            model_version: 2,
            score: 0,
            payment_history_score: 0,
            savings_score: 0,
            repayment_score: 0,
            community_score: 0,
            activity_score: 0,
            verified_payment_count: 0,
            verified_savings_count: 0,
            active_vouch_count: 0,
            self_reported_count: 0,
            last_updated: 0,
          };
    }

    res.json({ success: true, data: creditScore });
  } catch (error) {
    logger.error('Error fetching credit score:', error);
    res.status(500).json({ error: 'Failed to fetch credit score' });
  }
});

// GET /api/credit-score/:userPublicKey/records — Owner decrypted records (NEVER unauthenticated)
router.get('/:userPublicKey/records', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userPublicKey } = req.params;
    if (!ensureOwnerOrAdmin(req, res, userPublicKey)) return;

    const encryptedRows = await dbService.getOwnerEncryptedRecords(userPublicKey);
    const records = encryptedRows.map((row) => ({
      id: row.id,
      recordKind: row.record_kind,
      verified: Boolean(row.verified),
      issuerPublicKey: row.issuer_public_key,
      recordCommitment: row.record_commitment,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      details: decryptFinancialRecord({
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.auth_tag,
      }),
    }));

    res.json({ success: true, data: { records, total: records.length } });
  } catch (error) {
    logger.error('Error fetching owner encrypted records:', error);
    res.status(500).json({ error: 'Failed to fetch financial records' });
  }
});

// GET /api/credit-score/:userPublicKey/breakdown
router.get('/:userPublicKey/breakdown', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userPublicKey } = req.params;
    if (!ensureOwnerOrAdmin(req, res, userPublicKey)) return;

    let raw: any = null;
    try {
      const resChain = await stellarService.getScoreBreakdown(userPublicKey);
      raw = resChain.returnValue;
    } catch {
      raw = await dbService.getCachedCreditScore(userPublicKey);
    }

    res.json({
      success: true,
      data: {
        modelVersion: Number(raw?.model_version ?? 2),
        overallScore: Number(raw?.score ?? 0),
        defaultPenalty: Number(raw?.default_penalty ?? 0),
        pillars: {
          paymentHistory: {
            score: Number(raw?.payment_history_score ?? 0),
            weightPct: Number(raw?.weight_payment ?? 35),
            verifiedCount: Number(raw?.verified_payment_count ?? 0),
          },
          savings: {
            score: Number(raw?.savings_score ?? 0),
            weightPct: Number(raw?.weight_savings ?? 25),
            verifiedCount: Number(raw?.verified_savings_count ?? 0),
          },
          repayment: {
            score: Number(raw?.repayment_score ?? 0),
            weightPct: Number(raw?.weight_repayment ?? 20),
            repaidLoans: Number(raw?.repaid_loans ?? 0),
            defaultedLoans: Number(raw?.defaulted_loans ?? 0),
          },
          community: {
            score: Number(raw?.community_score ?? 0),
            weightPct: Number(raw?.weight_community ?? 10),
            activeVouches: Number(raw?.active_vouch_count ?? 0),
          },
          activity: {
            score: Number(raw?.activity_score ?? 0),
            weightPct: Number(raw?.weight_activity ?? 10),
          },
        },
        supplementary: {
          selfReportedCount: Number(raw?.self_reported_count ?? 0),
          weightPct: 0,
        },
      },
    });
  } catch (error) {
    logger.error('Error fetching breakdown:', error);
    res.status(500).json({ error: 'Failed to fetch credit score breakdown' });
  }
});

// GET /api/credit-score/:userPublicKey/trends — Real recorded snapshots (no fabricated synthetic math)
router.get('/:userPublicKey/trends', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userPublicKey } = req.params;
    if (!ensureOwnerOrAdmin(req, res, userPublicKey)) return;

    const history = await dbService.getScoreHistory(userPublicKey, 30);
    const ordered = [...history].sort(
      (a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime()
    );
    const currentScore = ordered.length > 0 ? Number(ordered[ordered.length - 1].score) : 0;
    const previousScore = ordered.length > 1 ? Number(ordered[ordered.length - 2].score) : currentScore;

    res.json({
      success: true,
      data: {
        currentScore,
        previousScore,
        change: currentScore - previousScore,
        snapshots: ordered.map((row) => ({
          date: new Date(row.recorded_at).toISOString(),
          score: Number(row.score),
          modelVersion: Number(row.model_version ?? 2),
        })),
      },
    });
  } catch (error) {
    logger.error('Error fetching credit score trends:', error);
    res.status(500).json({ error: 'Failed to fetch credit score trends' });
  }
});

// POST /api/credit-score/issuer/sign-demo-attestation (Issuer / Admin role helper)
router.post(
  '/issuer/build-message',
  authMiddleware,
  requireRoles('issuer', 'admin'),
  [
    body('subjectPublicKey').isString().isLength({ min: 56, max: 56 }),
    body('issuerPublicKey').isString().isLength({ min: 56, max: 56 }),
    body('kind').isInt({ min: 1, max: 2 }),
    body('metricScore').isInt({ min: 0, max: 100 }),
    body('amount').notEmpty(),
    body('durationMonths').isInt({ min: 0, max: 120 }),
    body('expiresInDays').optional().isInt({ min: 1, max: 3650 }),
    body('financialData').isObject(),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const contracts = await stellarService.getContractAddresses();
      if (!contracts.creditScore) {
        return res.status(503).json({ error: 'CreditScore contract address is not configured' });
      }
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = now + Number(req.body.expiresInDays || 180) * 86400;
      const attestationIdHex = crypto.randomBytes(32).toString('hex');
      const recordCommitmentHex = computeRecordCommitment(req.body.financialData);
      const amountUnits = parseDecimalToStroops(req.body.amount);
      const input: AttestationPayloadInput = {
        attestationIdHex,
        subjectPublicKey: req.body.subjectPublicKey,
        kind: Number(req.body.kind),
        recordCommitmentHex,
        metricScore: Number(req.body.metricScore),
        amountUnits,
        durationMonths: Number(req.body.durationMonths),
        issuedAt: now,
        expiresAt,
      };
      const message = stellarService.buildAttestationSigningMessage(
        contracts.creditScore,
        req.body.issuerPublicKey,
        input
      );
      res.json({
        success: true,
        attestationInput: input,
        signingMessageHex: message.toString('hex'),
      });
    } catch (error) {
      logger.error('Error building attestation signing payload:', error);
      res.status(500).json({ error: 'Failed to build attestation payload' });
    }
  }
);

export { router as creditScoreRoutes };
