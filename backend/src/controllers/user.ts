import { Router, Request, Response } from 'express';
import { stellarService } from '../services/stellarService';
import { redisCache } from '../config/redis';
import { dbService } from '../services/dbService';
import { logger } from '../utils/logger';
import { authMiddleware } from '../middleware/auth';

const router = Router();

router.get('/:publicKey/profile', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { publicKey } = req.params;
    if (req.user?.publicKey !== publicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const cacheKey = `user:profile:${publicKey}`;
    let profile = await redisCache.get(cacheKey);
    if (!profile) {
      let creditScore: any = null;
      let accountExists = false;
      try {
        const creditScoreResult = await stellarService.getScoreBreakdown(publicKey);
        creditScore = creditScoreResult.returnValue;
      } catch {
        creditScore = await dbService.getCachedCreditScore(publicKey);
      }
      try {
        await stellarService.getAccount(publicKey);
        accountExists = true;
      } catch {
        accountExists = false;
      }
      await dbService.upsertUser(publicKey, req.user?.role || 'borrower');
      profile = {
        publicKey,
        role: req.user?.role || 'borrower',
        creditScore: creditScore || { score: 0 },
        accountExists,
      };
      await redisCache.set(cacheKey, profile, 120);
    }
    res.json({ success: true, data: profile });
  } catch (error) {
    logger.error('Error fetching user profile:', error);
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

router.get('/:publicKey/summary', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { publicKey } = req.params;
    if (req.user?.publicKey !== publicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    const [creditScore, loans, vouches] = await Promise.all([
      stellarService
        .getScoreBreakdown(publicKey)
        .then((r) => r.returnValue)
        .catch(() => dbService.getCachedCreditScore(publicKey)),
      dbService.getUserLoans(publicKey),
      dbService.getUserVouches(publicKey),
    ]);
    res.json({
      success: true,
      data: {
        publicKey,
        role: req.user?.role || 'borrower',
        creditScore: creditScore || { score: 0 },
        loans,
        vouches,
      },
    });
  } catch (error) {
    logger.error('Error fetching user summary:', error);
    res.status(500).json({ error: 'Failed to fetch user summary' });
  }
});

export { router as userRoutes };
