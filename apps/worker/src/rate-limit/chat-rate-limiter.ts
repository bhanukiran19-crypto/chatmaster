import { Redis as IORedis } from 'ioredis';

export interface ChatRateLimiter {
  /**
   * Enforces that messages to a specific chat on a connection are spaced
   * by at least the required interval (default ~1000ms, adhering to Telegram's 1 msg/s per chat limit).
   */
  acquire(platformConnectionId: string, chatId: string): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RedisChatRateLimiter implements ChatRateLimiter {
  private readonly redis: IORedis | null = null;
  private readonly memoryTimestamps = new Map<string, number>();
  private readonly minIntervalMs: number;

  constructor(redisUrl?: string, minIntervalMs = 1000) {
    this.minIntervalMs = minIntervalMs;
    const url = redisUrl ?? process.env['REDIS_URL'];
    if (url) {
      this.redis = new IORedis(url, {
        maxRetriesPerRequest: 1,
        lazyConnect: true,
      });
    }
  }

  async acquire(platformConnectionId: string, chatId: string): Promise<void> {
    const key = `chatmaster:ratelimit:chat:${platformConnectionId}:${chatId}`;
    const now = Date.now();

    if (this.redis) {
      const lastSentStr = await this.redis.get(key);
      const lastSent = lastSentStr ? Number(lastSentStr) : 0;
      const elapsed = now - lastSent;

      if (elapsed < this.minIntervalMs) {
        const waitTime = this.minIntervalMs - elapsed;
        await sleep(waitTime);
      }

      await this.redis.set(key, String(Date.now()), 'EX', 10);
      return;
    }

    const lastSent = this.memoryTimestamps.get(key) ?? 0;
    const elapsed = now - lastSent;
    if (elapsed < this.minIntervalMs) {
      const waitTime = this.minIntervalMs - elapsed;
      await sleep(waitTime);
    }
    this.memoryTimestamps.set(key, Date.now());
  }
}
