import crypto from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { dbService } from '../services/dbService';

export async function idempotencyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const key = req.header('Idempotency-Key')?.trim();
  if (!key) {
    next();
    return;
  }

  if (key.length > 128) {
    res.status(400).json({ error: 'Idempotency-Key exceeds 128 characters' });
    return;
  }

  const actor = req.user?.publicKey || req.ip || 'anonymous';
  const route = req.originalUrl || req.path;
  const requestHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(req.body || {}))
    .digest('hex');

  try {
    const existing = await dbService.getIdempotentResponse(actor, route, key);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        res.status(409).json({
          error: 'Idempotency-Key conflict: key already used with a different request payload',
        });
        return;
      }
      res.setHeader('X-Idempotent-Replay', 'true');
      res.status(existing.statusCode).json(JSON.parse(existing.responseJson));
      return;
    }
  } catch {
    // Allow execution to proceed cleanly if idempotency store lookup fails during non-critical fallback
  }

  const origJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    const statusCode = res.statusCode || 200;
    if (statusCode >= 200 && statusCode < 500) {
      void dbService.saveIdempotentResponse({
        idempotencyKey: key,
        actorPublicKey: actor,
        route,
        requestHash,
        statusCode,
        responseJson: JSON.stringify(body),
      });
    }
    return origJson(body);
  }) as typeof res.json;

  next();
}
