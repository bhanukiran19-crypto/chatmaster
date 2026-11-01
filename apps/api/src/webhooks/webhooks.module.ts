import { Module } from '@nestjs/common';
import { PrismaClient } from '@chatmaster/db';
import { TelegramWebhookController } from './telegram-webhook.controller.js';
import { TelegramWebhookService } from './telegram-webhook.service.js';
import { BullMqTelegramWebhookQueue } from './telegram-webhook.queue.js';
import { RedisWebhookDeduplicationService } from './webhook-deduplication.service.js';
import {
  TELEGRAM_WEBHOOK_QUEUE,
  TELEGRAM_WEBHOOK_SERVICE,
  WEBHOOK_DEDUPLICATION_SERVICE,
} from './telegram-webhook.tokens.js';

@Module({
  controllers: [TelegramWebhookController],
  providers: [
    {
      provide: WEBHOOK_DEDUPLICATION_SERVICE,
      useClass: RedisWebhookDeduplicationService,
    },
    {
      provide: TELEGRAM_WEBHOOK_QUEUE,
      useClass: BullMqTelegramWebhookQueue,
    },
    {
      provide: TELEGRAM_WEBHOOK_SERVICE,
      useFactory: (
        prisma: PrismaClient,
        deduplication: RedisWebhookDeduplicationService,
        queue: BullMqTelegramWebhookQueue,
      ) => {
        return new TelegramWebhookService(prisma, deduplication, queue);
      },
      inject: [PrismaClient, WEBHOOK_DEDUPLICATION_SERVICE, TELEGRAM_WEBHOOK_QUEUE],
    },
  ],
  exports: [TELEGRAM_WEBHOOK_SERVICE, TELEGRAM_WEBHOOK_QUEUE, WEBHOOK_DEDUPLICATION_SERVICE],
})
export class WebhooksModule {}
