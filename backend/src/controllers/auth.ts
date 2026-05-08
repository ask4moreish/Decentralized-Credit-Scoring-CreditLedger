import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Keypair } from '@stellar/stellar-sdk';
import { body, validationResult } from 'express-validator';
import { logger } from '../utils/logger';

const router = Router();

const ADMIN_PUBLIC_KEYS = (process.env.ADMIN_PUBLIC_KEYS || '').split(',').filter(Boolean);

// POST /api/auth/login
// Verifies a signed challenge to authenticate a Stellar wallet
router.post(
  '/login',
  [
    body('publicKey').isString().isLength({ min: 56, max: 56 }),
    body('signature').isString().notEmpty(),
    body('challenge').isString().notEmpty(),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { publicKey, signature, challenge } = req.body;

      // Verify the challenge signature using the Stellar keypair
      const keypair = Keypair.fromPublicKey(publicKey);
      const isValid = keypair.verify(Buffer.from(challenge), Buffer.from(signature, 'hex'));

      if (!isValid) {
        return res.status(401).json({ error: 'Invalid signature' });
      }

      const isAdmin = ADMIN_PUBLIC_KEYS.includes(publicKey);

      const token = jwt.sign(
        { publicKey, isAdmin },
        process.env.JWT_SECRET || 'secret',
        { expiresIn: '24h' }
      );

      logger.info(`User authenticated: ${publicKey}`);
      res.json({ token, publicKey, isAdmin });
    } catch (error) {
      logger.error('Login error:', error);
      res.status(500).json({ error: 'Authentication failed' });
    }
  }
);

// GET /api/auth/challenge
// Returns a random challenge string for the client to sign
router.get('/challenge', (_req: Request, res: Response) => {
  const challenge = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
  res.json({ challenge });
});

export { router as authRoutes };
