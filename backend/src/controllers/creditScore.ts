import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { stellarService } from '../services/stellarService';
import { redisCache } from '../config/redis';
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

// Update payment history
router.post('/payment-history', authMiddleware, paymentHistoryValidation, async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { userPublicKey, payments } = req.body;

    // Check if user is authorized to update this data
    if (req.user?.publicKey !== userPublicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to update payment history for this user' });
    }

    // Submit transaction to Stellar
    const result = await stellarService.updatePaymentHistory(userPublicKey, payments);

    // Cache the result
    await redisCache.set(`credit_score:payment_history:${userPublicKey}`, payments, 300);

    logger.info(`Payment history updated for user ${userPublicKey}`);

    res.json({
      success: true,
      transactionHash: result.hash,
      message: 'Payment history updated successfully'
    });
  } catch (error) {
    logger.error('Error updating payment history:', error);
    res.status(500).json({ error: 'Failed to update payment history' });
  }
});

// Update savings data
router.post('/savings-data', authMiddleware, savingsDataValidation, async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { userPublicKey, amount, timestamp, durationMonths, regularityScore } = req.body;

    // Check authorization
    if (req.user?.publicKey !== userPublicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to update savings data for this user' });
    }

    const savingsData = {
      amount,
      timestamp,
      durationMonths,
      regularityScore,
    };

    // Submit transaction to Stellar
    const result = await stellarService.updateSavingsData(userPublicKey, savingsData);

    // Update cache
    const cacheKey = `credit_score:savings:${userPublicKey}`;
    const existingSavings = await redisCache.get(cacheKey) || [];
    existingSavings.push(savingsData);
    await redisCache.set(cacheKey, existingSavings, 300);

    logger.info(`Savings data updated for user ${userPublicKey}`);

    res.json({
      success: true,
      transactionHash: result.hash,
      message: 'Savings data updated successfully'
    });
  } catch (error) {
    logger.error('Error updating savings data:', error);
    res.status(500).json({ error: 'Failed to update savings data' });
  }
});

// Get credit score
router.get('/:userPublicKey', async (req: Request, res: Response) => {
  try {
    const { userPublicKey } = req.params;

    // Check cache first
    const cacheKey = `credit_score:${userPublicKey}`;
    let creditScore = await redisCache.get(cacheKey);

    if (!creditScore) {
      // Fetch from blockchain
      const result = await stellarService.getCreditScore(userPublicKey);
      creditScore = result.returnValue;

      // Cache for 5 minutes
      await redisCache.set(cacheKey, creditScore, 300);
    }

    res.json({
      success: true,
      data: creditScore
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

    // Check cache first
    const cacheKey = `credit_score:payment_history:${userPublicKey}`;
    let paymentHistory = await redisCache.get(cacheKey);

    if (!paymentHistory) {
      // For now, return empty array
      // In a real implementation, this would fetch from the blockchain
      paymentHistory = [];
    }

    // Apply pagination
    const startIndex = parseInt(offset as string);
    const endIndex = startIndex + parseInt(limit as string);
    const paginatedHistory = paymentHistory.slice(startIndex, endIndex);

    res.json({
      success: true,
      data: {
        paymentHistory: paginatedHistory,
        total: paymentHistory.length,
        limit: parseInt(limit as string),
        offset: startIndex,
      }
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

    // Check cache first
    const cacheKey = `credit_score:savings:${userPublicKey}`;
    let savingsData = await redisCache.get(cacheKey);

    if (!savingsData) {
      // For now, return empty array
      // In a real implementation, this would fetch from the blockchain
      savingsData = [];
    }

    // Apply pagination
    const startIndex = parseInt(offset as string);
    const endIndex = startIndex + parseInt(limit as string);
    const paginatedSavings = savingsData.slice(startIndex, endIndex);

    res.json({
      success: true,
      data: {
        savingsData: paginatedSavings,
        total: savingsData.length,
        limit: parseInt(limit as string),
        offset: startIndex,
      }
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

    // Get credit score
    const creditScoreResult = await stellarService.getCreditScore(userPublicKey);
    const creditScore = creditScoreResult.returnValue;

    // Get additional data for breakdown
    const [paymentHistory, savingsData] = await Promise.all([
      redisCache.get(`credit_score:payment_history:${userPublicKey}`) || [],
      redisCache.get(`credit_score:savings:${userPublicKey}`) || [],
    ]);

    // Calculate breakdown
    const breakdown = {
      paymentHistory: {
        score: creditScore.payment_history_score || 0,
        count: paymentHistory.length,
        totalAmount: paymentHistory.reduce((sum: number, payment: any) => sum + parseFloat(payment.amount), 0),
        averageConsistency: paymentHistory.length > 0 
          ? paymentHistory.reduce((sum: number, payment: any) => sum + payment.consistencyScore, 0) / paymentHistory.length 
          : 0,
      },
      savings: {
        score: creditScore.savings_score || 0,
        count: savingsData.length,
        totalAmount: savingsData.reduce((sum: number, savings: any) => sum + parseFloat(savings.amount), 0),
        averageDuration: savingsData.length > 0 
          ? savingsData.reduce((sum: number, savings: any) => sum + savings.durationMonths, 0) / savingsData.length 
          : 0,
      },
      community: {
        score: creditScore.community_score || 0,
      },
      activity: {
        score: creditScore.activity_score || 0,
      },
      overall: {
        score: creditScore.score || 0,
        lastUpdated: creditScore.last_updated || 0,
      },
    };

    res.json({
      success: true,
      data: breakdown
    });
  } catch (error) {
    logger.error('Error fetching credit score breakdown:', error);
    res.status(500).json({ error: 'Failed to fetch credit score breakdown' });
  }
});

// Get credit score trends
router.get('/:userPublicKey/trends', async (req: Request, res: Response) => {
  try {
    const { userPublicKey } = req.params;
    const { period = '30d' } = req.query;

    // For now, return mock trend data
    // In a real implementation, this would analyze historical data
    const trends = {
      period,
      currentScore: 750,
      previousScore: 720,
      change: 30,
      changePercent: 4.17,
      dailyScores: [
        { date: '2024-01-01', score: 700 },
        { date: '2024-01-02', score: 705 },
        { date: '2024-01-03', score: 710 },
        // ... more daily data
      ],
    };

    res.json({
      success: true,
      data: trends
    });
  } catch (error) {
    logger.error('Error fetching credit score trends:', error);
    res.status(500).json({ error: 'Failed to fetch credit score trends' });
  }
});

export { router as creditScoreRoutes };
