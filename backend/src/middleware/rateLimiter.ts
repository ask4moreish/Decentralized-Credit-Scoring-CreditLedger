import { Request, Response, NextFunction } from 'express';
import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';
import { getRedisClient, isRedisAvailable } from '../config/redis';

const memoryApiLimiter = new RateLimiterMemory({
  points: 120,
  duration: 60,
});

const memoryAuthLimiter = new RateLimiterMemory({
  points: 20,
  duration: 60,
});

let redisApiLimiter: RateLimiterRedis | null = null;
let redisAuthLimiter: RateLimiterRedis | null = null;

function getApiLimiter() {
  if (isRedisAvailable()) {
    if (!redisApiLimiter) {
      redisApiLimiter = new RateLimiterRedis({
        storeClient: getRedisClient() as any,
        keyPrefix: 'rl:api',
        points: 120,
        duration: 60,
        insuranceLimiter: memoryApiLimiter,
      });
    }
    return redisApiLimiter;
  }
  return memoryApiLimiter;
}

function getAuthLimiter() {
  if (isRedisAvailable()) {
    if (!redisAuthLimiter) {
      redisAuthLimiter = new RateLimiterRedis({
        storeClient: getRedisClient() as any,
        keyPrefix: 'rl:auth',
        points: 20,
        duration: 60,
        insuranceLimiter: memoryAuthLimiter,
      });
    }
    return redisAuthLimiter;
  }
  return memoryAuthLimiter;
}

export async function rateLimiter(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await getApiLimiter().consume(req.ip ?? 'unknown');
    next();
  } catch {
    res.status(429).json({ error: 'Too many requests, please try again later.' });
  }
}

export async function authRateLimiter(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (process.env.NODE_ENV === 'test') {
    next();
    return;
  }
  try {
    await getAuthLimiter().consume(req.ip ?? 'unknown');
    next();
  } catch {
    res.status(429).json({ error: 'Too many authentication attempts, please slow down.' });
  }
}
