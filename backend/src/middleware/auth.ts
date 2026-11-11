import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { logger } from '../utils/logger';
import { redisCache } from '../config/redis';

export type UserRole = 'borrower' | 'lender' | 'issuer' | 'admin';

export interface AuthUser {
  publicKey: string;
  role: UserRole;
  roles: UserRole[];
  isAdmin: boolean;
  jti?: string;
  sessionId?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const revokedJtiMemory = new Map<string, number>();

export function resolveJwtSecret(): string {
  const configured = process.env.JWT_SECRET || '';
  if (process.env.NODE_ENV === 'production') {
    if (!configured || configured.length < 32 || configured === 'your-super-secret-jwt-key') {
      throw new Error('JWT_SECRET must be at least 32 characters in production');
    }
    return configured;
  }
  return configured || (process.env.NODE_ENV === 'test' ? 'creditledger-test-jwt-secret-key-min-32b' : '');
}

export async function revokeAccessJti(jti: string, ttlSeconds = 900): Promise<void> {
  if (!jti) return;
  revokedJtiMemory.set(jti, Date.now() + ttlSeconds * 1000);
  try {
    await redisCache.set(`auth:revoked_jti:${jti}`, { revokedAt: Date.now() }, ttlSeconds);
  } catch (err) {
    logger.warn('Failed to persist JTI revocation in Redis:', err);
  }
}

export async function isAccessJtiRevoked(jti?: string): Promise<boolean> {
  if (!jti) return false;
  const memExp = revokedJtiMemory.get(jti);
  if (memExp && memExp > Date.now()) {
    return true;
  }
  if (memExp && memExp <= Date.now()) {
    revokedJtiMemory.delete(jti);
  }
  try {
    const cached = await redisCache.get(`auth:revoked_jti:${jti}`);
    return Boolean(cached);
  } catch {
    return false;
  }
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  let token = '';

  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else if (typeof req.headers.cookie === 'string') {
    const cookieMatch = req.headers.cookie.match(/(?:^|;\s*)cl_access=([^;]+)/);
    if (cookieMatch) {
      token = decodeURIComponent(cookieMatch[1]);
    }
  }

  if (!token) {
    res.status(401).json({ error: 'Missing or invalid authorization token' });
    return;
  }

  let jwtSecret = '';
  try {
    jwtSecret = resolveJwtSecret();
  } catch (err) {
    logger.error('JWT configuration error:', err);
    res.status(500).json({ error: 'Authentication configuration error' });
    return;
  }

  if (!jwtSecret) {
    logger.error('JWT_SECRET is not configured');
    res.status(500).json({ error: 'Authentication configuration error' });
    return;
  }

  try {
    const payload = jwt.verify(token, jwtSecret, {
      algorithms: ['HS256'],
      issuer: 'creditledger-api',
    }) as Partial<AuthUser> & { jti?: string; exp?: number };

    if (!payload.publicKey) {
      res.status(401).json({ error: 'Invalid token subject' });
      return;
    }

    if (await isAccessJtiRevoked(payload.jti)) {
      res.status(401).json({ error: 'Session has been revoked' });
      return;
    }

    const roles: UserRole[] = Array.isArray(payload.roles) && payload.roles.length > 0
      ? payload.roles
      : [payload.role || (payload.isAdmin ? 'admin' : 'borrower')];

    req.user = {
      publicKey: payload.publicKey,
      role: payload.role || roles[0],
      roles,
      isAdmin: Boolean(payload.isAdmin || roles.includes('admin')),
      jti: payload.jti,
      sessionId: payload.sessionId,
    };
    next();
  } catch (error) {
    logger.warn('Invalid JWT token:', error);
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireRoles(...allowed: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const hasMatch =
      req.user.isAdmin ||
      allowed.some((role) => req.user!.roles.includes(role) || req.user!.role === role);
    if (!hasMatch) {
      res.status(403).json({ error: `Forbidden: requires role ${allowed.join(' or ')}` });
      return;
    }
    next();
  };
}

export const requireAdmin = requireRoles('admin');
