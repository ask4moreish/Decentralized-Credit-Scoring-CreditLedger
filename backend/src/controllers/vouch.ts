import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { stellarService } from '../services/stellarService';
import { redisCache } from '../config/redis';
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

// POST /api/vouch/create
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
      amount,
      trustScore,
      reason,
      durationMonths
    );

    // Invalidate cached vouches for vouchee
    await redisCache.del(`vouches:user:${voucheePublicKey}`);

    logger.info(`Vouch created by ${voucherPublicKey} for ${voucheePublicKey}`);
    res.json({ success: true, transactionHash: result.hash, message: 'Vouch created successfully' });
  } catch (error) {
    logger.error('Error creating vouch:', error);
    res.status(500).json({ error: 'Failed to create vouch' });
  }
});

// POST /api/vouch/:vouchId/revoke
router.post('/:vouchId/revoke', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { vouchId } = req.params;
    const { voucherPublicKey } = req.body;

    if (req.user?.publicKey !== voucherPublicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to revoke this vouch' });
    }

    const result = await stellarService.revokeVouch(voucherPublicKey, parseInt(vouchId));

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

    const cacheKey = `vouches:user:${userPublicKey}`;
    let vouches = await redisCache.get(cacheKey);

    if (!vouches) {
      const result = await stellarService.getUserVouches(userPublicKey);
      vouches = result.returnValue;
      await redisCache.set(cacheKey, vouches, 300);
    }

    res.json({ success: true, data: vouches });
  } catch (error) {
    logger.error('Error fetching user vouches:', error);
    res.status(500).json({ error: 'Failed to fetch user vouches' });
  }
});

export { router as vouchRoutes };
