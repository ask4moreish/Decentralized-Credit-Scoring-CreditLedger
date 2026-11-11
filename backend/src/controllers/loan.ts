import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { stellarService } from '../services/stellarService';
import { redisCache } from '../config/redis';
import { dbService } from '../services/dbService';
import { logger } from '../utils/logger';
import { authMiddleware, requireAdmin, requireRoles } from '../middleware/auth';
import { idempotencyMiddleware } from '../middleware/idempotency';
import { parseDecimalToStroops, parseNonNegativeStroops, formatStroopsToDecimal } from '../utils/amounts';

const router = Router();

const createLoanValidation = [
  body('borrowerPublicKey').isString().isLength({ min: 56, max: 56 }),
  body('amount').notEmpty(),
  body('durationMonths').isInt({ min: 1, max: 60 }),
  body('collateralAmount').optional(),
];

const repayLoanValidation = [
  body('loanId').isInt({ min: 1 }),
  body('amount').notEmpty(),
];

const poolAmountValidation = [
  body('lenderPublicKey').isString().isLength({ min: 56, max: 56 }),
  body('amount').notEmpty(),
];

function serializeChainObject(obj: any): any {
  if (typeof obj === 'bigint') return obj.toString();
  if (Array.isArray(obj)) return obj.map(serializeChainObject);
  if (obj && typeof obj === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = serializeChainObject(v);
    }
    return out;
  }
  return obj;
}

// POST /api/loans/prepare-deposit (Lender Role)
router.post(
  '/prepare-deposit',
  authMiddleware,
  requireRoles('lender', 'admin'),
  idempotencyMiddleware,
  poolAmountValidation,
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { lenderPublicKey, amount } = req.body;
      if (req.user?.publicKey !== lenderPublicKey && !req.user?.isAdmin) {
        return res.status(403).json({ error: 'Unauthorized to prepare deposit for this lender' });
      }
      const amountStroops = parseDecimalToStroops(amount);
      const unsignedXdr = await stellarService.prepareDepositLiquidityTx(lenderPublicKey, amountStroops);
      res.json({
        success: true,
        xdr: unsignedXdr,
        amountStroops,
        message: 'Unsigned liquidity deposit transaction prepared. Sign with Freighter.',
      });
    } catch (error) {
      logger.error('Error preparing deposit transaction:', error);
      res.status(500).json({ error: 'Failed to prepare liquidity deposit' });
    }
  }
);

// POST /api/loans/prepare-withdraw (Lender Role)
router.post(
  '/prepare-withdraw',
  authMiddleware,
  requireRoles('lender', 'admin'),
  idempotencyMiddleware,
  poolAmountValidation,
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { lenderPublicKey, amount } = req.body;
      if (req.user?.publicKey !== lenderPublicKey && !req.user?.isAdmin) {
        return res.status(403).json({ error: 'Unauthorized to prepare withdrawal for this lender' });
      }
      const amountStroops = parseDecimalToStroops(amount);
      const unsignedXdr = await stellarService.prepareWithdrawLiquidityTx(lenderPublicKey, amountStroops);
      res.json({
        success: true,
        xdr: unsignedXdr,
        amountStroops,
        message: 'Unsigned liquidity withdrawal prepared. Sign with Freighter.',
      });
    } catch (error) {
      logger.error('Error preparing withdrawal transaction:', error);
      res.status(500).json({ error: 'Failed to prepare liquidity withdrawal' });
    }
  }
);

// POST /api/loans/prepare-apply (Borrower Role — strict non-custodial XDR prep)
router.post(
  '/prepare-apply',
  authMiddleware,
  idempotencyMiddleware,
  createLoanValidation,
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { borrowerPublicKey, amount, durationMonths, collateralAmount } = req.body;
      if (req.user?.publicKey !== borrowerPublicKey && !req.user?.isAdmin) {
        return res.status(403).json({ error: 'Unauthorized to prepare loan application for this user' });
      }

      const amountStroops = parseDecimalToStroops(amount);
      const collateralStroops = parseNonNegativeStroops(collateralAmount);

      const canBorrow = await stellarService.canBorrow(borrowerPublicKey, amountStroops);
      if (!canBorrow) {
        return res.status(400).json({ error: 'User not eligible for loan under current verified scoring and limits' });
      }

      const requiredCollateral = await stellarService
        .getRequiredCollateral(borrowerPublicKey, amountStroops)
        .catch(() => '0');
      if (BigInt(collateralStroops) < BigInt(requiredCollateral || '0')) {
        return res.status(400).json({
          error: `Insufficient collateral: minimum required ${formatStroopsToDecimal(requiredCollateral)} (${requiredCollateral} stroops)`,
          requiredCollateralStroops: requiredCollateral,
        });
      }

      const unsignedXdr = await stellarService.prepareCreateLoanTx(
        borrowerPublicKey,
        amountStroops,
        Number(durationMonths),
        collateralStroops
      );

      res.json({
        success: true,
        xdr: unsignedXdr,
        amountStroops,
        collateralStroops,
        requiredCollateralStroops: requiredCollateral,
        message: 'Unsigned loan application prepared. Sign with Freighter wallet.',
      });
    } catch (error) {
      logger.error('Error preparing loan application:', error);
      res.status(500).json({ error: 'Failed to prepare loan application' });
    }
  }
);

// POST /api/loans/prepare-cancel
router.post(
  '/prepare-cancel',
  authMiddleware,
  idempotencyMiddleware,
  [body('loanId').isInt({ min: 1 })],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const loanId = Number(req.body.loanId);
      const loanRes = await stellarService.getLoan(loanId);
      const loan = loanRes.returnValue;
      if (loan && loan.borrower !== req.user?.publicKey && !req.user?.isAdmin) {
        return res.status(403).json({ error: 'Unauthorized to cancel this loan' });
      }
      const borrowerKey = loan?.borrower || req.user!.publicKey;
      const unsignedXdr = await stellarService.prepareCancelLoanTx(borrowerKey, loanId);
      res.json({ success: true, xdr: unsignedXdr });
    } catch (error) {
      logger.error('Error preparing loan cancellation:', error);
      res.status(500).json({ error: 'Failed to prepare loan cancellation' });
    }
  }
);

// POST /api/loans/prepare-repay
router.post(
  '/prepare-repay',
  authMiddleware,
  idempotencyMiddleware,
  repayLoanValidation,
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { loanId, amount } = req.body;
      const amountStroops = parseDecimalToStroops(amount);
      const loanResult = await stellarService.getLoan(Number(loanId));
      const loan = loanResult.returnValue;
      if (loan && loan.borrower !== req.user?.publicKey && !req.user?.isAdmin) {
        return res.status(403).json({ error: 'Unauthorized to repay this loan' });
      }

      const borrowerKey = loan?.borrower || req.user!.publicKey;
      const unsignedXdr = await stellarService.prepareRepayLoanTx(borrowerKey, Number(loanId), amountStroops);

      res.json({
        success: true,
        xdr: unsignedXdr,
        amountStroops,
        message: 'Unsigned repayment transaction prepared. Sign with Freighter wallet.',
      });
    } catch (error) {
      logger.error('Error preparing loan repayment:', error);
      res.status(500).json({ error: 'Failed to prepare loan repayment' });
    }
  }
);

// POST /api/loans/submit — Confirms transaction on Soroban BEFORE mutating DB
router.post(
  '/submit',
  authMiddleware,
  idempotencyMiddleware,
  [
    body('signedXDR').isString().notEmpty(),
    body('action').isIn(['apply', 'cancel', 'repay', 'deposit', 'withdraw']),
    body('loanId').optional().isInt({ min: 1 }),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { signedXDR, loanId, borrowerPublicKey, action } = req.body;

      const result = await stellarService.submitTransaction(signedXDR);
      const actor = borrowerPublicKey || req.user!.publicKey;
      const amountStroops = req.body.amount ? parseNonNegativeStroops(req.body.amount) : '0';

      await dbService.recordStellarTx({
        txHash: result.hash,
        operationType: `loan_${action}`,
        actorPublicKey: actor,
        status: 'confirmed',
        ledgerSequence: result.ledger,
        amountStroops,
      });

      if (action === 'apply' && result.returnValue) {
        const newId = Number(result.returnValue);
        const onChainLoan = await stellarService.getLoan(newId).catch(() => ({ returnValue: null }));
        const l = onChainLoan.returnValue;
        await dbService.upsertLoan({
          id: newId,
          borrowerPublicKey: actor,
          amount: l?.amount ? String(l.amount) : amountStroops,
          interestRate: l?.interest_rate ? Number(l.interest_rate) : 0,
          durationMonths: Number(req.body.durationMonths || l?.duration_months || 12),
          status: 'pending',
          creditScoreUsed: Number(l?.credit_score_used || 0),
          collateralAmount: l?.collateral_amount ? String(l.collateral_amount) : '0',
          collateralLocked: Boolean(l?.collateral_locked),
          scheduledInterest: l?.scheduled_interest ? String(l.scheduled_interest) : '0',
          txHash: result.hash,
        });
      } else if (action === 'cancel' && loanId) {
        await dbService.updateLoanStatus(loanId, 'cancelled', undefined, false);
        await redisCache.del(`loan:${loanId}`);
      } else if (action === 'repay' && loanId) {
        const updated = await stellarService.getLoan(Number(loanId)).catch(() => ({ returnValue: null }));
        const l = updated.returnValue;
        const newStatus =
          l?.status === 'Repaid' || result.returnValue?.status === 'Repaid' ? 'repaid' : 'active';
        await dbService.updateLoanStatus(
          loanId,
          newStatus,
          l?.repaid_amount ? String(l.repaid_amount) : amountStroops,
          Boolean(l?.collateral_locked)
        );
        await redisCache.del(`loan:${loanId}`);
        await redisCache.del(`credit_score:${actor}`);
      }

      await redisCache.del(`loans:user:${actor}`);
      await redisCache.del('loans:active');

      await dbService.recordAuditLog({
        actorPublicKey: req.user!.publicKey,
        action: `loan_${action}_confirmed`,
        resourceType: 'loan',
        resourceId: String(loanId || result.returnValue || result.hash),
        status: 'confirmed',
        details: { txHash: result.hash, ledger: result.ledger },
      });

      res.json({
        success: true,
        transactionHash: result.hash,
        ledger: result.ledger,
        data: serializeChainObject(result.returnValue),
        message: 'Transaction confirmed on Stellar Soroban and reconciled.',
      });
    } catch (error) {
      logger.error('Error submitting loan transaction:', error);
      res.status(500).json({ error: 'Failed to submit and confirm loan transaction' });
    }
  }
);

// GET /api/loans/pool — Lending pool reserve & liquidity summary
router.get('/pool', authMiddleware, async (_req: Request, res: Response) => {
  try {
    const pool = await stellarService.getPoolState();
    const raw = serializeChainObject(pool.returnValue || {});
    res.json({
      success: true,
      data: {
        totalShares: String(raw.total_shares ?? '0'),
        availableCashStroops: String(raw.available_cash ?? '0'),
        availableCash: formatStroopsToDecimal(raw.available_cash ?? '0'),
        outstandingPrincipalStroops: String(raw.outstanding_principal ?? '0'),
        outstandingPrincipal: formatStroopsToDecimal(raw.outstanding_principal ?? '0'),
        totalInterestEarnedStroops: String(raw.total_interest_earned ?? '0'),
        totalCollateralLockedStroops: String(raw.total_collateral_locked ?? '0'),
        totalDefaultedPrincipalStroops: String(raw.total_defaulted_principal ?? '0'),
        totalRecoveredStroops: String(raw.total_recovered ?? '0'),
      },
    });
  } catch (error) {
    logger.error('Error fetching pool status:', error);
    res.status(500).json({ error: 'Failed to fetch lending pool state' });
  }
});

// GET /api/loans/lender/:lenderPublicKey
router.get('/lender/:lenderPublicKey', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { lenderPublicKey } = req.params;
    if (req.user?.publicKey !== lenderPublicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to view lender position' });
    }
    const balanceStroops = await stellarService.getLenderBalance(lenderPublicKey);
    res.json({
      success: true,
      data: {
        lenderPublicKey,
        balanceStroops,
        balanceFormatted: formatStroopsToDecimal(balanceStroops),
      },
    });
  } catch (error) {
    logger.error('Error fetching lender balance:', error);
    res.status(500).json({ error: 'Failed to fetch lender position' });
  }
});

// POST /api/loans/check-eligibility
router.post('/check-eligibility', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userPublicKey, amount } = req.body;
    if (req.user?.publicKey !== userPublicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to check eligibility for this user' });
    }

    const amountStroops = parseDecimalToStroops(amount);
    const canBorrow = await stellarService.canBorrow(userPublicKey, amountStroops);
    let creditScoreVal = 0;
    try {
      const cs = await stellarService.getCreditScore(userPublicKey);
      creditScoreVal = Number(cs.returnValue?.score ?? 0);
    } catch {
      const dbScore = await dbService.getCachedCreditScore(userPublicKey);
      creditScoreVal = dbScore?.score || 0;
    }

    const requiredCollateralStroops = canBorrow
      ? await stellarService.getRequiredCollateral(userPublicKey, amountStroops).catch(() => '0')
      : '0';

    res.json({
      success: true,
      data: {
        canBorrow,
        creditScore: creditScoreVal,
        collateralRequired: creditScoreVal >= 50 && creditScoreVal < 60,
        requiredCollateralStroops,
        requiredCollateralFormatted: formatStroopsToDecimal(requiredCollateralStroops),
        reasons: canBorrow ? [] : ['Verified credit score below 50 or tier limit exceeded'],
      },
    });
  } catch (error) {
    logger.error('Error checking eligibility:', error);
    res.status(500).json({ error: 'Failed to check loan eligibility' });
  }
});

// GET /api/loans/user/:userPublicKey
router.get('/user/:userPublicKey', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userPublicKey } = req.params;
    const { status = 'all', limit = 10, offset = 0 } = req.query;
    if (req.user?.publicKey !== userPublicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to view loans for this user' });
    }

    let userLoans: any[] = await dbService.getUserLoans(userPublicKey, status as string);
    if (!userLoans.length) {
      try {
        const idsRes = await stellarService.getUserLoans(userPublicKey);
        const ids: any[] = Array.isArray(idsRes.returnValue) ? idsRes.returnValue : [];
        const hydrated = await Promise.all(
          ids.map(async (id) => {
            const l = await stellarService.getLoan(Number(id)).catch(() => ({ returnValue: null }));
            return l.returnValue ? serializeChainObject(l.returnValue) : null;
          })
        );
        userLoans = hydrated.filter(Boolean);
      } catch {
        userLoans = [];
      }
    }

    const filtered =
      status === 'all'
        ? userLoans
        : userLoans.filter((l: any) => String(l.status).toLowerCase() === String(status).toLowerCase());
    const startIndex = parseInt(offset as string, 10) || 0;
    const pageLimit = Math.min(50, parseInt(limit as string, 10) || 10);

    res.json({
      success: true,
      data: {
        loans: filtered.slice(startIndex, startIndex + pageLimit),
        total: filtered.length,
        limit: pageLimit,
        offset: startIndex,
      },
    });
  } catch (error) {
    logger.error('Error fetching user loans:', error);
    res.status(500).json({ error: 'Failed to fetch user loans' });
  }
});

// Admin-only routes placed before /:loanId parameter matcher
router.get('/admin/active', authMiddleware, requireAdmin, async (_req: Request, res: Response) => {
  try {
    let activeLoans: any[] = await dbService.getActiveLoans();
    if (!activeLoans.length) {
      const chainRes = await stellarService.getActiveLoans().catch(() => ({ returnValue: [] }));
      activeLoans = serializeChainObject(chainRes.returnValue || []);
    }
    res.json({ success: true, data: { loans: activeLoans, total: activeLoans.length } });
  } catch (error) {
    logger.error('Error fetching active loans:', error);
    res.status(500).json({ error: 'Failed to fetch active loans' });
  }
});

router.get('/admin/statistics', authMiddleware, requireAdmin, async (_req: Request, res: Response) => {
  try {
    const statsRes = await stellarService.getLoanStatistics().catch(() => ({ returnValue: null }));
    res.json({ success: true, data: serializeChainObject(statsRes.returnValue || {}) });
  } catch (error) {
    logger.error('Error fetching loan statistics:', error);
    res.status(500).json({ error: 'Failed to fetch loan statistics' });
  }
});

router.post('/admin/reconcile', authMiddleware, requireAdmin, async (_req: Request, res: Response) => {
  try {
    const summary = await stellarService.reconcilePendingTransactions();
    res.json({ success: true, data: summary });
  } catch (error) {
    logger.error('Error reconciling transactions:', error);
    res.status(500).json({ error: 'Reconciliation failed' });
  }
});

router.post('/:loanId/approve', authMiddleware, requireAdmin, idempotencyMiddleware, async (req: Request, res: Response) => {
  try {
    const { loanId } = req.params;
    const result = await stellarService.approveLoan(req.user!.publicKey, Number(loanId));
    await dbService.recordStellarTx({
      txHash: result.hash,
      operationType: 'loan_approve_disburse',
      actorPublicKey: req.user!.publicKey,
      status: 'confirmed',
      ledgerSequence: result.ledger,
    });
    await dbService.updateLoanStatus(loanId, 'active');
    await redisCache.del(`loan:${loanId}`);
    await redisCache.del('loans:active');

    res.json({
      success: true,
      transactionHash: result.hash,
      ledger: result.ledger,
      message: 'Loan approved and principal disbursed on-chain',
    });
  } catch (error) {
    logger.error('Error approving loan:', error);
    res.status(500).json({ error: 'Failed to approve and disburse loan' });
  }
});

router.post('/:loanId/default', authMiddleware, requireAdmin, idempotencyMiddleware, async (req: Request, res: Response) => {
  try {
    const { loanId } = req.params;
    const result = await stellarService.markDefault(req.user!.publicKey, Number(loanId));
    await dbService.recordStellarTx({
      txHash: result.hash,
      operationType: 'loan_mark_default',
      actorPublicKey: req.user!.publicKey,
      status: 'confirmed',
      ledgerSequence: result.ledger,
    });
    await dbService.updateLoanStatus(loanId, 'defaulted', undefined, false);
    await redisCache.del(`loan:${loanId}`);
    await redisCache.del('loans:active');

    res.json({
      success: true,
      transactionHash: result.hash,
      ledger: result.ledger,
      message: 'Loan marked as defaulted and collateral/vouch settlements executed',
    });
  } catch (error) {
    logger.error('Error marking loan default:', error);
    res.status(500).json({ error: 'Failed to mark loan as default' });
  }
});

// GET /api/loans/:loanId
router.get('/:loanId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { loanId } = req.params;
    let loan: any = null;
    try {
      const chainRes = await stellarService.getLoan(Number(loanId));
      loan = serializeChainObject(chainRes.returnValue);
    } catch {
      const dbLoan = await dbService.getLoanById(loanId);
      loan = dbLoan;
    }

    if (!loan) {
      return res.status(404).json({ error: 'Loan not found' });
    }
    const borrower = loan.borrower || loan.borrower_public_key;
    if (borrower !== req.user?.publicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to view this loan' });
    }

    const schedule = await stellarService
      .getRepaymentSchedule(Number(loanId))
      .then(serializeChainObject)
      .catch(() => null);

    res.json({ success: true, data: { ...loan, repaymentSchedule: schedule } });
  } catch (error) {
    logger.error('Error fetching loan:', error);
    res.status(500).json({ error: 'Failed to fetch loan details' });
  }
});

export { router as loanRoutes };
