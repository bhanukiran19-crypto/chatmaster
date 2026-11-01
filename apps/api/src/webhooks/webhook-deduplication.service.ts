import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis as IORedis } from 'ioredis';

export interface WebhookDeduplicationService {
  /**
   * Attempts to mark the given update as seen for this connection.
   * Returns `true` if this update was ALREADY seen (i.e. is a duplicate).
   * Returns `false` if this is the first time the update is seen.
   */
  isDuplicate(connectionId: string, updateId: number): Promise<boolean>;
}

@Injectable()
export class RedisWebhookDeduplicationService implements WebhookDeduplicationService, OnModuleDestroy {
  private readonly redis: IORedis | null = null;
  private readonly memoryCache = new Map<string, number>();
  private readonly ttlSeconds = 86_400; // 24 hours

  constructor(redisUrl?: string) {
    const url = redisUrl ?? process.env['REDIS_URL'];
    if (url) {
      this.redis = new IORedis(url, {
        maxRetriesPerRequest: 1,
        lazyConnect: true,
      });
    }
  }

  onModuleDestroy(): void {
    this.redis?.disconnect();
  }

  async isDuplicate(connectionId: string, updateId: number): Promise<boolean> {
    const key = `chatmaster:dedupe:telegram:${connectionId}:${String(updateId)}`;

    if (this.redis) {
      // SET key 1 EX 86400 NX -> returns 'OK' if set, null if key already existed
      const result = await this.redis.set(key, '1', 'EX', this.ttlSeconds, 'NX');
      return result === null;
    }

    // In-memory fallback (used in test/dev environments without a Redis container)
    const now = Date.now();
    const expiresAt = this.memoryCache.get(key);
    if (expiresAt && expiresAt > now) {
      return true;
    }

    this.memoryCache.set(key, now + this.ttlSeconds * 1000);

    // Evict expired entries periodically if map grows large
    if (this.memoryCache.size > 10_000) {
      for (const [k, exp] of this.memoryCache.entries()) {
        if (exp <= now) this.memoryCache.delete(k);
      }
    }

    return false;
  }
}
