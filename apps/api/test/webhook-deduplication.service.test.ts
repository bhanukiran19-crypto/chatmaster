import { describe, expect, it } from 'vitest';
import { RedisWebhookDeduplicationService } from '../src/webhooks/webhook-deduplication.service.js';

describe('RedisWebhookDeduplicationService (Memory fallback)', () => {
  it('detects duplicate update IDs for the same connection', async () => {
    const dedupe = new RedisWebhookDeduplicationService();

    const first = await dedupe.isDuplicate('conn-1', 12345);
    expect(first).toBe(false);

    const second = await dedupe.isDuplicate('conn-1', 12345);
    expect(second).toBe(true);
  });

  it('treats same update ID on different connections as distinct', async () => {
    const dedupe = new RedisWebhookDeduplicationService();

    expect(await dedupe.isDuplicate('conn-1', 12345)).toBe(false);
    expect(await dedupe.isDuplicate('conn-2', 12345)).toBe(false);
  });

  it('treats different update IDs on same connection as distinct', async () => {
    const dedupe = new RedisWebhookDeduplicationService();

    expect(await dedupe.isDuplicate('conn-1', 101)).toBe(false);
    expect(await dedupe.isDuplicate('conn-1', 102)).toBe(false);
  });
});
