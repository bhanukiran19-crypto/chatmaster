import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import { TELEGRAM_WEBHOOK_SERVICE } from './telegram-webhook.tokens.js';
import type { TelegramWebhookService, WebhookResult } from './telegram-webhook.service.js';

@Controller('webhooks/telegram')
export class TelegramWebhookController {
  constructor(
    @Inject(TELEGRAM_WEBHOOK_SERVICE)
    private readonly webhookService: TelegramWebhookService,
  ) {}

  @Post(':webhookPathId')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Param('webhookPathId') webhookPathId: string,
    @Headers('x-telegram-bot-api-secret-token') secretToken: string | undefined,
    @Body() body: unknown,
  ): Promise<WebhookResult> {
    return this.webhookService.handleWebhook(webhookPathId, secretToken, body);
  }
}
