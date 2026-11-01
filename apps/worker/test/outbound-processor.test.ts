import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@chatmaster/db';
import type { EncryptionService } from '@chatmaster/crypto';
import {
  type TelegramApiClient,
  type OutboundTelegramJobData,
  type DeadLetterJobData,
  TelegramApiError,
} from '@chatmaster/shared';
import {
  OutboundTelegramProcessor,
  TelegramRateLimitError,
  buildInlineKeyboard,
  type DeadLetterQueue,
} from '../src/outbound/outbound-processor.js';
import type { ChatRateLimiter } from '../src/rate-limit/chat-rate-limiter.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CONN_ID = '22222222-2222-4222-8222-222222222222';
const BOT_TOKEN = '123456:ABC-DEF-GHI-JKL-MNO';
const REPLY_NEXT = '33333333-3333-4333-8333-333333333333';
const REPLY_1 = '44444444-4444-4444-8444-444444444444';
const REPLY_2 = '55555555-5555-4555-8555-555555555555';

describe('OutboundTelegramProcessor', () => {
  let mockPrisma: any;
  let mockTx: any;
  let mockEncryption: EncryptionService;
  let mockTelegram: TelegramApiClient;
  let mockRateLimiter: ChatRateLimiter;
  let dlqJobs: DeadLetterJobData[];
  let mockDlq: DeadLetterQueue;
  let processor: OutboundTelegramProcessor;

  beforeEach(() => {
    dlqJobs = [];

    mockTx = {
      $queryRaw: vi.fn(async () => []),
      platformConnection: {
        findUnique: vi.fn(async () => ({
          encryptedToken: Buffer.from('encrypted-bytes'),
          tokenKeyVersion: 1,
        })),
      },
      activeContact: {
        upsert: vi.fn(async ({ where, create }: any) => ({
          id: 'ac-1',
          ...where.tenantId_platform_externalChatId_month,
          firstRepliedAt: create.firstRepliedAt,
        })),
      },
      auditLog: {
        create: vi.fn(async ({ data }: any) => ({ id: 'al-1', ...data })),
      },
    };

    mockPrisma = {
      $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockTx)),
    } as unknown as PrismaClient;

    mockEncryption = {
      activeKeyVersion: 1,
      encrypt: vi.fn(),
      decrypt: vi.fn(),
      decryptToString: vi.fn((_bytes, aad) => {
        if (aad !== `telegram-bot-token:${TENANT_ID}`) {
          throw new Error('AAD mismatch');
        }
        return BOT_TOKEN;
      }),
      keyVersionOf: vi.fn(),
      needsRotation: vi.fn(),
      rotate: vi.fn(),
    };

    mockTelegram = {
      getMe: vi.fn(),
      setWebhook: vi.fn(),
      deleteWebhook: vi.fn(),
      sendMessage: vi.fn(async () => ({ messageId: 777 })),
      answerCallbackQuery: vi.fn(async () => undefined),
    };

    mockRateLimiter = {
      acquire: vi.fn(async () => undefined),
    };

    mockDlq = {
      sendToDlq: vi.fn(async (data: DeadLetterJobData) => {
        dlqJobs.push(data);
      }),
    };

    processor = new OutboundTelegramProcessor(
      mockPrisma,
      mockEncryption,
      mockTelegram,
      mockRateLimiter,
      mockDlq,
    );
  });

  const validJob: OutboundTelegramJobData = {
    tenantId: TENANT_ID,
    platformConnectionId: CONN_ID,
    chatId: '12345678',
    text: 'Hello from workflow!',
    parseMode: 'HTML',
    buttons: [
      { row: 0, column: 0, type: 'URL', label: 'Docs', url: 'https://docs.example.com' },
      { row: 1, column: 0, type: 'CALLBACK', label: 'More', nextReplyId: REPLY_NEXT },
    ],
    correlationUpdateId: 9001,
    workflowId: 'wf-1',
    replyId: 'rep-1',
  };

  it('acquires per-chat rate limit and sends message via Telegram API', async () => {
    const result = await processor.processOutboundJob(validJob);

    expect(result.sent).toBe(true);
    expect(result.messageId).toBe(777);

    // Rate limiter acquired
    expect(mockRateLimiter.acquire).toHaveBeenCalledWith(CONN_ID, '12345678');

    // Token decrypted with correct tenant AAD
    expect(mockEncryption.decryptToString).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      `telegram-bot-token:${TENANT_ID}`,
    );

    // Telegram API called with formatted buttons
    expect(mockTelegram.sendMessage).toHaveBeenCalledWith(BOT_TOKEN, {
      chatId: '12345678',
      text: 'Hello from workflow!',
      parseMode: 'HTML',
      replyMarkup: {
        inline_keyboard: [
          [{ text: 'Docs', url: 'https://docs.example.com' }],
          [{ text: 'More', callback_data: `r:${REPLY_NEXT}` }],
        ],
      },
    });
    expect(mockTelegram.answerCallbackQuery).not.toHaveBeenCalled();

    // ActiveContact upserted
    expect(mockTx.activeContact.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId_platform_externalChatId_month: expect.objectContaining({
            tenantId: TENANT_ID,
            platform: 'TELEGRAM',
            externalChatId: '12345678',
          }),
        }),
      }),
    );

    // AuditLog recorded
    expect(mockTx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: TENANT_ID,
        action: 'workflow.reply_sent',
        entityType: 'workflow',
        entityId: 'wf-1',
        metadata: expect.objectContaining({
          platform: 'TELEGRAM',
          externalChatId: '12345678',
          updateId: 9001,
          replyId: 'rep-1',
        }),
      }),
    });
  });

  describe('retry and 429 retry_after handling', () => {
    it('catches 429 and throws TelegramRateLimitError with specified retry_after seconds', async () => {
      mockTelegram.sendMessage = vi.fn(async () => {
        throw new TelegramApiError('sendMessage', 429, 'Too Many Requests', 12);
      });

      await expect(processor.processOutboundJob(validJob)).rejects.toThrow(TelegramRateLimitError);

      try {
        await processor.processOutboundJob(validJob);
      } catch (err) {
        expect(err).toBeInstanceOf(TelegramRateLimitError);
        expect((err as TelegramRateLimitError).retryAfterSeconds).toBe(12);
      }

      // 429 is a temporary rate limit error -> must NOT go to DLQ
      expect(mockDlq.sendToDlq).not.toHaveBeenCalled();
    });

    it('routes unrecoverable 403 Forbidden (bot blocked by user) to DLQ immediately', async () => {
      mockTelegram.sendMessage = vi.fn(async () => {
        throw new TelegramApiError('sendMessage', 403, 'Forbidden: bot was blocked by the user');
      });

      const result = await processor.processOutboundJob(validJob, 0, 5);

      expect(result.sent).toBe(false);
      expect(mockDlq.sendToDlq).toHaveBeenCalledTimes(1);
      expect(dlqJobs[0]).toMatchObject({
        jobName: 'telegram.reply',
        originalData: validJob,
        error: {
          statusCode: 403,
          message: expect.stringContaining('403'),
        },
      });
    });

    it('routes to DLQ when job attempts are exhausted', async () => {
      mockTelegram.sendMessage = vi.fn(async () => {
        throw new Error('Persistent network failure');
      });

      // attemptsMade = 5, maxAttempts = 5
      await expect(processor.processOutboundJob(validJob, 5, 5)).rejects.toThrow(
        'Persistent network failure',
      );

      expect(mockDlq.sendToDlq).toHaveBeenCalledTimes(1);
      expect(dlqJobs[0]).toMatchObject({
        jobName: 'telegram.reply',
        attemptsMade: 5,
        error: {
          message: 'Persistent network failure',
        },
      });
    });
  });

  describe('button formatting', () => {
    it('correctly organizes buttons into multi-row and multi-column keyboard', () => {
      const buttons = [
        { row: 1, column: 1, type: 'CALLBACK' as const, label: 'B2', nextReplyId: REPLY_2 },
        { row: 0, column: 1, type: 'URL' as const, label: 'A2', url: 'https://b.com' },
        { row: 0, column: 0, type: 'URL' as const, label: 'A1', url: 'https://a.com' },
        { row: 1, column: 0, type: 'CALLBACK' as const, label: 'B1', nextReplyId: REPLY_1 },
      ];

      const keyboard = buildInlineKeyboard(buttons);

      expect(keyboard).toEqual([
        [
          { text: 'A1', url: 'https://a.com' },
          { text: 'A2', url: 'https://b.com' },
        ],
        [
          { text: 'B1', callback_data: `r:${REPLY_1}` },
          { text: 'B2', callback_data: `r:${REPLY_2}` },
        ],
      ]);
    });

    it('keeps callback_data within Telegram 64-byte limit', () => {
      const keyboard = buildInlineKeyboard([
        { row: 0, column: 0, type: 'CALLBACK', label: 'Next', nextReplyId: REPLY_1 },
      ]);
      const data = keyboard?.[0]?.[0]?.callback_data ?? '';
      expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
    });

    it('omits dangling buttons instead of leaking labels as callback_data', () => {
      const keyboard = buildInlineKeyboard([
        { row: 0, column: 0, type: 'CALLBACK', label: 'Orphan' },
        { row: 1, column: 0, type: 'URL', label: 'No URL' },
        { row: 2, column: 0, type: 'URL', label: 'Docs', url: 'https://docs.example.com' },
      ]);
      expect(keyboard).toEqual([[{ text: 'Docs', url: 'https://docs.example.com' }]]);
      expect(
        buildInlineKeyboard([{ row: 0, column: 0, type: 'CALLBACK', label: 'Orphan' }]),
      ).toBeUndefined();
    });

    it('returns undefined when no buttons are provided', () => {
      expect(buildInlineKeyboard(undefined)).toBeUndefined();
      expect(buildInlineKeyboard([])).toBeUndefined();
    });
  });

  describe('callback_query acknowledgement', () => {
    it('answers the callback query before sending the chained reply', async () => {
      const order: string[] = [];
      mockTelegram.answerCallbackQuery = vi.fn(async () => {
        order.push('answer');
      });
      mockTelegram.sendMessage = vi.fn(async () => {
        order.push('send');
        return { messageId: 1 };
      });

      const result = await processor.processOutboundJob({ ...validJob, callbackQueryId: 'cbq-1' });

      expect(result.sent).toBe(true);
      expect(mockTelegram.answerCallbackQuery).toHaveBeenCalledWith(BOT_TOKEN, {
        callbackQueryId: 'cbq-1',
      });
      expect(order).toEqual(['answer', 'send']);
    });

    it('still sends the reply when answering fails (e.g. query expired on retry)', async () => {
      mockTelegram.answerCallbackQuery = vi.fn(async () => {
        throw new TelegramApiError('answerCallbackQuery', 400, 'query is too old');
      });

      const result = await processor.processOutboundJob({ ...validJob, callbackQueryId: 'cbq-1' });

      expect(result.sent).toBe(true);
      expect(mockTelegram.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('answer-only job acknowledges with the notice text', async () => {
      const result = await processor.processAnswerCallbackJob({
        tenantId: TENANT_ID,
        platformConnectionId: CONN_ID,
        callbackQueryId: 'cbq-2',
        text: 'This option is no longer available.',
      });

      expect(result).toEqual({ answered: true });
      expect(mockTelegram.answerCallbackQuery).toHaveBeenCalledWith(BOT_TOKEN, {
        callbackQueryId: 'cbq-2',
        text: 'This option is no longer available.',
      });
      expect(mockTelegram.sendMessage).not.toHaveBeenCalled();
      expect(mockRateLimiter.acquire).not.toHaveBeenCalled();
    });

    it('answer-only job drops stale queries (400) and surfaces 429 for backoff', async () => {
      const job = { tenantId: TENANT_ID, platformConnectionId: CONN_ID, callbackQueryId: 'cbq-3' };

      mockTelegram.answerCallbackQuery = vi.fn(async () => {
        throw new TelegramApiError('answerCallbackQuery', 400, 'query is too old');
      });
      await expect(processor.processAnswerCallbackJob(job)).resolves.toEqual({ answered: false });

      mockTelegram.answerCallbackQuery = vi.fn(async () => {
        throw new TelegramApiError('answerCallbackQuery', 429, 'Too Many Requests', 3);
      });
      await expect(processor.processAnswerCallbackJob(job)).rejects.toBeInstanceOf(
        TelegramRateLimitError,
      );
    });
  });
});
