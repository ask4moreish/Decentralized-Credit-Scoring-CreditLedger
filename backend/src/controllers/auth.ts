import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Keypair } from '@stellar/stellar-sdk';
import { body, validationResult } from 'express-validator';
import crypto from 'crypto';
import { logger } from '../utils/logger';
import { redisCache } from '../config/redis';
import { dbService } from '../services/dbService';

const router = Router();

const ADMIN_PUBLIC_KEYS = (process.env.ADMIN_PUBLIC_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);

// In-memory fallback challenge store if Redis is unavailable
const memoryChallenges = new Map<string, number>();
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cleanExpiredMemoryChallenges() {
  const now = Date.now();
  for (const [nonce, expiresAt] of memoryChallenges.entries()) {
    if (expiresAt < now) {
      memoryChallenges.delete(nonce);
    }
  }
}

async function storeChallengeNonce(challenge: string): Promise<void> {
  cleanExpiredMemoryChallenges();
  memoryChallenges.set(challenge, Date.now() + CHALLENGE_TTL_MS);
  try {
    await redisCache.set(`auth:challenge:${challenge}`, { createdAt: Date.now() }, 300);
  } catch (err) {
    logger.warn('Failed to store challenge in Redis, using memory store:', err);
  }
}

async function consumeChallengeNonce(challenge: string): Promise<boolean> {
  cleanExpiredMemoryChallenges();
  let valid = false;

  // Check Redis
  try {
    const cached = await redisCache.get(`auth:challenge:${challenge}`);
    if (cached) {
      valid = true;
      await redisCache.del(`auth:challenge:${challenge}`);
    }
  } catch (err) {
    logger.warn('Failed to check Redis challenge:', err);
  }

  // Check memory store
  if (memoryChallenges.has(challenge)) {
    const expiresAt = memoryChallenges.get(challenge)!;
    memoryChallenges.delete(challenge);
    if (expiresAt > Date.now()) {
      valid = true;
    }
  }

  return valid;
}

// GET /api/auth/challenge
// Returns a random challenge string for the client to sign
router.get('/challenge', async (_req: Request, res: Response) => {
  try {
    const challenge = crypto.randomBytes(32).toString('hex');
    await storeChallengeNonce(challenge);
    res.json({ challenge });
  } catch (error) {
    logger.error('Error generating challenge:', error);
    res.status(500).json({ error: 'Failed to generate challenge' });
  }
});

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

      // Single-use challenge verification
      const isValidNonce = await consumeChallengeNonce(challenge);
      if (!isValidNonce) {
        return res.status(401).json({ error: 'Invalid or expired challenge nonce' });
      }

      // Verify the challenge signature using Stellar Keypair
      let isValidSignature = false;
      try {
        const keypair = Keypair.fromPublicKey(publicKey);
        isValidSignature = keypair.verify(Buffer.from(challenge), Buffer.from(signature, 'hex'));
      } catch (keyErr) {
        logger.error('Keypair verification error:', keyErr);
        return res.status(401).json({ error: 'Invalid public key or signature encoding' });
      }

      if (!isValidSignature) {
        return res.status(401).json({ error: 'Invalid signature' });
      }

      const isAdmin = ADMIN_PUBLIC_KEYS.includes(publicKey);

      // Persist user to PostgreSQL
      await dbService.upsertUser(publicKey);

      const jwtSecret = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'secret');
      if (!jwtSecret) {
        logger.error('JWT_SECRET is not configured in production');
        return res.status(500).json({ error: 'Server authentication configuration error' });
      }

      const token = jwt.sign(
        { publicKey, isAdmin },
        jwtSecret,
        { expiresIn: '24h' }
      );

      logger.info(`User authenticated: ${publicKey} (isAdmin: ${isAdmin})`);
      res.json({ token, publicKey, isAdmin });
    } catch (error) {
      logger.error('Login error:', error);
      res.status(500).json({ error: 'Authentication failed' });
    }
  }
);

export { router as authRoutes };
