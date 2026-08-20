import { Redis } from "ioredis";
import type { AppEnv } from "../config/env.js";
import type { AppLogger } from "../common/logger.js";
import type { PersistenceStore } from "./store.js";

export class RedisPersistenceStore implements PersistenceStore {
  constructor(private readonly redis: Redis) {}

  async get(key: string): Promise<string | null> {
    return await this.redis.get(key);
  }

  async set(
    key: string,
    value: string,
    mode?: "EX",
    ttlSeconds?: number
  ): Promise<"OK"> {
    if (mode === "EX" && ttlSeconds !== undefined) {
      return await this.redis.set(key, value, mode, ttlSeconds);
    }
    return await this.redis.set(key, value);
  }

  async rpush(key: string, value: string): Promise<number> {
    return await this.redis.rpush(key, value);
  }

  async llen(key: string): Promise<number> {
    return await this.redis.llen(key);
  }

  async expire(key: string, ttlSeconds: number): Promise<number> {
    return await this.redis.expire(key, ttlSeconds);
  }

  async lrange(key: string, start: number, end: number): Promise<string[]> {
    return await this.redis.lrange(key, start, end);
  }

  async quit(): Promise<unknown> {
    return await this.redis.quit();
  }

  async connect(): Promise<void> {
    await this.redis.connect();
  }

  disconnect(): void {
    this.redis.disconnect(false);
  }
}

export function createRedisClient(
  env: AppEnv,
  logger: AppLogger
): RedisPersistenceStore {
  const redis = new Redis(env.REDIS_URL, {
    keyPrefix: env.REDIS_KEY_PREFIX,
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    // Redis is a hard startup dependency. Do not leave Fastify half-ready
    // while ioredis retries a connection that may never become available.
    retryStrategy: () => null
  });

  redis.on("error", (error) => {
    logger.error({ error }, "redis_error");
  });

  return new RedisPersistenceStore(redis);
}
