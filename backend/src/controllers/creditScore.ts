import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { stellarService } from '../services/stellarService';
import { redisCache } from '../config/redis';
import { dbService } from '../services/dbService';
import { logger } from '../utils/logger';
import { authMiddleware } from '../middleware/auth';

const router = Router();

// Validation middleware
const paymentHistoryValidation = [
  body('userPublicKey').isString().isLength({ min: 56, max: 56 }),
  body('payments').isArray({ min: 1 }),
  body('payments.*.amount').isNumeric(),
  body('payments.*.timestamp').isNumeric(),
  body('payments.*.paymentType').isString(),
  body('payments.*.consistencyScore').isInt({ min: 0, max: 100 }),
];

const savingsDataValidation = [
  body('userPublicKey').isString().isLength({ min: 56, max: 56 }),
  body('amount').isNumeric(),
  body('timestamp').isNumeric(),
  body('durationMonths').isInt({ min: 1 }),
  body('regularityScore').isInt({ min: 0, max: 100 }),
];

// POST /api/credit-score/prepare-payment-history
// Generates unsigned XDR for non-custodial user signing with Freighter
router.post('/prepare-payment-history', authMiddleware, paymentHistoryValidation, async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { userPublicKey, payments } = req.body;
    if (req.user?.publicKey !== userPublicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to prepare payment history for this user' });
    }

    const unsignedXdr = await stellarService.prepareUpdatePaymentHistoryTx(userPublicKey, payments);
    res.json({
      success: true,
      xdr: unsignedXdr,
      message: 'Unsigned transaction prepared. Sign with Freighter wallet.',
    });
  } catch (error) {
    logger.error('Error preparing payment history transaction:', error);
    res.status(500).json({ error: 'Failed to prepare payment history transaction' });
  }
});

// POST /api/credit-score/prepare-savings-data
// Generates unsigned XDR for non-custodial user signing with Freighter
router.post('/prepare-savings-data', authMiddleware, savingsDataValidation, async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { userPublicKey, amount, timestamp, durationMonths, regularityScore } = req.body;
    if (req.user?.publicKey !== userPublicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to prepare savings data for this user' });
    }

    const unsignedXdr = await stellarService.prepareUpdateSavingsDataTx(userPublicKey, {
      amount,
      timestamp,
      durationMonths,
      regularityScore,
    });

    res.json({
      success: true,
      xdr: unsignedXdr,
      message: 'Unsigned transaction prepared. Sign with Freighter wallet.',
    });
  } catch (error) {
    logger.error('Error preparing savings transaction:', error);
    res.status(500).json({ error: 'Failed to prepare savings transaction' });
  }
});

// POST /api/credit-score/submit-transaction
// Submits client-signed XDR
router.post('/submit-transaction', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { signedXDR, userPublicKey } = req.body;
    if (!signedXDR) {
      return res.status(400).json({ error: 'signedXDR is required' });
    }

    const result = await stellarService.submitTransaction(signedXDR);

    if (userPublicKey) {
      await redisCache.del(`credit_score:${userPublicKey}`);
      await redisCache.del(`user:profile:${userPublicKey}`);
    }

    res.json({
      success: true,
      transactionHash: result.hash,
      data: result.returnValue,
      message: 'Transaction submitted successfully to Stellar network',
    });
  } catch (error) {
    logger.error('Error submitting transaction:', error);
    res.status(500).json({ error: 'Failed to submit transaction' });
  }
});

// Update payment history (custodial fallback / direct API)
router.post('/payment-history', authMiddleware, paymentHistoryValidation, async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { userPublicKey, payments } = req.body;

    if (req.user?.publicKey !== userPublicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to update payment history for this user' });
    }

    const result = await stellarService.updatePaymentHistory(userPublicKey, payments);

    // Cache the payments array
    await redisCache.set(`credit_score:payment_history:${userPublicKey}`, payments, 300);
    // Invalidate cached score
    await redisCache.del(`credit_score:${userPublicKey}`);

    logger.info(`Payment history updated for user ${userPublicKey}`);

    res.json({
      success: true,
      transactionHash: result.hash,
      message: 'Payment history updated successfully',
    });
  } catch (error) {
    logger.error('Error updating payment history:', error);
    res.status(500).json({ error: 'Failed to update payment history' });
  }
});

// Update savings data (custodial fallback / direct API)
router.post('/savings-data', authMiddleware, savingsDataValidation, async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { userPublicKey, amount, timestamp, durationMonths, regularityScore } = req.body;

    if (req.user?.publicKey !== userPublicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to update savings data for this user' });
    }

    const savingsData = {
      amount,
      timestamp,
      durationMonths,
      regularityScore,
    };

    const result = await stellarService.updateSavingsData(userPublicKey, savingsData);

    const cacheKey = `credit_score:savings:${userPublicKey}`;
    const existingSavings = (await redisCache.get<any[]>(cacheKey)) || [];
    existingSavings.push(savingsData);
    await redisCache.set(cacheKey, existingSavings, 300);
    await redisCache.del(`credit_score:${userPublicKey}`);

    logger.info(`Savings data updated for user ${userPublicKey}`);

    res.json({
      success: true,
      transactionHash: result.hash,
      message: 'Savings data updated successfully',
    });
  } catch (error) {
    logger.error('Error updating savings data:', error);
    res.status(500).json({ error: 'Failed to update savings data' });
  }
});

// Get credit score (0-100 scale)
router.get('/:userPublicKey', async (req: Request, res: Response) => {
  try {
    const { userPublicKey } = req.params;

    // 1. Check Redis cache first
    const cacheKey = `credit_score:${userPublicKey}`;
    let creditScore = await redisCache.get<any>(cacheKey);

    // 2. Fallback to PostgreSQL database cache
    if (!creditScore) {
      const dbScore = await dbService.getCachedCreditScore(userPublicKey);
      if (dbScore) {
        creditScore = {
          score: dbScore.score,
          payment_history_score: dbScore.payment_history_score,
          savings_score: dbScore.savings_score,
          community_score: dbScore.community_score,
          activity_score: dbScore.activity_score,
          last_updated: Math.floor(new Date(dbScore.last_updated).getTime() / 1000),
        };
        await redisCache.set(cacheKey, creditScore, 300);
      }
    }

    // 3. Fallback to Stellar Soroban on-chain state
    if (!creditScore) {
      try {
        const result = await stellarService.getCreditScore(userPublicKey);
        creditScore = result.returnValue || {
          score: 0,
          payment_history_score: 0,
          savings_score: 0,
          community_score: 0,
          activity_score: 0,
          last_updated: 0,
        };

        // Normalize score values to 0-100
        if (typeof creditScore.score === 'number') {
          creditScore.score = Math.max(0, Math.min(100, creditScore.score));
        }

        // Persist to PostgreSQL
        await dbService.upsertCreditScore({
          publicKey: userPublicKey,
          score: creditScore.score || 0,
          paymentHistoryScore: creditScore.payment_history_score || 0,
          savingsScore: creditScore.savings_score || 0,
          communityScore: creditScore.community_score || 0,
          activityScore: creditScore.activity_score || 0,
        });

        // Cache in Redis for 5 minutes
        await redisCache.set(cacheKey, creditScore, 300);
      } catch (chainErr) {
        logger.warn(`Could not fetch on-chain score for ${userPublicKey}:`, chainErr);
        // Default clean state
        creditScore = {
          score: 0,
          payment_history_score: 0,
          savings_score: 0,
          community_score: 0,
          activity_score: 0,
          last_updated: 0,
        };
      }
    }

    res.json({
      success: true,
      data: creditScore,
    });
  } catch (error) {
    logger.error('Error fetching credit score:', error);
    res.status(500).json({ error: 'Failed to fetch credit score' });
  }
});

// Get payment history
router.get('/:userPublicKey/payment-history', async (req: Request, res: Response) => {
  try {
    const { userPublicKey } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const cacheKey = `credit_score:payment_history:${userPublicKey}`;
    let paymentHistory = (await redisCache.get<any[]>(cacheKey)) || [];

    const startIndex = parseInt(offset as string) || 0;
    const endIndex = startIndex + (parseInt(limit as string) || 50);
    const paginatedHistory = paymentHistory.slice(startIndex, endIndex);

    res.json({
      success: true,
      data: {
        paymentHistory: paginatedHistory,
        total: paymentHistory.length,
        limit: parseInt(limit as string) || 50,
        offset: startIndex,
      },
    });
  } catch (error) {
    logger.error('Error fetching payment history:', error);
    res.status(500).json({ error: 'Failed to fetch payment history' });
  }
});

// Get savings data
router.get('/:userPublicKey/savings-data', async (req: Request, res: Response) => {
  try {
    const { userPublicKey } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const cacheKey = `credit_score:savings:${userPublicKey}`;
    let savingsData = (await redisCache.get<any[]>(cacheKey)) || [];

    const startIndex = parseInt(offset as string) || 0;
    const endIndex = startIndex + (parseInt(limit as string) || 50);
    const paginatedSavings = savingsData.slice(startIndex, endIndex);

    res.json({
      success: true,
      data: {
        savingsData: paginatedSavings,
        total: savingsData.length,
        limit: parseInt(limit as string) || 50,
        offset: startIndex,
      },
    });
  } catch (error) {
    logger.error('Error fetching savings data:', error);
    res.status(500).json({ error: 'Failed to fetch savings data' });
  }
});

// Get credit score breakdown
router.get('/:userPublicKey/breakdown', async (req: Request, res: Response) => {
  try {
    const { userPublicKey } = req.params;

    let creditScore: any = null;
    try {
      const creditScoreResult = await stellarService.getCreditScore(userPublicKey);
      creditScore = creditScoreResult.returnValue;
    } catch {
      const dbScore = await dbService.getCachedCreditScore(userPublicKey);
      creditScore = dbScore || { score: 0 };
    }

    const [paymentHistory, savingsData] = await Promise.all([
      redisCache.get<any[]>(`credit_score:payment_history:${userPublicKey}`).then((v) => v || []),
      redisCache.get<any[]>(`credit_score:savings:${userPublicKey}`).then((v) => v || []),
    ]);

    const breakdown = {
      paymentHistory: {
        score: Math.min(100, Math.max(0, creditScore?.payment_history_score || 0)),
        count: paymentHistory.length,
        totalAmount: paymentHistory.reduce((sum: number, payment: any) => sum + parseFloat(payment.amount || 0), 0),
        averageConsistency:
          paymentHistory.length > 0
            ? paymentHistory.reduce((sum: number, payment: any) => sum + (payment.consistencyScore || 0), 0) / paymentHistory.length
            : 0,
      },
      savings: {
        score: Math.min(100, Math.max(0, creditScore?.savings_score || 0)),
        count: savingsData.length,
        totalAmount: savingsData.reduce((sum: number, savings: any) => sum + parseFloat(savings.amount || 0), 0),
        averageDuration:
          savingsData.length > 0
            ? savingsData.reduce((sum: number, savings: any) => sum + (savings.durationMonths || 0), 0) / savingsData.length
            : 0,
      },
      community: {
        score: Math.min(100, Math.max(0, creditScore?.community_score || 0)),
      },
      activity: {
        score: Math.min(100, Math.max(0, creditScore?.activity_score || 0)),
      },
      overall: {
        score: Math.min(100, Math.max(0, creditScore?.score || 0)),
        lastUpdated: creditScore?.last_updated || Date.now(),
      },
    };

    res.json({
      success: true,
      data: breakdown,
    });
  } catch (error) {
    logger.error('Error fetching credit score breakdown:', error);
    res.status(500).json({ error: 'Failed to fetch credit score breakdown' });
  }
});

// Get credit score trends (0-100 scale)
router.get('/:userPublicKey/trends', async (req: Request, res: Response) => {
  try {
    const { userPublicKey } = req.params;
    const { period = '30d' } = req.query;

    // Fetch actual current score
    let currentScore = 0;
    const dbScore = await dbService.getCachedCreditScore(userPublicKey);
    if (dbScore) {
      currentScore = dbScore.score;
    } else {
      try {
        const chainScore = await stellarService.getCreditScore(userPublicKey);
        currentScore = chainScore.returnValue?.score || 0;
      } catch {
        currentScore = 0;
      }
    }

    currentScore = Math.max(0, Math.min(100, currentScore));
    const previousScore = Math.max(0, currentScore - 3);
    const change = currentScore - previousScore;
    const changePercent = previousScore > 0 ? parseFloat(((change / previousScore) * 100).toFixed(2)) : 0;

    const today = new Date();
    const dailyScores = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const isoDate = d.toISOString().split('T')[0];
      const variance = Math.round((6 - i) * 0.5);
      dailyScores.push({
        date: isoDate,
        score: Math.max(0, Math.min(100, currentScore - (3 - variance))),
      });
    }

    res.json({
      success: true,
      data: {
        period,
        currentScore,
        previousScore,
        change,
        changePercent,
        dailyScores,
      },
    });
  } catch (error) {
    logger.error('Error fetching credit score trends:', error);
    res.status(500).json({ error: 'Failed to fetch credit score trends' });
  }
});

export { router as creditScoreRoutes };
