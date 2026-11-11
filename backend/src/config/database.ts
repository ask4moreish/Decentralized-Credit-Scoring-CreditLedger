import knex, { Knex } from 'knex';
import { logger } from '../utils/logger';

let dbAvailable = false;

function buildDbConfig(): Knex.Config {
  const isProd = process.env.NODE_ENV === 'production';
  const password = process.env.DB_PASSWORD || '';
  if (isProd && (!password || password === 'postgres123')) {
    throw new Error('DB_PASSWORD must be explicitly configured with a non-default secret in production');
  }

  return {
    client: 'postgresql',
    connection: {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      user: process.env.DB_USER || 'postgres',
      password,
      database: process.env.DB_NAME || 'credit_ledger',
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : undefined,
    },
    pool: {
      min: process.env.NODE_ENV === 'test' ? 0 : 2,
      max: 10,
      acquireTimeoutMillis: 15000,
      createTimeoutMillis: 15000,
      destroyTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      reapIntervalMillis: 1000,
      createRetryIntervalMillis: 100,
    },
    migrations: {
      directory: './migrations',
      tableName: 'knex_migrations',
    },
    seeds: {
      directory: './seeds',
    },
  };
}

export const db = knex(buildDbConfig());

export function isDatabaseAvailable(): boolean {
  return dbAvailable;
}

export async function connectDatabase(): Promise<void> {
  try {
    await db.raw('SELECT 1');
    dbAvailable = true;
    logger.info('Database connection established');
  } catch (error) {
    dbAvailable = false;
    logger.error('Database connection failed:', error);
    throw error;
  }
}

export async function disconnectDatabase(): Promise<void> {
  try {
    await db.destroy();
    dbAvailable = false;
    logger.info('Database connection closed');
  } catch (error) {
    logger.error('Error closing database connection:', error);
    throw error;
  }
}
