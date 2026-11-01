import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { sha256Hex } from '@chatmaster/crypto';
import type { PrismaClient } from '@chatmaster/db';
import { TelegramWebhookService } from '../src/webhooks/telegram-webhook.service.js';
import type { TelegramWebhookQueue } from '../src/webhooks/telegram-webhook.queue.js';
import type { WebhookDeduplicationService } from '../src/webhooks/webhook-deduplication.service.js';
import type { InboundTelegramJobData } from '@chatmaster/shared';

const TEST_SECRET = 'random-secret-token-1234567890abcdef';
const TEST_HASH = sha256Hex(TEST_SECRET);
const TEST_PATH_ID = 'valid_webhook_path_id_1234567890';
const TEST_TENANT_ID = '11111111-1111-4111-8111-111111111111';
const TEST_CONNECTION_ID = '22222222-2222-4222-8222-222222222222';
const TEST_BOT_ID = '987654321';

const VALID_UPDATE = {
  update_id: 1001,
  message: {
    message_id: 42,
    date: 1700000000,
    chat: {
      id: 12345,
      type: 'private' as const,
      first_name: 'Alice',
    },
    from: {
      id: 12345,
      is_bot: false,
      first_name: 'Alice',
    },
    text: 'Hello bot',
  },
};

describe('TelegramWebhookService', () => {
  let mockPrisma: any;
  let mockDeduplication: WebhookDeduplicationService;
  let mockQueue: TelegramWebhookQueue;
  let enqueuedJobs: InboundTelegramJobData[];
  let duplicateMap: Set<string>;
  let service: TelegramWebhookService;

  beforeEach(() => {
    enqueuedJobs = [];
    duplicateMap = new Set();

    mockDeduplication = {
      isDuplicate: vi.fn(async (connId: string, updateId: number) => {
        const key = `${connId}:${updateId}`;
        if (duplicateMap.has(key)) return true;
        duplicateMap.add(key);
        return false;
      }),
    };

    mockQueue = {
      enqueueUpdate: vi.fn(async (job: InboundTelegramJobData) => {
        enqueuedJobs.push(job);
      }),
    };

    const mockTx = {
      $queryRaw: vi.fn(async () => []),
      platformConnection: {
        findUnique: vi.fn(async ({ where }: { where: { webhookPathId: string } }) => {
          if (where.webhookPathId === TEST_PATH_ID) {
            return {
              id: TEST_CONNECTION_ID,
              tenantId: TEST_TENANT_ID,
              status: 'ACTIVE',
              externalAccountId: TEST_BOT_ID,
              secretTokenHash: TEST_HASH,
            };
          }
          if (where.webhookPathId === 'disabled_path_id_1234567890') {
            return {
              id: '33333333-3333-4333-8333-333333333333',
              tenantId: TEST_TENANT_ID,
              status: 'DISABLED',
              externalAccountId: TEST_BOT_ID,
              secretTokenHash: TEST_HASH,
            };
          }
          return null;
        }),
      },
    };

    mockPrisma = {
      $transaction: vi.fn(async (callback: (tx: any) => Promise<any>) => callback(mockTx)),
    } as unknown as PrismaClient;

    service = new TelegramWebhookService(mockPrisma, mockDeduplication, mockQueue);
  });

  describe('path validation & lookup', () => {
    it('rejects path IDs that do not match format with 404', async () => {
      await expect(
        service.handleWebhook('short', TEST_SECRET, VALID_UPDATE),
      ).rejects.toThrow(NotFoundException);

      await expect(
        service.handleWebhook('path with spaces!!', TEST_SECRET, VALID_UPDATE),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws 404 when connection does not exist in DB', async () => {
      await expect(
        service.handleWebhook('non_existent_path_id_12345', TEST_SECRET, VALID_UPDATE),
      ).rejects.toThrow(NotFoundException);

      expect(mockQueue.enqueueUpdate).not.toHaveBeenCalled();
    });

    it('throws 404 when connection exists but is not ACTIVE', async () => {
      await expect(
        service.handleWebhook('disabled_path_id_1234567890', TEST_SECRET, VALID_UPDATE),
      ).rejects.toThrow(NotFoundException);

      expect(mockQueue.enqueueUpdate).not.toHaveBeenCalled();
    });
  });

  describe('signature / secret token verification', () => {
    it('throws 401 when secret token header is missing', async () => {
      await expect(
        service.handleWebhook(TEST_PATH_ID, undefined, VALID_UPDATE),
      ).rejects.toThrow(UnauthorizedException);

      expect(mockQueue.enqueueUpdate).not.toHaveBeenCalled();
    });

    it('throws 401 when secret token header is empty', async () => {
      await expect(
        service.handleWebhook(TEST_PATH_ID, '', VALID_UPDATE),
      ).rejects.toThrow(UnauthorizedException);

      expect(mockQueue.enqueueUpdate).not.toHaveBeenCalled();
    });

    it('throws 401 when secret token header is incorrect', async () => {
      await expect(
        service.handleWebhook(TEST_PATH_ID, 'wrong-token-value-guess', VALID_UPDATE),
      ).rejects.toThrow(UnauthorizedException);

      expect(mockQueue.enqueueUpdate).not.toHaveBeenCalled();
    });
  });

  describe('payload validation with Zod', () => {
    it('rejects invalid payload without update_id with 400', async () => {
      await expect(
        service.handleWebhook(TEST_PATH_ID, TEST_SECRET, { text: 'no update_id' }),
      ).rejects.toThrow(BadRequestException);

      expect(mockQueue.enqueueUpdate).not.toHaveBeenCalled();
    });

    it('rejects unexpected unknown fields with 400 (strict validation)', async () => {
      await expect(
        service.handleWebhook(TEST_PATH_ID, TEST_SECRET, {
          ...VALID_UPDATE,
          malicious_field: 'injected',
        }),
      ).rejects.toThrow(BadRequestException);

      expect(mockQueue.enqueueUpdate).not.toHaveBeenCalled();
    });
  });

  describe('happy path & enqueueing', () => {
    it('successfully validates, enqueues to BullMQ and returns ok: true', async () => {
      const result = await service.handleWebhook(TEST_PATH_ID, TEST_SECRET, VALID_UPDATE);

      expect(result).toEqual({ ok: true });
      expect(mockQueue.enqueueUpdate).toHaveBeenCalledTimes(1);
      expect(enqueuedJobs[0]).toMatchObject({
        platformConnectionId: TEST_CONNECTION_ID,
        tenantId: TEST_TENANT_ID,
        botId: TEST_BOT_ID,
        updateId: 1001,
        update: VALID_UPDATE,
      });
      expect(enqueuedJobs[0]?.receivedAt).toBeDefined();
    });
  });

  describe('duplicate delivery', () => {
    it('returns ok: true with duplicate: true and skips enqueuing on second delivery', async () => {
      // First delivery
      const result1 = await service.handleWebhook(TEST_PATH_ID, TEST_SECRET, VALID_UPDATE);
      expect(result1).toEqual({ ok: true });
      expect(mockQueue.enqueueUpdate).toHaveBeenCalledTimes(1);

      // Second delivery with identical update_id
      const result2 = await service.handleWebhook(TEST_PATH_ID, TEST_SECRET, VALID_UPDATE);
      expect(result2).toEqual({ ok: true, duplicate: true });

      // Enqueue should NOT have been called a second time
      expect(mockQueue.enqueueUpdate).toHaveBeenCalledTimes(1);
    });

    it('processes different update_ids separately', async () => {
      await service.handleWebhook(TEST_PATH_ID, TEST_SECRET, {
        ...VALID_UPDATE,
        update_id: 1001,
      });
      await service.handleWebhook(TEST_PATH_ID, TEST_SECRET, {
        ...VALID_UPDATE,
        update_id: 1002,
      });

      expect(mockQueue.enqueueUpdate).toHaveBeenCalledTimes(2);
      expect(enqueuedJobs.map((j) => j.updateId)).toEqual([1001, 1002]);
    });
  });
});
