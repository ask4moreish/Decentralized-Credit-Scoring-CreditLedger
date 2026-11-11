import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { body, validationResult } from 'express-validator';
import crypto from 'node:crypto';
import { logger } from '../utils/logger';
import { redisCache } from '../config/redis';
import { dbService } from '../services/dbService';
import {
  authMiddleware,
  resolveJwtSecret,
  revokeAccessJti,
  UserRole,
} from '../middleware/auth';
import { authRateLimiter } from '../middleware/rateLimiter';

const router = Router();

const CHALLENGE_TTL_SECS = 300;
const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Used ONLY outside production when Redis is unavailable (e.g. Jest unit tests)
const devMemoryChallenges = new Map<string, { expiresAt: number }>();

function parseKeyList(envVal?: string): Set<string> {
  return new Set(
    (envVal || '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean)
  );
}

function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function resolveUserRoles(publicKey: string, requestedRole?: string): { role: UserRole; roles: UserRole[]; isAdmin: boolean } {
  const adminKeys = parseKeyList(process.env.ADMIN_PUBLIC_KEYS);
  const issuerKeys = parseKeyList(process.env.ISSUER_PUBLIC_KEYS);

  const roles: UserRole[] = [];
  const isAdmin = adminKeys.has(publicKey);
  if (isAdmin) roles.push('admin');
  if (issuerKeys.has(publicKey)) roles.push('issuer');

  if (requestedRole === 'lender') {
    if (!roles.includes('lender')) roles.push('lender');
  } else if (!roles.includes('borrower')) {
    roles.push('borrower');
  }
  if (!roles.includes('lender')) roles.push('lender');

  const primaryRole: UserRole = isAdmin
    ? 'admin'
    : issuerKeys.has(publicKey)
      ? 'issuer'
      : requestedRole === 'lender'
        ? 'lender'
        : 'borrower';

  return { role: primaryRole, roles, isAdmin };
}

async function storeChallengeNonce(challenge: string): Promise<void> {
  const key = `auth:challenge:${challenge}`;
  if (redisCache.isConnected()) {
    await redisCache.set(key, { createdAt: Date.now() }, CHALLENGE_TTL_SECS);
    return;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('Redis is required for authentication challenges in production');
  }

  const now = Date.now();
  for (const [k, v] of devMemoryChallenges.entries()) {
    if (v.expiresAt <= now) devMemoryChallenges.delete(k);
  }
  devMemoryChallenges.set(challenge, { expiresAt: now + CHALLENGE_TTL_SECS * 1000 });
}

/**
 * Atomically consumes a challenge nonce once.
 * Concurrent attempts racing on the same nonce can succeed at most once.
 */
export async function consumeChallengeNonce(challenge: string): Promise<boolean> {
  const key = `auth:challenge:${challenge}`;
  if (redisCache.isConnected()) {
    const consumed = await redisCache.getAndDelete<{ createdAt?: number }>(key);
    if (!consumed) return false;
    if (consumed.createdAt && Date.now() - consumed.createdAt > CHALLENGE_TTL_SECS * 1000) {
      return false;
    }
    return true;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('Redis is unavailable for authentication nonce verification in production');
  }

  const entry = devMemoryChallenges.get(challenge);
  if (!entry) return false;
  // Delete synchronously before returning so sequential or concurrent awaits cannot double-consume
  devMemoryChallenges.delete(challenge);
  return entry.expiresAt > Date.now();
}

function issueAccessJwt(params: {
  publicKey: string;
  role: UserRole;
  roles: UserRole[];
  isAdmin: boolean;
  sessionId: string;
}): { token: string; jti: string } {
  const jwtSecret = resolveJwtSecret();
  if (!jwtSecret) {
    throw new Error('JWT_SECRET is not configured');
  }
  const jti = crypto.randomUUID();
  const token = jwt.sign(
    {
      publicKey: params.publicKey,
      role: params.role,
      roles: params.roles,
      isAdmin: params.isAdmin,
      sessionId: params.sessionId,
      jti,
    },
    jwtSecret,
    {
      algorithm: 'HS256',
      issuer: 'creditledger-api',
      expiresIn: ACCESS_TOKEN_TTL,
    }
  );
  return { token, jti };
}

function setSessionCookies(res: Response, accessToken: string, refreshToken: string): void {
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie('cl_access', accessToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    maxAge: 15 * 60 * 1000,
    path: '/',
  });
  res.cookie('cl_refresh', refreshToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    maxAge: REFRESH_TOKEN_TTL_MS,
    path: '/api/auth',
  });
}

// GET /api/auth/challenge
router.get('/challenge', authRateLimiter, async (_req: Request, res: Response) => {
  try {
    const challenge = crypto.randomBytes(32).toString('hex');
    await storeChallengeNonce(challenge);
    res.json({ challenge, expiresInSeconds: CHALLENGE_TTL_SECS });
  } catch (error) {
    logger.error('Error generating challenge:', error);
    const status = process.env.NODE_ENV === 'production' ? 503 : 500;
    res.status(status).json({ error: 'Authentication challenge service unavailable' });
  }
});

// POST /api/auth/login
router.post(
  '/login',
  authRateLimiter,
  [
    body('publicKey').isString().isLength({ min: 56, max: 56 }),
    body('signature').isString().notEmpty(),
    body('challenge').isString().isLength({ min: 32, max: 128 }),
    body('role').optional().isIn(['borrower', 'lender']),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { publicKey, signature, challenge, role: requestedRole } = req.body;

      if (!StrKey.isValidEd25519PublicKey(publicKey)) {
        return res.status(400).json({ error: 'Invalid Stellar Ed25519 public key' });
      }

      let isValidNonce = false;
      try {
        isValidNonce = await consumeChallengeNonce(challenge);
      } catch (redisErr) {
        logger.error('Redis unavailable during login:', redisErr);
        return res.status(503).json({ error: 'Authentication challenge store unavailable' });
      }

      if (!isValidNonce) {
        return res.status(401).json({ error: 'Invalid or expired challenge nonce' });
      }

      let isValidSignature = false;
      try {
        const keypair = Keypair.fromPublicKey(publicKey);
        const sigBuf = /^[0-9a-fA-F]+$/.test(signature)
          ? Buffer.from(signature, 'hex')
          : Buffer.from(signature, 'base64');
        if (sigBuf.length === 64) {
          const rawMessage = Buffer.from(challenge, 'utf8');
          const sep53Digest = crypto
            .createHash('sha256')
            .update(Buffer.concat([Buffer.from('Stellar Signed Message:\n', 'utf8'), rawMessage]))
            .digest();
          isValidSignature =
            keypair.verify(rawMessage, sigBuf) || keypair.verify(sep53Digest, sigBuf);
        }
      } catch (keyErr) {
        logger.warn('Signature verification failed:', keyErr);
        return res.status(401).json({ error: 'Invalid public key or signature encoding' });
      }

      if (!isValidSignature) {
        await dbService.recordAuditLog({
          actorPublicKey: publicKey,
          action: 'auth_login_failed',
          status: 'rejected',
        });
        return res.status(401).json({ error: 'Invalid signature' });
      }

      const { role, roles, isAdmin } = resolveUserRoles(publicKey, requestedRole);
      await dbService.upsertUser(publicKey, role);

      const sessionId = crypto.randomUUID();
      const familyId = crypto.randomUUID();
      const rawRefreshToken = crypto.randomBytes(48).toString('hex');
      const { token, jti } = issueAccessJwt({ publicKey, role, roles, isAdmin, sessionId });

      await dbService.createSession({
        id: sessionId,
        familyId,
        publicKey,
        role,
        refreshTokenHash: hashToken(rawRefreshToken),
        accessJti: jti,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      });

      await dbService.recordAuditLog({
        actorPublicKey: publicKey,
        action: 'auth_login_success',
        resourceType: 'session',
        resourceId: sessionId,
        status: 'ok',
        details: { role },
      });

      setSessionCookies(res, token, rawRefreshToken);
      res.json({
        token,
        refreshToken: rawRefreshToken,
        publicKey,
        role,
        roles,
        isAdmin,
        expiresIn: ACCESS_TOKEN_TTL,
      });
    } catch (error) {
      logger.error('Login error:', error);
      res.status(500).json({ error: 'Authentication failed' });
    }
  }
);

// POST /api/auth/refresh — Rotates single-use refresh token and detects reuse attacks
router.post('/refresh', authRateLimiter, async (req: Request, res: Response) => {
  try {
    let rawRefreshToken = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : '';
    if (!rawRefreshToken && typeof req.headers.cookie === 'string') {
      const m = req.headers.cookie.match(/(?:^|;\s*)cl_refresh=([^;]+)/);
      if (m) rawRefreshToken = decodeURIComponent(m[1]);
    }
    if (!rawRefreshToken) {
      return res.status(401).json({ error: 'Refresh token required' });
    }

    const session = await dbService.findSessionByRefreshHash(hashToken(rawRefreshToken));
    if (!session) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    // Reuse detection: revoked refresh token re-presented -> compromise suspected -> kill entire family
    if (session.revokedAt) {
      const jtis = await dbService.revokeSessionFamily(session.familyId);
      for (const j of jtis) await revokeAccessJti(j);
      await dbService.recordAuditLog({
        actorPublicKey: session.publicKey,
        action: 'refresh_token_reuse_detected',
        resourceType: 'session_family',
        resourceId: session.familyId,
        status: 'revoked',
      });
      return res.status(401).json({ error: 'Refresh token reuse detected; session family revoked' });
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      return res.status(401).json({ error: 'Refresh token expired' });
    }

    await revokeAccessJti(session.accessJti);
    const { role, roles, isAdmin } = resolveUserRoles(session.publicKey, session.role);
    const nextSessionId = crypto.randomUUID();
    const nextRefresh = crypto.randomBytes(48).toString('hex');
    const { token, jti } = issueAccessJwt({
      publicKey: session.publicKey,
      role,
      roles,
      isAdmin,
      sessionId: nextSessionId,
    });

    await dbService.rotateSession(session.id, {
      id: nextSessionId,
      familyId: session.familyId,
      publicKey: session.publicKey,
      role,
      refreshTokenHash: hashToken(nextRefresh),
      accessJti: jti,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    });

    setSessionCookies(res, token, nextRefresh);
    res.json({
      token,
      refreshToken: nextRefresh,
      publicKey: session.publicKey,
      role,
      roles,
      isAdmin,
      expiresIn: ACCESS_TOKEN_TTL,
    });
  } catch (error) {
    logger.error('Refresh error:', error);
    res.status(500).json({ error: 'Failed to refresh session' });
  }
});

// POST /api/auth/logout — Revokes active JWT and session family
router.post('/logout', authMiddleware, async (req: Request, res: Response) => {
  try {
    if (req.user?.jti) {
      await revokeAccessJti(req.user.jti);
    }
    if (req.user?.publicKey) {
      const jtis = await dbService.revokeUserSessions(req.user.publicKey);
      for (const j of jtis) await revokeAccessJti(j);
      await dbService.recordAuditLog({
        actorPublicKey: req.user.publicKey,
        action: 'auth_logout',
        status: 'ok',
      });
    }
    res.clearCookie('cl_access', { path: '/' });
    res.clearCookie('cl_refresh', { path: '/api/auth' });
    res.json({ success: true, message: 'Logged out and session revoked' });
  } catch (error) {
    logger.error('Logout error:', error);
    res.status(500).json({ error: 'Failed to logout cleanly' });
  }
});

export { router as authRoutes, devMemoryChallenges as _devMemoryChallengesForTest };
