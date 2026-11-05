import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { logger } from '../utils/logger';

export interface AuthUser {
  publicKey: string;
  isAdmin: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }

  const token = authHeader.slice(7);
  const jwtSecret = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'secret');

  if (!jwtSecret) {
    logger.error('JWT_SECRET is not configured in production');
    res.status(500).json({ error: 'Authentication configuration error' });
    return;
  }

  try {
    const payload = jwt.verify(token, jwtSecret) as AuthUser;
    req.user = payload;
    next();
  } catch (error) {
    logger.warn('Invalid JWT token:', error);
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
