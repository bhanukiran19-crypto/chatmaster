import type { Redis as IORedis } from 'ioredis';

/** Minimal key-value surface so the cooldown logic is testable without Redis. */
export interface CooldownStore {
  /** Atomically sets `key` with a TTL only when absent. Returns true when it was set. */
  setIfAbsent(key: string, ttlSeconds: number): Promise<boolean>;
  delete(key: string): Promise<void>;
}

export interface CooldownService {
  /**
   * Claims the per-chat cooldown window for a workflow. Returns false when the
   * window is already held, i.e. the workflow replied to this chat recently.
   * Check-and-set is a single atomic operation, so concurrent workers handling
   * two messages from the same chat cannot both reply.
   */
  tryAcquire(workflowId: string, chatId: string, cooldownSeconds: number): Promise<boolean>;
  /** Gives the window back when the reply could not be enqueued. */
  release(workflowId: string, chatId: string): Promise<void>;
}

export function cooldownKey(workflowId: string, chatId: string): string {
  return `chatmaster:cooldown:${workflowId}:${chatId}`;
}

export function ioredisCooldownStore(redis: IORedis): CooldownStore {
  return {
    async setIfAbsent(key, ttlSeconds) {
      return (await redis.set(key, '1', 'EX', ttlSeconds, 'NX')) === 'OK';
    },
    async delete(key) {
      await redis.del(key);
    },
  };
}

export class RedisCooldownService implements CooldownService {
  constructor(private readonly store: CooldownStore) {}

  async tryAcquire(workflowId: string, chatId: string, cooldownSeconds: number): Promise<boolean> {
    if (!Number.isInteger(cooldownSeconds) || cooldownSeconds <= 0) return true;
    return this.store.setIfAbsent(cooldownKey(workflowId, chatId), cooldownSeconds);
  }

  async release(workflowId: string, chatId: string): Promise<void> {
    await this.store.delete(cooldownKey(workflowId, chatId));
  }
}
