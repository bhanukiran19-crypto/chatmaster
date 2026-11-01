import { withTenantScope, type PrismaClient } from '@chatmaster/db';
import type { EncryptionService } from '@chatmaster/crypto';
import {
  type TelegramApiClient,
  type OutboundTelegramJobData,
  type DeadLetterJobData,
  type SendMessageInput,
  type InlineKeyboardButton,
  type AnswerCallbackJobData,
  TelegramApiError,
  QUEUES,
  OUTBOUND_JOBS,
  encodeReplyCallbackData,
} from '@chatmaster/shared';
import type { ChatRateLimiter } from '../rate-limit/chat-rate-limiter.js';

export interface DeadLetterQueue {
  sendToDlq(dlqData: DeadLetterJobData): Promise<void>;
}

export class TelegramRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`Telegram rate limit: retry after ${retryAfterSeconds}s`);
    this.name = 'TelegramRateLimitError';
  }
}

function tokenAad(tenantId: string): string {
  return `telegram-bot-token:${tenantId}`;
}

export function buildInlineKeyboard(
  buttons: OutboundTelegramJobData['buttons'],
): InlineKeyboardButton[][] | undefined {
  if (!buttons || !buttons.length) return undefined;

  // Group buttons by row
  const rowsMap = new Map<number, typeof buttons>();
  for (const btn of buttons) {
    const list = rowsMap.get(btn.row) ?? [];
    list.push(btn);
    rowsMap.set(btn.row, list);
  }

  // Sort rows and columns
  const sortedRowKeys = [...rowsMap.keys()].sort((a, b) => a - b);
  const keyboard: InlineKeyboardButton[][] = [];

  for (const rowKey of sortedRowKeys) {
    const rowButtons = (rowsMap.get(rowKey) ?? []).sort((a, b) => a.column - b.column);
    const rowItems: InlineKeyboardButton[] = [];
    for (const btn of rowButtons) {
      if (btn.type === 'URL' && btn.url) {
        rowItems.push({ text: btn.label, url: btn.url });
      } else if (btn.type === 'CALLBACK' && btn.nextReplyId) {
        rowItems.push({ text: btn.label, callback_data: encodeReplyCallbackData(btn.nextReplyId) });
      }
      // Anything else is a dangling button (e.g. its target reply was deleted); omit it.
    }
    if (rowItems.length) keyboard.push(rowItems);
  }

  return keyboard.length ? keyboard : undefined;
}

export class OutboundTelegramProcessor {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly encryption: EncryptionService,
    private readonly telegramClient: TelegramApiClient,
    private readonly chatRateLimiter: ChatRateLimiter,
    private readonly dlq?: DeadLetterQueue,
  ) {}

  /**
   * Acknowledges a button press that produced no reply. Telegram rejects
   * answers older than ~15 s or already answered with 400; those are dropped.
   */
  async processAnswerCallbackJob(jobData: AnswerCallbackJobData): Promise<{ answered: boolean }> {
    const botToken = await this.loadBotToken(jobData.tenantId, jobData.platformConnectionId);
    try {
      await this.telegramClient.answerCallbackQuery(botToken, {
        callbackQueryId: jobData.callbackQueryId,
        ...(jobData.text ? { text: jobData.text } : {}),
      });
      return { answered: true };
    } catch (err: unknown) {
      if (err instanceof TelegramApiError && err.errorCode === 429) {
        throw new TelegramRateLimitError(err.retryAfterSeconds ?? 5);
      }
      if (err instanceof TelegramApiError && err.errorCode === 400) return { answered: false };
      throw err;
    }
  }

  private async answerCallbackBestEffort(botToken: string, callbackQueryId: string): Promise<void> {
    try {
      await this.telegramClient.answerCallbackQuery(botToken, { callbackQueryId });
    } catch {
      // Expired/duplicate answers (e.g. on a retried job) are expected and harmless.
    }
  }

  private async loadBotToken(tenantId: string, platformConnectionId: string): Promise<string> {
    return withTenantScope(this.prisma, { tenantId }, async (tx) => {
      const connection = await tx.platformConnection.findUnique({
        where: { id: platformConnectionId },
        select: { encryptedToken: true, tokenKeyVersion: true },
      });
      if (!connection) {
        throw new Error(`PlatformConnection ${platformConnectionId} not found`);
      }
      return this.encryption.decryptToString(
        new Uint8Array(connection.encryptedToken),
        tokenAad(tenantId),
      );
    });
  }

  async processOutboundJob(
    jobData: OutboundTelegramJobData,
    attemptsMade = 0,
    maxAttempts = 5,
  ): Promise<{ sent: boolean; messageId?: number }> {
    const { tenantId, platformConnectionId, chatId } = jobData;

    try {
      // 1. Enforce per-chat rate limit (~1 msg/sec)
      await this.chatRateLimiter.acquire(platformConnectionId, chatId);

      // 2. Fetch connection and decrypt bot token inside tenant transaction scope
      const botToken = await this.loadBotToken(tenantId, platformConnectionId);

      // Stop the button spinner first; a failure here must not block the reply.
      if (jobData.callbackQueryId) {
        await this.answerCallbackBestEffort(botToken, jobData.callbackQueryId);
      }

      // 3. Prepare message payload
      const inlineKeyboard = buildInlineKeyboard(jobData.buttons);
      const input: SendMessageInput = {
        chatId,
        text: jobData.text,
        ...(jobData.parseMode === 'MARKDOWN_V2'
          ? { parseMode: 'MarkdownV2' as const }
          : jobData.parseMode === 'HTML'
            ? { parseMode: 'HTML' as const }
            : {}),
        ...(jobData.replyToMessageId !== undefined
          ? { replyToMessageId: jobData.replyToMessageId }
          : {}),
        ...(inlineKeyboard ? { replyMarkup: { inline_keyboard: inlineKeyboard } } : {}),
      };

      // 4. Send message to Telegram API
      let sendResult;
      try {
        sendResult = await this.telegramClient.sendMessage(botToken, input);
      } catch (err: unknown) {
        // Handle 429 rate limit
        if (err instanceof TelegramApiError && err.errorCode === 429) {
          const retryAfter = err.retryAfterSeconds ?? 5;
          throw new TelegramRateLimitError(retryAfter);
        }

        // Fatal errors (e.g. 403 Forbidden when bot is blocked by user, 400 Bad Request)
        if (
          err instanceof TelegramApiError &&
          (err.errorCode === 400 || err.errorCode === 403 || err.errorCode === 404)
        ) {
          if (this.dlq) {
            await this.dlq.sendToDlq({
              queue: QUEUES.TELEGRAM_OUTBOUND,
              jobName: OUTBOUND_JOBS.REPLY,
              originalData: jobData,
              error: {
                message: err.message,
                statusCode: err.errorCode,
                ...(err.stack ? { stack: err.stack } : {}),
              },
              failedAt: new Date().toISOString(),
              attemptsMade,
            });
          }
          return { sent: false };
        }

        throw err;
      }

      // 5. Success! Record ActiveContact and AuditLog within tenant scope
      const now = new Date();
      const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

      await withTenantScope(this.prisma, { tenantId }, async (tx) => {
        // Upsert ActiveContact for current month
        await tx.activeContact.upsert({
          where: {
            tenantId_platform_externalChatId_month: {
              tenantId,
              platform: 'TELEGRAM',
              externalChatId: String(chatId),
              month,
            },
          },
          create: {
            tenantId,
            platform: 'TELEGRAM',
            externalChatId: String(chatId),
            month,
            firstRepliedAt: now,
          },
          update: {},
        });

        // Write AuditLog
        await tx.auditLog.create({
          data: {
            tenantId,
            action: 'workflow.reply_sent',
            entityType: 'workflow',
            entityId: jobData.workflowId ?? null,
            metadata: {
              platform: 'TELEGRAM',
              externalChatId: String(chatId),
              updateId: jobData.correlationUpdateId ?? null,
              replyId: jobData.replyId ?? null,
              sentAt: now.toISOString(),
            },
          },
        });
      });

      return { sent: true, messageId: sendResult.messageId };
    } catch (error: unknown) {
      if (error instanceof TelegramRateLimitError) {
        throw error;
      }

      // If attempts exceeded max, route to DLQ
      if (attemptsMade >= maxAttempts && this.dlq) {
        await this.dlq.sendToDlq({
          queue: QUEUES.TELEGRAM_OUTBOUND,
          jobName: OUTBOUND_JOBS.REPLY,
          originalData: jobData,
          error: {
            message: error instanceof Error ? error.message : String(error),
            ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
          },
          failedAt: new Date().toISOString(),
          attemptsMade,
        });
      }

      throw error;
    }
  }
}
