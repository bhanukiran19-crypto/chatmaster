import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { TelegramWebhookController } from '../src/webhooks/telegram-webhook.controller.js';
import { TELEGRAM_WEBHOOK_SERVICE } from '../src/webhooks/telegram-webhook.tokens.js';
import type { TelegramWebhookService } from '../src/webhooks/telegram-webhook.service.js';
import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';

describe('TelegramWebhookController (HTTP Integration)', () => {
  let app: INestApplication;
  let mockWebhookService: Partial<TelegramWebhookService>;

  beforeEach(async () => {
    mockWebhookService = {
      handleWebhook: vi.fn(
        async (pathId: string, secretToken: string | undefined, body: unknown) => {
          if (pathId === 'invalid_format') {
            throw new NotFoundException('Webhook endpoint not found');
          }
          if (pathId === 'not_found_1234567890') {
            throw new NotFoundException('Webhook endpoint not found');
          }
          if (!secretToken || secretToken === 'wrong_secret') {
            throw new UnauthorizedException('Invalid secret token');
          }
          if (typeof body === 'object' && body !== null && 'invalid' in body) {
            throw new BadRequestException('Invalid request body');
          }
          if (typeof body === 'object' && body !== null && (body as any).update_id === 9999) {
            return { ok: true, duplicate: true };
          }
          return { ok: true };
        },
      ),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [TelegramWebhookController],
      providers: [
        {
          provide: TELEGRAM_WEBHOOK_SERVICE,
          useValue: mockWebhookService,
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  it('returns 200 { ok: true } on valid webhook delivery', async () => {
    const response = await request(app.getHttpServer())
      .post('/webhooks/telegram/valid_path_1234567890')
      .set('x-telegram-bot-api-secret-token', 'correct_secret')
      .send({ update_id: 1001, message: { text: 'hi' } });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(mockWebhookService.handleWebhook).toHaveBeenCalledWith(
      'valid_path_1234567890',
      'correct_secret',
      { update_id: 1001, message: { text: 'hi' } },
    );
  });

  it('returns 200 { ok: true, duplicate: true } on duplicate update delivery', async () => {
    const response = await request(app.getHttpServer())
      .post('/webhooks/telegram/valid_path_1234567890')
      .set('x-telegram-bot-api-secret-token', 'correct_secret')
      .send({ update_id: 9999, message: { text: 'duplicate update' } });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, duplicate: true });
  });

  it('returns 401 Unauthorized when secret token header is missing or wrong', async () => {
    const resNoToken = await request(app.getHttpServer())
      .post('/webhooks/telegram/valid_path_1234567890')
      .send({ update_id: 1001 });

    expect(resNoToken.status).toBe(401);

    const resWrongToken = await request(app.getHttpServer())
      .post('/webhooks/telegram/valid_path_1234567890')
      .set('x-telegram-bot-api-secret-token', 'wrong_secret')
      .send({ update_id: 1001 });

    expect(resWrongToken.status).toBe(401);
  });

  it('returns 404 Not Found when webhook path does not exist', async () => {
    const response = await request(app.getHttpServer())
      .post('/webhooks/telegram/not_found_1234567890')
      .set('x-telegram-bot-api-secret-token', 'correct_secret')
      .send({ update_id: 1001 });

    expect(response.status).toBe(404);
  });

  it('returns 400 Bad Request when body fails validation', async () => {
    const response = await request(app.getHttpServer())
      .post('/webhooks/telegram/valid_path_1234567890')
      .set('x-telegram-bot-api-secret-token', 'correct_secret')
      .send({ invalid: true });

    expect(response.status).toBe(400);
  });
});
