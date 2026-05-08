import { Router, Request, Response } from 'express';
import { stellarService } from '../services/stellarService';
import { redisCache } from '../config/redis';
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
      const [creditScoreResult, accountInfo] = await Promise.all([
        stellarService.getCreditScore(publicKey),
        stellarService.getAccount(publicKey).catch(() => null),
      ]);

      profile = {
        publicKey,
        creditScore: creditScoreResult.returnValue,
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

    const [creditScoreResult, loansResult, vouchesResult] = await Promise.all([
      stellarService.getCreditScore(publicKey),
      stellarService.getUserLoans(publicKey),
      stellarService.getUserVouches(publicKey),
    ]);

    res.json({
      success: true,
      data: {
        publicKey,
        creditScore: creditScoreResult.returnValue,
        loans: loansResult.returnValue,
        vouches: vouchesResult.returnValue,
      },
    });
  } catch (error) {
    logger.error('Error fetching user summary:', error);
    res.status(500).json({ error: 'Failed to fetch user summary' });
  }
});

export { router as userRoutes };
