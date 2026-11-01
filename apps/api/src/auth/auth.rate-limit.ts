import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis as UpstashRedis } from '@upstash/redis';
import { Redis as IORedis } from 'ioredis';
import type { AuthRateLimiter } from './auth.contracts.js';

const WINDOWS: Record<string, { requests: number; duration: string; milliseconds: number }> = {
  signup: { requests: 4, duration: '1 h', milliseconds: 3_600_000 },
  login: { requests: 10, duration: '10 m', milliseconds: 600_000 },
  verifyEmail: { requests: 10, duration: '10 m', milliseconds: 600_000 },
  verifyMobile: { requests: 5, duration: '10 m', milliseconds: 600_000 },
  requestPasswordReset: { requests: 5, duration: '1 h', milliseconds: 3_600_000 },
  resetPassword: { requests: 10, duration: '10 m', milliseconds: 600_000 },
  refresh: { requests: 30, duration: '1 m', milliseconds: 60_000 },
};

const FIXED_WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return count
`;

@Injectable()
export class RedisAuthRateLimiter implements AuthRateLimiter, OnModuleDestroy {
  private readonly upstash: Map<string, Ratelimit> | null;
  private readonly redis: IORedis | null;

  constructor() {
    const restUrl = process.env['KV_REST_API_URL'] ?? process.env['UPSTASH_REDIS_REST_URL'];
    const restToken = process.env['KV_REST_API_TOKEN'] ?? process.env['UPSTASH_REDIS_REST_TOKEN'];
    if (restUrl && restToken) {
      const client = new UpstashRedis({ url: restUrl, token: restToken });
      this.upstash = new Map(
        Object.entries(WINDOWS).map(([name, window]) => [
          name,
          new Ratelimit({
            redis: client,
            limiter: Ratelimit.slidingWindow(
              window.requests,
              window.duration as `${number} ${'s' | 'm' | 'h' | 'd'}`,
            ),
            analytics: false,
            prefix: `chatmaster:auth:${name}`,
          }),
        ]),
      );
      this.redis = null;
    } else if (process.env['REDIS_URL']) {
      this.upstash = null;
      this.redis = new IORedis(process.env['REDIS_URL'], {
        maxRetriesPerRequest: 1,
        lazyConnect: true,
      });
    } else {
      this.upstash = null;
      this.redis = null;
    }
  }

  onModuleDestroy(): void {
    this.redis?.disconnect();
  }

  async consume(action: string, ip: string, subject = ''): Promise<boolean> {
    const window = WINDOWS[action];
    if (!window) throw new Error(`Unknown auth rate-limit action: ${action}`);
    const ipHash = createHash('sha256').update(ip).digest('hex');
    const subjectHash = subject
      ? createHash('sha256').update(`${ip}\u0000${subject}`).digest('hex')
      : undefined;
    if (this.upstash) {
      const limiter = this.upstash.get(action);
      if (!limiter) throw new Error(`Missing rate limiter for ${action}`);
      const ipResult = await limiter.limit(`ip:${ipHash}`);
      const subjectResult = subjectHash
        ? await limiter.limit(`subject:${subjectHash}`)
        : { success: true };
      return ipResult.success && subjectResult.success;
    }
    if (!this.redis) throw new Error('Redis rate limiting is not configured');
    const ipKey = `chatmaster:auth:${action}:ip:${ipHash}`;
    const ipCount = Number(
      await this.redis.eval(FIXED_WINDOW_SCRIPT, 1, ipKey, String(window.milliseconds)),
    );
    if (ipCount > window.requests) return false;
    if (!subjectHash) return true;
    const subjectKey = `chatmaster:auth:${action}:subject:${subjectHash}`;
    const subjectCount = Number(
      await this.redis.eval(FIXED_WINDOW_SCRIPT, 1, subjectKey, String(window.milliseconds)),
    );
    return subjectCount <= window.requests;
  }
}
