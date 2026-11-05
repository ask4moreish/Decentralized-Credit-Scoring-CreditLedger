import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { stellarService } from '../services/stellarService';
import { redisCache } from '../config/redis';
import { dbService } from '../services/dbService';
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

// POST /api/loans/prepare-apply
// Generates unsigned transaction XDR for non-custodial loan application via Freighter
router.post('/prepare-apply', authMiddleware, createLoanValidation, async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { borrowerPublicKey, amount, durationMonths } = req.body;

    if (req.user?.publicKey !== borrowerPublicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to prepare loan application for this user' });
    }

    const canBorrow = await stellarService.canBorrow(borrowerPublicKey, amount.toString());
    if (!canBorrow) {
      return res.status(400).json({ error: 'User not eligible for loan under current scoring and limits' });
    }

    const unsignedXdr = await stellarService.prepareCreateLoanTx(borrowerPublicKey, amount.toString(), durationMonths);

    res.json({
      success: true,
      xdr: unsignedXdr,
      message: 'Unsigned loan application prepared. Sign with Freighter wallet.',
    });
  } catch (error) {
    logger.error('Error preparing loan application:', error);
    res.status(500).json({ error: 'Failed to prepare loan application' });
  }
});

// POST /api/loans/prepare-repay
// Generates unsigned transaction XDR for non-custodial repayment via Freighter
router.post('/prepare-repay', authMiddleware, repayLoanValidation, async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { loanId, amount } = req.body;

    const loanResult = await stellarService.getLoan(parseInt(loanId));
    const loan = loanResult.returnValue;
    if (loan && loan.borrower !== req.user?.publicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to repay this loan' });
    }

    const borrowerKey = loan?.borrower || req.user?.publicKey;
    const unsignedXdr = await stellarService.prepareRepayLoanTx(borrowerKey, parseInt(loanId), amount.toString());

    res.json({
      success: true,
      xdr: unsignedXdr,
      message: 'Unsigned repayment transaction prepared. Sign with Freighter wallet.',
    });
  } catch (error) {
    logger.error('Error preparing loan repayment:', error);
    res.status(500).json({ error: 'Failed to prepare loan repayment' });
  }
});

// POST /api/loans/submit
// Submits a signed loan transaction XDR
router.post('/submit', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { signedXDR, loanId, borrowerPublicKey, action } = req.body;
    if (!signedXDR) {
      return res.status(400).json({ error: 'signedXDR is required' });
    }

    const result = await stellarService.submitTransaction(signedXDR);

    if (action === 'apply' && result.returnValue) {
      const newId = result.returnValue;
      await dbService.upsertLoan({
        id: newId,
        borrowerPublicKey: borrowerPublicKey || req.user?.publicKey || '',
        amount: req.body.amount || 0,
        interestRate: 0,
        durationMonths: req.body.durationMonths || 12,
        status: 'pending',
      });
    } else if (action === 'repay' && loanId) {
      await dbService.updateLoanStatus(loanId, 'active', req.body.amount);
      await redisCache.del(`loan:${loanId}`);
    }

    if (borrowerPublicKey) {
      await redisCache.del(`loans:user:${borrowerPublicKey}`);
    }

    res.json({
      success: true,
      transactionHash: result.hash,
      data: result.returnValue,
      message: 'Transaction submitted successfully to Stellar network',
    });
  } catch (error) {
    logger.error('Error submitting loan transaction:', error);
    res.status(500).json({ error: 'Failed to submit loan transaction' });
  }
});

// POST /api/loans/apply
// Create loan application (custodial/direct fallback)
router.post('/apply', authMiddleware, createLoanValidation, async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { borrowerPublicKey, amount, durationMonths } = req.body;

    if (req.user?.publicKey !== borrowerPublicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to create loan for this user' });
    }

    const canBorrow = await stellarService.canBorrow(borrowerPublicKey, amount.toString());
    if (!canBorrow) {
      return res.status(400).json({ error: 'User not eligible for loan' });
    }

    const result = await stellarService.createLoan(borrowerPublicKey, amount.toString(), durationMonths);
    const loanId = result.returnValue || Date.now();

    // Persist to PostgreSQL
    await dbService.upsertLoan({
      id: loanId,
      borrowerPublicKey,
      amount,
      interestRate: 10,
      durationMonths,
      status: 'pending',
    });

    // Cache in Redis
    const loanApplication = {
      id: loanId,
      borrowerPublicKey,
      amount,
      durationMonths,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    await redisCache.set(`loan:application:${loanId}`, loanApplication, 3600);
    await redisCache.del(`loans:user:${borrowerPublicKey}`);

    logger.info(`Loan application created: ${loanId} for user ${borrowerPublicKey}`);

    res.json({
      success: true,
      data: {
        loanId,
        transactionHash: result.hash,
        status: 'pending',
        message: 'Loan application submitted successfully',
      },
    });
  } catch (error) {
    logger.error('Error creating loan application:', error);
    res.status(500).json({ error: 'Failed to create loan application' });
  }
});

// GET /api/loans/:loanId
// Get loan details
router.get('/:loanId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { loanId } = req.params;

    // 1. Check Redis cache
    const cacheKey = `loan:${loanId}`;
    let loan = await redisCache.get<any>(cacheKey);

    // 2. Fallback to PostgreSQL
    if (!loan) {
      const dbLoan = await dbService.getLoanById(loanId);
      if (dbLoan) {
        loan = {
          id: dbLoan.id,
          borrower: dbLoan.borrower_public_key,
          amount: dbLoan.amount,
          interestRate: dbLoan.interest_rate,
          durationMonths: dbLoan.duration_months,
          status: dbLoan.status,
          repaidAmount: dbLoan.repaid_amount,
          createdAt: dbLoan.created_at,
        };
        await redisCache.set(cacheKey, loan, 300);
      }
    }

    // 3. Fallback to blockchain
    if (!loan) {
      try {
        const result = await stellarService.getLoan(parseInt(loanId));
        loan = result.returnValue;
        if (loan) {
          await redisCache.set(cacheKey, loan, 300);
        }
      } catch (err) {
        logger.warn(`Could not load loan ${loanId} from chain:`, err);
      }
    }

    if (!loan) {
      return res.status(404).json({ error: 'Loan not found' });
    }

    // Check authorization
    const borrower = loan.borrower || loan.borrower_public_key;
    if (borrower !== req.user?.publicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to view this loan' });
    }

    res.json({
      success: true,
      data: loan,
    });
  } catch (error) {
    logger.error('Error fetching loan details:', error);
    res.status(500).json({ error: 'Failed to fetch loan details' });
  }
});

// GET /api/loans/user/:userPublicKey
// Get user's loans
router.get('/user/:userPublicKey', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userPublicKey } = req.params;
    const { status = 'all', limit = 10, offset = 0 } = req.query;

    if (req.user?.publicKey !== userPublicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to view loans for this user' });
    }

    // 1. Check Redis cache
    const cacheKey = `loans:user:${userPublicKey}`;
    let userLoans: any[] = (await redisCache.get<any[]>(cacheKey)) || [];

    // 2. Fallback to PostgreSQL
    if (!userLoans.length) {
      userLoans = await dbService.getUserLoans(userPublicKey, status as string);
      if (userLoans.length) {
        await redisCache.set(cacheKey, userLoans, 120);
      }
    }

    // 3. Fallback to blockchain
    if (!userLoans.length) {
      try {
        const result = await stellarService.getUserLoans(userPublicKey);
        userLoans = result.returnValue || [];
        if (userLoans.length) {
          await redisCache.set(cacheKey, userLoans, 120);
        }
      } catch (err) {
        logger.warn(`Could not load loans for ${userPublicKey} from chain:`, err);
      }
    }

    let filteredLoans = userLoans;
    if (status !== 'all') {
      filteredLoans = userLoans.filter((l: any) => l.status === status);
    }

    const startIndex = parseInt(offset as string) || 0;
    const endIndex = startIndex + (parseInt(limit as string) || 10);
    const paginatedLoans = filteredLoans.slice(startIndex, endIndex);

    res.json({
      success: true,
      data: {
        loans: paginatedLoans,
        total: filteredLoans.length,
        limit: parseInt(limit as string) || 10,
        offset: startIndex,
      },
    });
  } catch (error) {
    logger.error('Error fetching user loans:', error);
    res.status(500).json({ error: 'Failed to fetch user loans' });
  }
});

// POST /api/loans/:loanId/repay
// Repay loan (custodial/direct fallback)
router.post('/:loanId/repay', authMiddleware, repayLoanValidation, async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { loanId } = req.params;
    const { amount } = req.body;

    const loanResult = await stellarService.getLoan(parseInt(loanId));
    const loan = loanResult.returnValue;

    if (loan && loan.borrower !== req.user?.publicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to repay this loan' });
    }

    const borrowerKey = loan?.borrower || req.user?.publicKey;
    const result = await stellarService.repayLoan(borrowerKey, parseInt(loanId), amount.toString());

    // Update DB
    await dbService.updateLoanStatus(loanId, 'active', amount);

    // Invalidate caches
    await redisCache.del(`loan:${loanId}`);
    await redisCache.del(`loans:user:${borrowerKey}`);

    logger.info(`Loan repayment processed: ${loanId}, amount: ${amount}`);

    res.json({
      success: true,
      transactionHash: result.hash,
      message: 'Loan repayment processed successfully',
    });
  } catch (error) {
    logger.error('Error processing loan repayment:', error);
    res.status(500).json({ error: 'Failed to process loan repayment' });
  }
});

// GET /api/loans/admin/active
// Get active loans (admin only)
router.get('/admin/active', authMiddleware, async (req: Request, res: Response) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { limit = 50, offset = 0 } = req.query;

    const cacheKey = 'loans:active';
    let activeLoans: any[] = (await redisCache.get<any[]>(cacheKey)) || [];

    if (!activeLoans.length) {
      activeLoans = await dbService.getActiveLoans();
      if (!activeLoans.length) {
        try {
          const result = await stellarService.getActiveLoans();
          activeLoans = result.returnValue || [];
        } catch {
          activeLoans = [];
        }
      }
      if (activeLoans.length) {
        await redisCache.set(cacheKey, activeLoans, 60);
      }
    }

    const startIndex = parseInt(offset as string) || 0;
    const endIndex = startIndex + (parseInt(limit as string) || 50);
    const paginatedLoans = activeLoans.slice(startIndex, endIndex);

    res.json({
      success: true,
      data: {
        loans: paginatedLoans,
        total: activeLoans.length,
        limit: parseInt(limit as string) || 50,
        offset: startIndex,
      },
    });
  } catch (error) {
    logger.error('Error fetching active loans:', error);
    res.status(500).json({ error: 'Failed to fetch active loans' });
  }
});

// POST /api/loans/:loanId/approve
// Approve loan (admin only)
router.post('/:loanId/approve', authMiddleware, async (req: Request, res: Response) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { loanId } = req.params;

    const result = await stellarService.approveLoan(req.user.publicKey, parseInt(loanId));

    await dbService.updateLoanStatus(loanId, 'active');
    await redisCache.del(`loan:${loanId}`);
    await redisCache.del('loans:active');

    logger.info(`Loan approved: ${loanId} by admin ${req.user.publicKey}`);

    res.json({
      success: true,
      transactionHash: result.hash,
      message: 'Loan approved successfully',
    });
  } catch (error) {
    logger.error('Error approving loan:', error);
    res.status(500).json({ error: 'Failed to approve loan' });
  }
});

// POST /api/loans/:loanId/default
// Mark loan as default (admin only)
router.post('/:loanId/default', authMiddleware, async (req: Request, res: Response) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { loanId } = req.params;

    const result = await stellarService.markDefault(req.user.publicKey, parseInt(loanId));

    await dbService.updateLoanStatus(loanId, 'defaulted');
    await redisCache.del(`loan:${loanId}`);
    await redisCache.del('loans:active');

    logger.info(`Loan marked as default: ${loanId} by admin ${req.user.publicKey}`);

    res.json({
      success: true,
      transactionHash: result.hash,
      message: 'Loan marked as default successfully',
    });
  } catch (error) {
    logger.error('Error marking loan as default:', error);
    res.status(500).json({ error: 'Failed to mark loan as default' });
  }
});

// GET /api/loans/admin/statistics
// Get loan statistics (admin only)
router.get('/admin/statistics', authMiddleware, async (req: Request, res: Response) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    let stats: any = {};
    try {
      const result = await stellarService.getLoanStatistics();
      stats = result.returnValue || {};
    } catch {
      const active = await dbService.getActiveLoans();
      stats = {
        totalLoans: active.length,
        activeCount: active.filter((l: any) => l.status === 'active').length,
        pendingCount: active.filter((l: any) => l.status === 'pending').length,
      };
    }

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    logger.error('Error fetching loan statistics:', error);
    res.status(500).json({ error: 'Failed to fetch loan statistics' });
  }
});

// POST /api/loans/check-eligibility
router.post('/check-eligibility', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userPublicKey, amount } = req.body;

    if (req.user?.publicKey !== userPublicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to check eligibility for this user' });
    }

    const canBorrow = await stellarService.canBorrow(userPublicKey, amount.toString());

    let creditScoreVal = 0;
    try {
      const creditScoreResult = await stellarService.getCreditScore(userPublicKey);
      creditScoreVal = creditScoreResult.returnValue?.score || 0;
    } catch {
      const dbScore = await dbService.getCachedCreditScore(userPublicKey);
      creditScoreVal = dbScore?.score || 0;
    }

    const eligibility = {
      canBorrow,
      creditScore: creditScoreVal,
      maxLoanAmount: canBorrow ? amount : 0,
      reasons: canBorrow ? [] : ['Credit score below required tier (minimum 50 required) or active loan exists'],
    };

    res.json({
      success: true,
      data: eligibility,
    });
  } catch (error) {
    logger.error('Error checking loan eligibility:', error);
    res.status(500).json({ error: 'Failed to check loan eligibility' });
  }
});

export { router as loanRoutes };
