import { createClient, RedisClientType } from 'redis';
import { logger } from '../utils/logger';

let redisClient: RedisClientType | null = null;

export async function connectRedis(): Promise<RedisClientType> {
  try {
    redisClient = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      socket: {
        connectTimeout: 5000,
      },
    });

    redisClient.on('error', (err) => {
      logger.error('Redis Client Error:', err);
    });

    redisClient.on('connect', () => {
      logger.info('Redis Client Connected');
    });

    redisClient.on('ready', () => {
      logger.info('Redis Client Ready');
    });

    redisClient.on('end', () => {
      logger.info('Redis Client Disconnected');
    });

    await redisClient.connect();
    return redisClient;
  } catch (error) {
    logger.error('Failed to connect to Redis:', error);
    throw error;
  }
}

export function getRedisClient(): RedisClientType {
  if (!redisClient) {
    throw new Error('Redis client not initialized. Call connectRedis() first.');
  }
  return redisClient;
}

export function isRedisAvailable(): boolean {
  return Boolean(redisClient && redisClient.isOpen);
}

export async function disconnectRedis(): Promise<void> {
  try {
    if (redisClient) {
      await redisClient.quit();
      logger.info('Redis connection closed');
      redisClient = null;
    }
  } catch (error) {
    logger.error('Error closing Redis connection:', error);
    throw error;
  }
}

const ATOMIC_GETDEL_LUA = `
local val = redis.call('GET', KEYS[1])
if val then
  redis.call('DEL', KEYS[1])
end
return val
`;

export class RedisCache {
  private get client(): RedisClientType | null {
    return redisClient;
  }

  isConnected(): boolean {
    return Boolean(this.client && this.client.isOpen);
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    if (!this.client) return;
    const serializedValue = JSON.stringify(value);
    if (ttlSeconds && ttlSeconds > 0) {
      await this.client.setEx(key, ttlSeconds, serializedValue);
    } else {
      await this.client.set(key, serializedValue);
    }
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.client) return null;
    const value = await this.client.get(key);
    if (!value) return null;

    try {
      return JSON.parse(value) as T;
    } catch (error) {
      logger.error(`Error parsing Redis value for key ${key}:`, error);
      return null;
    }
  }

  /**
   * Atomically fetches and deletes a key in one Redis server step using GETDEL
   * (falling back to atomic Lua script), preventing concurrent TOCTOU replay.
   */
  async getAndDelete<T>(key: string): Promise<T | null> {
    if (!this.client) return null;

    let raw: string | null = null;
    const clientAny = this.client as unknown as {
      getDel?: (k: string) => Promise<string | null>;
      eval?: (script: string, opts: { keys: string[] }) => Promise<string | null>;
    };

    if (typeof clientAny.getDel === 'function') {
      raw = await clientAny.getDel(key);
    } else if (typeof clientAny.eval === 'function') {
      raw = await clientAny.eval(ATOMIC_GETDEL_LUA, { keys: [key] });
    } else {
      const value = await this.client.get(key);
      if (value) {
        const deleted = await this.client.del(key);
        raw = deleted > 0 ? value : null;
      }
    }

    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as unknown as T;
    }
  }

  async del(key: string): Promise<void> {
    if (!this.client) return;
    await this.client.del(key);
  }

  async exists(key: string): Promise<boolean> {
    if (!this.client) return false;
    const result = await this.client.exists(key);
    return result === 1;
  }

  async increment(key: string, amount = 1): Promise<number> {
    if (!this.client) return 0;
    return await this.client.incrBy(key, amount);
  }

  async expire(key: string, ttl: number): Promise<void> {
    if (!this.client) return;
    await this.client.expire(key, ttl);
  }

  async getTTL(key: string): Promise<number> {
    if (!this.client) return -2;
    return await this.client.ttl(key);
  }
}

export const redisCache = new RedisCache();
