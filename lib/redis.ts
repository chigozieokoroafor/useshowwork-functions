import Redis from 'ioredis';
import type { ConnectionOptions } from 'bullmq';
import dotenv from 'dotenv';
dotenv.config();

export function getRedisUrl(): string {
  return process.env.REDIS_URL || 'redis://127.0.0.1:6379';
}

export function getRedisConnection(): ConnectionOptions {
  const url = getRedisUrl();
  const parsed = new URL(url);
  return {
    host: parsed.hostname || '127.0.0.1',
    port: parsed.port ? parseInt(parsed.port, 10) : 6379,
    password: parsed.password || undefined,
    username: parsed.username || undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}

let sharedRedis: Redis | null = null;

export function getSharedRedisClient(): Redis {
  if (!sharedRedis) {
    sharedRedis = new Redis(getRedisUrl(), {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      retryStrategy(times: number) {
        return Math.min(times * 100, 3000);
      },
    });
  }
  return sharedRedis;
}
