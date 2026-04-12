import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { stellarService } from '../services/stellarService';
import { redisCache } from '../config/redis';
import { logger } from '../utils/logger';
import { authMiddleware } from '../middleware/auth';

const router = Router();

// Validation middleware
const createLoanValidation = [
  body('borrowerPublicKey').isString().isLength({ min: 56, max: 56 }),
  body('amount').isNumeric().isFloat({ min: 0.01 }),
  body('durationMonths').isInt({ min: 1, max: 60 }),
];

const repayLoanValidation = [
  body('loanId').isNumeric(),
  body('amount').isNumeric().isFloat({ min: 0.01 }),
];

// Create loan application
router.post('/apply', authMiddleware, createLoanValidation, async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { borrowerPublicKey, amount, durationMonths } = req.body;

    // Check if user is applying for themselves or is admin
    if (req.user?.publicKey !== borrowerPublicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to create loan for this user' });
    }

    // Check if user is eligible for loan
    const canBorrow = await stellarService.canBorrow(borrowerPublicKey, amount);
    if (!canBorrow) {
      return res.status(400).json({ error: 'User not eligible for loan' });
    }

    // Create loan on blockchain
    const result = await stellarService.createLoan(borrowerPublicKey, amount, durationMonths);

    // Cache loan application
    const loanApplication = {
      id: result.returnValue,
      borrowerPublicKey,
      amount,
      durationMonths,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    await redisCache.set(`loan:application:${result.returnValue}`, loanApplication, 3600);

    logger.info(`Loan application created: ${result.returnValue} for user ${borrowerPublicKey}`);

    res.json({
      success: true,
      data: {
        loanId: result.returnValue,
        transactionHash: result.hash,
        status: 'pending',
        message: 'Loan application submitted successfully'
      }
    });
  } catch (error) {
    logger.error('Error creating loan application:', error);
    res.status(500).json({ error: 'Failed to create loan application' });
  }
});

// Get loan details
router.get('/:loanId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { loanId } = req.params;

    // Check cache first
    const cacheKey = `loan:${loanId}`;
    let loan = await redisCache.get(cacheKey);

    if (!loan) {
      // Fetch from blockchain
      const result = await stellarService.getLoan(parseInt(loanId));
      loan = result.returnValue;

      // Cache for 5 minutes
      await redisCache.set(cacheKey, loan, 300);
    }

    // Check if user is authorized to view this loan
    if (loan.borrower !== req.user?.publicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to view this loan' });
    }

    res.json({
      success: true,
      data: loan
    });
  } catch (error) {
    logger.error('Error fetching loan details:', error);
    res.status(500).json({ error: 'Failed to fetch loan details' });
  }
});

// Get user's loans
router.get('/user/:userPublicKey', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userPublicKey } = req.params;
    const { status = 'all', limit = 10, offset = 0 } = req.query;

    // Check authorization
    if (req.user?.publicKey !== userPublicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to view loans for this user' });
    }

    // Check cache first
    const cacheKey = `loans:user:${userPublicKey}`;
    let userLoans = await redisCache.get(cacheKey);

    if (!userLoans) {
      // Fetch from blockchain
      const result = await stellarService.getUserLoans(userPublicKey);
      userLoans = result.returnValue;

      // Cache for 2 minutes
      await redisCache.set(cacheKey, userLoans, 120);
    }

    // Filter by status if specified
    let filteredLoans = userLoans;
    if (status !== 'all') {
      filteredLoans = userLoans.filter((loan: any) => loan.status === status);
    }

    // Apply pagination
    const startIndex = parseInt(offset as string);
    const endIndex = startIndex + parseInt(limit as string);
    const paginatedLoans = filteredLoans.slice(startIndex, endIndex);

    res.json({
      success: true,
      data: {
        loans: paginatedLoans,
        total: filteredLoans.length,
        limit: parseInt(limit as string),
        offset: startIndex,
      }
    });
  } catch (error) {
    logger.error('Error fetching user loans:', error);
    res.status(500).json({ error: 'Failed to fetch user loans' });
  }
});

// Repay loan
router.post('/:loanId/repay', authMiddleware, repayLoanValidation, async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { loanId } = req.params;
    const { amount } = req.body;

    // Get loan details to verify ownership
    const loanResult = await stellarService.getLoan(parseInt(loanId));
    const loan = loanResult.returnValue;

    // Check if user is the borrower or admin
    if (loan.borrower !== req.user?.publicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to repay this loan' });
    }

    // Process repayment
    const result = await stellarService.repayLoan(loan.borrower, parseInt(loanId), amount);

    // Update cache
    const cacheKey = `loan:${loanId}`;
    await redisCache.del(cacheKey);

    logger.info(`Loan repayment processed: ${loanId}, amount: ${amount}`);

    res.json({
      success: true,
      transactionHash: result.hash,
      message: 'Loan repayment processed successfully'
    });
  } catch (error) {
    logger.error('Error processing loan repayment:', error);
    res.status(500).json({ error: 'Failed to process loan repayment' });
  }
});

// Get active loans (admin only)
router.get('/admin/active', authMiddleware, async (req: Request, res: Response) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { limit = 50, offset = 0 } = req.query;

    // Check cache first
    const cacheKey = 'loans:active';
    let activeLoans = await redisCache.get(cacheKey);

    if (!activeLoans) {
      // Fetch from blockchain
      const result = await stellarService.getActiveLoans();
      activeLoans = result.returnValue;

      // Cache for 1 minute
      await redisCache.set(cacheKey, activeLoans, 60);
    }

    // Apply pagination
    const startIndex = parseInt(offset as string);
    const endIndex = startIndex + parseInt(limit as string);
    const paginatedLoans = activeLoans.slice(startIndex, endIndex);

    res.json({
      success: true,
      data: {
        loans: paginatedLoans,
        total: activeLoans.length,
        limit: parseInt(limit as string),
        offset: startIndex,
      }
    });
  } catch (error) {
    logger.error('Error fetching active loans:', error);
    res.status(500).json({ error: 'Failed to fetch active loans' });
  }
});

// Approve loan (admin only)
router.post('/:loanId/approve', authMiddleware, async (req: Request, res: Response) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { loanId } = req.params;

    // Approve loan on blockchain
    const result = await stellarService.approveLoan(req.user.publicKey, parseInt(loanId));

    // Update cache
    const cacheKey = `loan:${loanId}`;
    await redisCache.del(cacheKey);

    logger.info(`Loan approved: ${loanId} by admin ${req.user.publicKey}`);

    res.json({
      success: true,
      transactionHash: result.hash,
      message: 'Loan approved successfully'
    });
  } catch (error) {
    logger.error('Error approving loan:', error);
    res.status(500).json({ error: 'Failed to approve loan' });
  }
});

// Mark loan as default (admin only)
router.post('/:loanId/default', authMiddleware, async (req: Request, res: Response) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { loanId } = req.params;

    // Mark loan as default on blockchain
    const result = await stellarService.markDefault(req.user.publicKey, parseInt(loanId));

    // Update cache
    const cacheKey = `loan:${loanId}`;
    await redisCache.del(cacheKey);

    logger.info(`Loan marked as default: ${loanId} by admin ${req.user.publicKey}`);

    res.json({
      success: true,
      transactionHash: result.hash,
      message: 'Loan marked as default successfully'
    });
  } catch (error) {
    logger.error('Error marking loan as default:', error);
    res.status(500).json({ error: 'Failed to mark loan as default' });
  }
});

// Get loan statistics (admin only)
router.get('/admin/statistics', authMiddleware, async (req: Request, res: Response) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Get statistics from blockchain
    const result = await stellarService.getLoanStatistics();
    const stats = result.returnValue;

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error('Error fetching loan statistics:', error);
    res.status(500).json({ error: 'Failed to fetch loan statistics' });
  }
});

// Check loan eligibility
router.post('/check-eligibility', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userPublicKey, amount } = req.body;

    // Check authorization
    if (req.user?.publicKey !== userPublicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to check eligibility for this user' });
    }

    // Check eligibility
    const canBorrow = await stellarService.canBorrow(userPublicKey, amount);

    // Get additional eligibility info
    const creditScoreResult = await stellarService.getCreditScore(userPublicKey);
    const creditScore = creditScoreResult.returnValue;

    const eligibility = {
      canBorrow,
      creditScore: creditScore.score,
      maxLoanAmount: canBorrow ? amount : 0,
      reasons: canBorrow ? [] : ['Insufficient credit score or existing debt'],
    };

    res.json({
      success: true,
      data: eligibility
    });
  } catch (error) {
    logger.error('Error checking loan eligibility:', error);
    res.status(500).json({ error: 'Failed to check loan eligibility' });
  }
});

export { router as loanRoutes };
