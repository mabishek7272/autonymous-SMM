import Redis from 'ioredis';
import { logger } from './logger';

export const redis = new Redis({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  retryStrategy: (times) => {
    const delay = Math.min(times * 200, 5000);
    if (times % 10 === 1) logger.warn(`Redis reconnecting (attempt ${times}), next attempt in ${delay}ms`);
    return delay;
  },
  lazyConnect: true,
  enableOfflineQueue: false,
});

redis.on('error', (err) => {
  // Silent catch after max retries
});
redis.on('connect', () => logger.info('Redis connection established'));

export async function connectRedis(): Promise<void> {
  await redis.connect();
}

/** Queue connection (separate from the main read/write client) */
export const queueRedis = new Redis({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null, // Required by BullMQ
  retryStrategy: (times) => {
    return Math.min(times * 200, 5000);
  },
  lazyConnect: true,
  enableOfflineQueue: false,
});
queueRedis.on('error', () => {});
