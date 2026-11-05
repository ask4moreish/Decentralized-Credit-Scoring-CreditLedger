import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { stellarService } from '../services/stellarService';
import { redisCache } from '../config/redis';
import { dbService } from '../services/dbService';
import { logger } from '../utils/logger';
import { authMiddleware } from '../middleware/auth';

const router = Router();

const createVouchValidation = [
  body('voucherPublicKey').isString().isLength({ min: 56, max: 56 }),
  body('voucheePublicKey').isString().isLength({ min: 56, max: 56 }),
  body('amount').isNumeric().isFloat({ min: 0.01 }),
  body('trustScore').isInt({ min: 0, max: 100 }),
  body('reason').isString().isLength({ min: 1, max: 500 }),
  body('durationMonths').isInt({ min: 1, max: 60 }),
];

// POST /api/vouch/prepare-create
// Generates unsigned transaction XDR for non-custodial vouch creation via Freighter
router.post('/prepare-create', authMiddleware, createVouchValidation, async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { voucherPublicKey, voucheePublicKey, amount, trustScore, reason, durationMonths } = req.body;

    if (req.user?.publicKey !== voucherPublicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to create vouch for this user' });
    }

    const unsignedXdr = await stellarService.prepareCreateVouchTx(
      voucherPublicKey,
      voucheePublicKey,
      amount.toString(),
      trustScore,
      reason,
      durationMonths
    );

    res.json({
      success: true,
      xdr: unsignedXdr,
      message: 'Unsigned vouch transaction prepared. Sign with Freighter wallet.',
    });
  } catch (error) {
    logger.error('Error preparing vouch transaction:', error);
    res.status(500).json({ error: 'Failed to prepare vouch transaction' });
  }
});

// POST /api/vouch/prepare-revoke
// Generates unsigned transaction XDR for non-custodial vouch revocation via Freighter
router.post('/:vouchId/prepare-revoke', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { vouchId } = req.params;
    const { voucherPublicKey } = req.body;

    if (req.user?.publicKey !== voucherPublicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to revoke this vouch' });
    }

    const unsignedXdr = await stellarService.prepareRevokeVouchTx(voucherPublicKey, parseInt(vouchId));

    res.json({
      success: true,
      xdr: unsignedXdr,
      message: 'Unsigned revoke vouch transaction prepared. Sign with Freighter wallet.',
    });
  } catch (error) {
    logger.error('Error preparing revoke vouch transaction:', error);
    res.status(500).json({ error: 'Failed to prepare revoke vouch transaction' });
  }
});

// POST /api/vouch/submit
// Submits a signed vouch transaction XDR
router.post('/submit', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { signedXDR, voucherPublicKey, voucheePublicKey, vouchId, action } = req.body;
    if (!signedXDR) {
      return res.status(400).json({ error: 'signedXDR is required' });
    }

    const result = await stellarService.submitTransaction(signedXDR);

    if (action === 'create' && result.returnValue) {
      const newVouchId = result.returnValue;
      await dbService.upsertVouch({
        id: newVouchId,
        voucherKey: voucherPublicKey || req.user?.publicKey || '',
        voucheeKey: voucheePublicKey || '',
        amount: req.body.amount || 0,
        trustScore: req.body.trustScore || 80,
        reason: req.body.reason || '',
        isActive: true,
      });
    } else if (action === 'revoke' && vouchId) {
      await dbService.updateVouchStatus(vouchId, false);
    }

    if (voucheePublicKey) {
      await redisCache.del(`vouches:user:${voucheePublicKey}`);
      await redisCache.del(`credit_score:${voucheePublicKey}`);
    }
    if (voucherPublicKey) {
      await redisCache.del(`vouches:user:${voucherPublicKey}`);
    }

    res.json({
      success: true,
      transactionHash: result.hash,
      data: result.returnValue,
      message: 'Transaction submitted successfully to Stellar network',
    });
  } catch (error) {
    logger.error('Error submitting vouch transaction:', error);
    res.status(500).json({ error: 'Failed to submit vouch transaction' });
  }
});

// POST /api/vouch/create
// Custodial / direct creation fallback
router.post('/create', authMiddleware, createVouchValidation, async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { voucherPublicKey, voucheePublicKey, amount, trustScore, reason, durationMonths } = req.body;

    if (req.user?.publicKey !== voucherPublicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to create vouch for this user' });
    }

    const result = await stellarService.createVouch(
      voucherPublicKey,
      voucheePublicKey,
      amount.toString(),
      trustScore,
      reason,
      durationMonths
    );

    const vouchId = result.returnValue || Date.now();

    // Persist to PostgreSQL
    await dbService.upsertVouch({
      id: vouchId,
      voucherKey: voucherPublicKey,
      voucheeKey: voucheePublicKey,
      amount,
      trustScore,
      reason,
      isActive: true,
    });

    // Invalidate cached vouches and credit scores
    await redisCache.del(`vouches:user:${voucheePublicKey}`);
    await redisCache.del(`vouches:user:${voucherPublicKey}`);
    await redisCache.del(`credit_score:${voucheePublicKey}`);

    logger.info(`Vouch created by ${voucherPublicKey} for ${voucheePublicKey}`);
    res.json({ success: true, transactionHash: result.hash, message: 'Vouch created successfully' });
  } catch (error) {
    logger.error('Error creating vouch:', error);
    res.status(500).json({ error: 'Failed to create vouch' });
  }
});

// POST /api/vouch/:vouchId/revoke
// Custodial / direct revocation fallback
router.post('/:vouchId/revoke', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { vouchId } = req.params;
    const { voucherPublicKey } = req.body;

    if (req.user?.publicKey !== voucherPublicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to revoke this vouch' });
    }

    const result = await stellarService.revokeVouch(voucherPublicKey, parseInt(vouchId));

    // Update in PostgreSQL
    await dbService.updateVouchStatus(vouchId, false);

    // Invalidate Redis caches
    await redisCache.del(`vouches:user:${voucherPublicKey}`);

    logger.info(`Vouch ${vouchId} revoked by ${voucherPublicKey}`);
    res.json({ success: true, transactionHash: result.hash, message: 'Vouch revoked successfully' });
  } catch (error) {
    logger.error('Error revoking vouch:', error);
    res.status(500).json({ error: 'Failed to revoke vouch' });
  }
});

// GET /api/vouch/user/:userPublicKey
router.get('/user/:userPublicKey', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userPublicKey } = req.params;

    if (req.user?.publicKey !== userPublicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to view vouches for this user' });
    }

    // 1. Check Redis cache
    const cacheKey = `vouches:user:${userPublicKey}`;
    let vouches = await redisCache.get(cacheKey);

    // 2. Fallback to PostgreSQL
    if (!vouches) {
      const dbVouches = await dbService.getUserVouches(userPublicKey);
      if (dbVouches.length > 0) {
        vouches = dbVouches;
        await redisCache.set(cacheKey, vouches, 300);
      }
    }

    // 3. Fallback to blockchain
    if (!vouches) {
      try {
        const result = await stellarService.getUserVouches(userPublicKey);
        vouches = result.returnValue || [];
        await redisCache.set(cacheKey, vouches, 300);
      } catch (err) {
        logger.warn(`Could not load vouches from chain for ${userPublicKey}:`, err);
        vouches = [];
      }
    }

    res.json({ success: true, data: vouches });
  } catch (error) {
    logger.error('Error fetching user vouches:', error);
    res.status(500).json({ error: 'Failed to fetch user vouches' });
  }
});

export { router as vouchRoutes };
