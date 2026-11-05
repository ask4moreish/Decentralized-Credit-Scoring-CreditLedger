import { Router, Request, Response } from 'express';
import { stellarService } from '../services/stellarService';
import { redisCache } from '../config/redis';
import { dbService } from '../services/dbService';
import { logger } from '../utils/logger';
import { authMiddleware } from '../middleware/auth';

const router = Router();

// GET /api/users/:publicKey/profile
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
      let accountInfo: any = null;

      try {
        const creditScoreResult = await stellarService.getCreditScore(publicKey);
        creditScore = creditScoreResult.returnValue;
      } catch {
        creditScore = await dbService.getCachedCreditScore(publicKey);
      }

      try {
        accountInfo = await stellarService.getAccount(publicKey);
      } catch {
        accountInfo = null;
      }

      await dbService.upsertUser(publicKey);

      profile = {
        publicKey,
        creditScore: creditScore || { score: 0 },
        accountExists: accountInfo !== null,
      };

      await redisCache.set(cacheKey, profile, 300);
    }

    res.json({ success: true, data: profile });
  } catch (error) {
    logger.error('Error fetching user profile:', error);
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

// GET /api/users/:publicKey/summary
router.get('/:publicKey/summary', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { publicKey } = req.params;

    if (req.user?.publicKey !== publicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    let creditScore: any = { score: 0 };
    let loans: any[] = [];
    let vouches: any[] = [];

    try {
      const creditScoreResult = await stellarService.getCreditScore(publicKey);
      creditScore = creditScoreResult.returnValue || { score: 0 };
    } catch {
      creditScore = await dbService.getCachedCreditScore(publicKey) || { score: 0 };
    }

    try {
      const loansResult = await stellarService.getUserLoans(publicKey);
      loans = loansResult.returnValue || [];
    } catch {
      loans = await dbService.getUserLoans(publicKey);
    }

    try {
      const vouchesResult = await stellarService.getUserVouches(publicKey);
      vouches = vouchesResult.returnValue || [];
    } catch {
      vouches = await dbService.getUserVouches(publicKey);
    }

    res.json({
      success: true,
      data: {
        publicKey,
        creditScore,
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
