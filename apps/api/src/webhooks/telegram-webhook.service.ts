import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaClient, withWebhookLookupScope } from '@chatmaster/db';
import { verifyHashedSecret } from '@chatmaster/crypto';
import { telegramUpdateSchema, type TelegramUpdate } from '@chatmaster/shared';
import { parseBody } from '../auth/auth.validation.js';
import {
  TELEGRAM_WEBHOOK_QUEUE,
  WEBHOOK_DEDUPLICATION_SERVICE,
} from './telegram-webhook.tokens.js';
import type { TelegramWebhookQueue } from './telegram-webhook.queue.js';
import type { WebhookDeduplicationService } from './webhook-deduplication.service.js';

const PATH_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
// 64-char hex string to equalize comparison timing when connection is missing
const DUMMY_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

export interface WebhookResult {
  ok: boolean;
  duplicate?: boolean;
}

@Injectable()
export class TelegramWebhookService {
  private readonly logger = new Logger(TelegramWebhookService.name);

  constructor(
    private readonly prisma: PrismaClient,
    @Inject(WEBHOOK_DEDUPLICATION_SERVICE)
    private readonly deduplication: WebhookDeduplicationService,
    @Inject(TELEGRAM_WEBHOOK_QUEUE)
    private readonly queue: TelegramWebhookQueue,
  ) {}

  async handleWebhook(
    webhookPathId: string,
    secretTokenHeader: string | undefined,
    rawBody: unknown,
  ): Promise<WebhookResult> {
    if (!PATH_ID_RE.test(webhookPathId)) {
      throw new NotFoundException('Webhook endpoint not found');
    }

    // 1. Look up the connection within the webhook lookup RLS scope
    const connection = await withWebhookLookupScope(
      this.prisma,
      { webhookPathId },
      async (tx) => {
        return tx.platformConnection.findUnique({
          where: { webhookPathId },
          select: {
            id: true,
            tenantId: true,
            status: true,
            externalAccountId: true,
            secretTokenHash: true,
          },
        });
      },
    );

    if (!connection) {
      // Execute dummy constant-time comparison to prevent timing leak of path existence
      verifyHashedSecret(secretTokenHeader ?? '', DUMMY_HASH);
      throw new NotFoundException('Webhook endpoint not found');
    }

    if (connection.status !== 'ACTIVE') {
      throw new NotFoundException('Webhook endpoint not active');
    }

    // 2. Verify X-Telegram-Bot-Api-Secret-Token in constant time BEFORE parsing body
    const presentedToken = secretTokenHeader ?? '';
    if (!presentedToken || !verifyHashedSecret(presentedToken, connection.secretTokenHash)) {
      throw new UnauthorizedException('Invalid secret token');
    }

    // 3. Validate payload with strict Zod schema
    const update: TelegramUpdate = parseBody(telegramUpdateSchema, rawBody);

    // 4. Dedupe by update_id in Redis
    const isDuplicate = await this.deduplication.isDuplicate(connection.id, update.update_id);
    if (isDuplicate) {
      this.logger.debug(
        `Duplicate update ${String(update.update_id)} for connection ${connection.id}; dropped`,
      );
      return { ok: true, duplicate: true };
    }

    // 5. Enqueue to BullMQ
    await this.queue.enqueueUpdate({
      platformConnectionId: connection.id,
      tenantId: connection.tenantId,
      botId: connection.externalAccountId,
      updateId: update.update_id,
      update,
      receivedAt: new Date().toISOString(),
    });

    // 6. Return 200 within milliseconds
    return { ok: true };
  }
}
