import { Request, Response, NextFunction } from 'express';
import { RateLimiterMemory } from 'rate-limiter-flexible';

const limiter = new RateLimiterMemory({
  points: 100,       // requests
  duration: 60,      // per 60 seconds
});

export async function rateLimiter(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await limiter.consume(req.ip ?? 'unknown');
    next();
  } catch {
    res.status(429).json({ error: 'Too many requests, please try again later.' });
  }
}
