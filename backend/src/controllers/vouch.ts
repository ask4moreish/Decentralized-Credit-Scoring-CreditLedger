import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { StrKey } from '@stellar/stellar-sdk';
import { stellarService } from '../services/stellarService';
import { redisCache } from '../config/redis';
import { dbService } from '../services/dbService';
import { logger } from '../utils/logger';
import { authMiddleware } from '../middleware/auth';
import { idempotencyMiddleware } from '../middleware/idempotency';
import { parseDecimalToStroops } from '../utils/amounts';

const router = Router();

const createVouchValidation = [
  body('voucherPublicKey').isString().isLength({ min: 56, max: 56 }),
  body('voucheePublicKey').isString().isLength({ min: 56, max: 56 }),
  body('amount').notEmpty(),
  body('reason').isString().isLength({ min: 1, max: 64 }),
  body('durationMonths').isInt({ min: 1, max: 24 }),
];

// POST /api/vouch/prepare-create — Trust weight is derived on-chain by protocol policy, never caller input
router.post(
  '/prepare-create',
  authMiddleware,
  idempotencyMiddleware,
  createVouchValidation,
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { voucherPublicKey, voucheePublicKey, amount, reason, durationMonths } = req.body;

      if (req.user?.publicKey !== voucherPublicKey && !req.user?.isAdmin) {
        return res.status(403).json({ error: 'Unauthorized to prepare vouch for this user' });
      }
      if (!StrKey.isValidEd25519PublicKey(voucheePublicKey) || voucherPublicKey === voucheePublicKey) {
        return res.status(400).json({ error: 'Invalid vouchee public key' });
      }

      const amountStroops = parseDecimalToStroops(amount);
      const unsignedXdr = await stellarService.prepareCreateVouchTx(
        voucherPublicKey,
        voucheePublicKey,
        amountStroops,
        reason,
        Number(durationMonths)
      );

      res.json({
        success: true,
        xdr: unsignedXdr,
        amountStroops,
        message: 'Unsigned escrowed vouch transaction prepared. Sign with Freighter.',
      });
    } catch (error) {
      logger.error('Error preparing vouch transaction:', error);
      res.status(500).json({ error: 'Failed to prepare vouch transaction' });
    }
  }
);

// POST /api/vouch/:vouchId/prepare-revoke
router.post(
  '/:vouchId/prepare-revoke',
  authMiddleware,
  idempotencyMiddleware,
  [body('voucherPublicKey').isString().isLength({ min: 56, max: 56 })],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { vouchId } = req.params;
      const { voucherPublicKey } = req.body;
      if (req.user?.publicKey !== voucherPublicKey && !req.user?.isAdmin) {
        return res.status(403).json({ error: 'Unauthorized to revoke this vouch' });
      }
      const unsignedXdr = await stellarService.prepareRevokeVouchTx(voucherPublicKey, Number(vouchId));
      res.json({
        success: true,
        xdr: unsignedXdr,
        message: 'Unsigned vouch revocation & escrow refund prepared. Sign with Freighter.',
      });
    } catch (error) {
      logger.error('Error preparing revoke vouch transaction:', error);
      res.status(500).json({ error: 'Failed to prepare revoke vouch transaction' });
    }
  }
);

// POST /api/vouch/:vouchId/prepare-expire
router.post('/:vouchId/prepare-expire', authMiddleware, async (req: Request, res: Response) => {
  try {
    const unsignedXdr = await stellarService.prepareExpireVouchTx(
      req.user!.publicKey,
      Number(req.params.vouchId)
    );
    res.json({ success: true, xdr: unsignedXdr });
  } catch (error) {
    logger.error('Error preparing expire vouch transaction:', error);
    res.status(500).json({ error: 'Failed to prepare expire vouch transaction' });
  }
});

// POST /api/vouch/:vouchId/prepare-withdraw
router.post('/:vouchId/prepare-withdraw', authMiddleware, async (req: Request, res: Response) => {
  try {
    const unsignedXdr = await stellarService.prepareWithdrawRemainingVouchTx(
      req.user!.publicKey,
      Number(req.params.vouchId)
    );
    res.json({ success: true, xdr: unsignedXdr });
  } catch (error) {
    logger.error('Error preparing remaining escrow withdrawal:', error);
    res.status(500).json({ error: 'Failed to prepare withdrawal transaction' });
  }
});

// POST /api/vouch/submit — Confirms transaction on Soroban BEFORE updating DB
router.post(
  '/submit',
  authMiddleware,
  idempotencyMiddleware,
  [
    body('signedXDR').isString().notEmpty(),
    body('action').isIn(['create', 'revoke', 'expire', 'withdraw']),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { signedXDR, voucherPublicKey, voucheePublicKey, vouchId, action } = req.body;

      const result = await stellarService.submitTransaction(signedXDR);
      const actor = voucherPublicKey || req.user!.publicKey;
      const amountStroops = req.body.amount ? parseDecimalToStroops(req.body.amount) : '0';

      await dbService.recordStellarTx({
        txHash: result.hash,
        operationType: `vouch_${action}`,
        actorPublicKey: actor,
        status: 'confirmed',
        ledgerSequence: result.ledger,
        amountStroops,
      });

      if (action === 'create' && result.returnValue) {
        const newVouchId = Number(result.returnValue);
        const chainVouch = await stellarService.getVouch(newVouchId).catch(() => ({ returnValue: null }));
        const v = chainVouch.returnValue;
        await dbService.upsertVouch({
          id: newVouchId,
          voucherKey: actor,
          voucheeKey: voucheePublicKey || v?.vouchee || '',
          amount: v?.amount ? String(v.amount) : amountStroops,
          escrowedBalance: v?.escrowed_balance ? String(v.escrowed_balance) : amountStroops,
          trustScore: Number(v?.trust_score ?? 0),
          reason: req.body.reason || v?.reason || '',
          isActive: true,
          withdrawn: false,
          txHash: result.hash,
        });
      } else if ((action === 'revoke' || action === 'expire' || action === 'withdraw') && vouchId) {
        await dbService.updateVouchStatus(vouchId, false, true);
      }

      if (voucheePublicKey) {
        await redisCache.del(`vouches:user:${voucheePublicKey}`);
        await redisCache.del(`credit_score:${voucheePublicKey}`);
      }
      await redisCache.del(`vouches:user:${actor}`);

      res.json({
        success: true,
        transactionHash: result.hash,
        ledger: result.ledger,
        data: typeof result.returnValue === 'bigint' ? result.returnValue.toString() : result.returnValue,
        message: 'Vouch transaction confirmed on Stellar Soroban.',
      });
    } catch (error) {
      logger.error('Error submitting vouch transaction:', error);
      res.status(500).json({ error: 'Failed to submit and confirm vouch transaction' });
    }
  }
);

// GET /api/vouch/user/:userPublicKey
router.get('/user/:userPublicKey', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { userPublicKey } = req.params;
    if (req.user?.publicKey !== userPublicKey && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to view vouches for this user' });
    }

    let vouches: any[] = await dbService.getUserVouches(userPublicKey);
    if (!vouches.length) {
      try {
        const idsRes = await stellarService.getUserVouches(userPublicKey);
        const ids: any[] = Array.isArray(idsRes.returnValue) ? idsRes.returnValue : [];
        const loaded = await Promise.all(
          ids.map(async (id) => {
            const vRes = await stellarService.getVouch(Number(id)).catch(() => ({ returnValue: null }));
            if (!vRes.returnValue) return null;
            const v = vRes.returnValue;
            return {
              id: Number(v.id),
              voucher_key: v.voucher,
              vouchee_key: v.vouchee,
              amount: String(v.amount),
              escrowed_balance: String(v.escrowed_balance),
              slashed_amount: String(v.slashed_amount),
              trust_score: Number(v.trust_score),
              reason: v.reason,
              is_active: Boolean(v.is_active),
              withdrawn: Boolean(v.withdrawn),
              expiration_date: v.expiration_date ? new Date(Number(v.expiration_date) * 1000).toISOString() : null,
            };
          })
        );
        vouches = loaded.filter(Boolean);
      } catch {
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
