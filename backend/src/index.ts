import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { connectDatabase, disconnectDatabase, isDatabaseAvailable } from './config/database';
import { connectRedis, disconnectRedis, isRedisAvailable } from './config/redis';
import { logger } from './utils/logger';
import { errorHandler } from './middleware/errorHandler';
import { rateLimiter } from './middleware/rateLimiter';
import { resolveJwtSecret } from './middleware/auth';
import { resolveEncryptionKey } from './services/privacyService';
import { authRoutes } from './controllers/auth';
import { creditScoreRoutes } from './controllers/creditScore';
import { loanRoutes } from './controllers/loan';
import { vouchRoutes } from './controllers/vouch';
import { userRoutes } from './controllers/user';
import { stellarService } from './services/stellarService';

dotenv.config();

const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 3001;
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction) {
  app.set('trust proxy', 1);
  // Enforce HTTPS redirect / rejection behind reverse proxy in production
  app.use((req, res, next) => {
    const proto = req.header('x-forwarded-proto');
    if (proto && proto !== 'https' && req.path !== '/health') {
      return res.status(403).json({ error: 'HTTPS is required in production' });
    }
    return next();
  });
}

const allowedOrigins = (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || 'http://localhost:3000')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(helmet());
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Origin not allowed by CORS policy'));
    },
    credentials: true,
  })
);
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(rateLimiter);

app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    dependencies: {
      postgres: isDatabaseAvailable(),
      redis: isRedisAvailable(),
    },
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/credit-score', creditScoreRoutes);
app.use('/api/loans', loanRoutes);
app.use('/api/vouch', vouchRoutes);
app.use('/api/users', userRoutes);

app.use(errorHandler);

app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.originalUrl,
  });
});

let reconcilerTimer: NodeJS.Timeout | null = null;

async function startServer() {
  try {
    resolveJwtSecret();
    resolveEncryptionKey();

    try {
      await connectDatabase();
    } catch {
      if (isProduction) {
        throw new Error('PostgreSQL connection required in production');
      }
      logger.warn('Database offline in non-production mode');
    }

    try {
      await connectRedis();
    } catch {
      if (isProduction) {
        throw new Error('Redis connection required in production');
      }
      logger.warn('Redis offline in non-production mode');
    }

    await stellarService.initialize();

    reconcilerTimer = setInterval(() => {
      void stellarService.reconcilePendingTransactions().catch((err) => {
        logger.warn('Background reconciliation cycle error:', err);
      });
    }, 30_000);

    server.listen(PORT, () => {
      logger.info(`Server running on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

async function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down gracefully`);
  if (reconcilerTimer) clearInterval(reconcilerTimer);
  server.close(async () => {
    await disconnectRedis().catch(() => undefined);
    await disconnectDatabase().catch(() => undefined);
    process.exit(0);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

if (process.env.NODE_ENV !== 'test') {
  void startServer();
}

export { app, server };
