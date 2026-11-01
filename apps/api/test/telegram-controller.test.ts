/**
 * Controller-level tests for the Telegram connection endpoints. These
 * exercise the NestJS HTTP layer (Zod validation, guard, interceptor,
 * response serialisation) with a fully mocked service and auth stack.
 *
 * The controller never touches Telegram or the database directly — that is
 * the service's job, tested in telegram-connection.service.test.ts. Here we
 * verify the HTTP contract: status codes, body shapes, secret non-leakage,
 * input rejection.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { type INestApplication, HttpStatus } from '@nestjs/common';
import request from 'supertest';
import type { TelegramConnectionView, DisconnectResult } from '../src/platforms/telegram/telegram-connection.service.js';
import { TelegramController } from '../src/platforms/telegram/telegram.controller.js';
import { TELEGRAM_CONNECTION_SERVICE } from '../src/platforms/platforms.tokens.js';
import { AuthenticatedTenantGuard } from '../src/auth/authenticated-tenant.guard.js';
import { AUTH_SERVICE, AUTH_REPOSITORY } from '../src/auth/auth.tokens.js';

const TENANT_ID = randomUUID();
const USER_ID = randomUUID();
const SESSION_ID = randomUUID();
const CONNECTION_ID = randomUUID();

const SAMPLE_VIEW: TelegramConnectionView = {
  id: CONNECTION_ID,
  platform: 'TELEGRAM',
  status: 'ACTIVE',
  botId: '123456789',
  botUsername: 'my_bot',
  lastWebhookAt: null,
  lastError: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

/**
 * Minimal mock that bypasses the guard and injects tenantContext on every
 * request. This is NOT testing auth — auth has its own test suite.
 */
function createBypassGuard() {
  return {
    canActivate: (context: { switchToHttp: () => { getRequest: () => Record<string, unknown> } }) => {
      const req = context.switchToHttp().getRequest();
      req['tenantContext'] = {
        tenantId: TENANT_ID,
        userId: USER_ID,
        sessionId: SESSION_ID,
        user: { id: USER_ID, email: 'test@gmail.com', phoneE164: '+14155550123' },
      };
      return true;
    },
  };
}

function createMockService() {
  return {
    list: vi.fn(async () => [SAMPLE_VIEW]),
    get: vi.fn(async () => SAMPLE_VIEW),
    connect: vi.fn(async () => SAMPLE_VIEW),
    disconnect: vi.fn(async (): Promise<DisconnectResult> => ({
      id: CONNECTION_ID,
      webhookRemoved: true,
    })),
  };
}

describe('TelegramController (HTTP layer)', () => {
  let app: INestApplication;
  let mockService: ReturnType<typeof createMockService>;

  beforeAll(async () => {
    mockService = createMockService();

    const moduleRef = await Test.createTestingModule({
      controllers: [TelegramController],
      providers: [
        { provide: TELEGRAM_CONNECTION_SERVICE, useValue: mockService },
        // Provide stubs so the guard's DI doesn't blow up; we override the guard anyway
        { provide: AUTH_SERVICE, useValue: {} },
        { provide: AUTH_REPOSITORY, useValue: {} },
      ],
    })
      .overrideGuard(AuthenticatedTenantGuard)
      .useValue(createBypassGuard())
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  // ── GET /platforms/telegram/connections ────────────────────────────────

  it('GET /platforms/telegram/connections returns 200 with connections array', async () => {
    const res = await request(app.getHttpServer())
      .get('/platforms/telegram/connections')
      .expect(HttpStatus.OK);

    expect(res.body).toHaveProperty('connections');
    expect(res.body.connections).toHaveLength(1);
    expect(res.body.connections[0]).toMatchObject({
      id: CONNECTION_ID,
      platform: 'TELEGRAM',
      botId: '123456789',
      botUsername: 'my_bot',
    });

    // Must never contain secrets
    const json = JSON.stringify(res.body);
    expect(json).not.toContain('encryptedToken');
    expect(json).not.toContain('secretTokenHash');
    expect(json).not.toContain('webhookPathId');
  });

  // ── POST /platforms/telegram/connections ───────────────────────────────

  it('POST /platforms/telegram/connections with valid token returns 201', async () => {
    const res = await request(app.getHttpServer())
      .post('/platforms/telegram/connections')
      .send({ botToken: '123456789:AAHfakeTokenValueForTests_0123456789abc' })
      .expect(HttpStatus.CREATED);

    expect(res.body).toHaveProperty('connection');
    expect(res.body.connection).toMatchObject({
      platform: 'TELEGRAM',
      status: 'ACTIVE',
    });

    // The token must not appear in the response
    expect(JSON.stringify(res.body)).not.toContain('AAHfakeTokenValueForTests');
  });

  it('POST with missing botToken returns 400', async () => {
    await request(app.getHttpServer())
      .post('/platforms/telegram/connections')
      .send({})
      .expect(HttpStatus.BAD_REQUEST);
  });

  it('POST with invalid bot token format returns 400', async () => {
    await request(app.getHttpServer())
      .post('/platforms/telegram/connections')
      .send({ botToken: 'not-a-token' })
      .expect(HttpStatus.BAD_REQUEST);
  });

  it('POST with extra fields returns 400 (strict schema)', async () => {
    await request(app.getHttpServer())
      .post('/platforms/telegram/connections')
      .send({
        botToken: '123456789:AAHfakeTokenValueForTests_0123456789abc',
        extraField: 'should-be-rejected',
      })
      .expect(HttpStatus.BAD_REQUEST);
  });

  it('POST with SQL injection in token returns 400', async () => {
    await request(app.getHttpServer())
      .post('/platforms/telegram/connections')
      .send({ botToken: "'; DROP TABLE users; --" })
      .expect(HttpStatus.BAD_REQUEST);
  });

  // ── GET /platforms/telegram/connections/:id ────────────────────────────

  it('GET /platforms/telegram/connections/:id with valid UUID returns 200', async () => {
    const res = await request(app.getHttpServer())
      .get(`/platforms/telegram/connections/${CONNECTION_ID}`)
      .expect(HttpStatus.OK);

    expect(res.body).toHaveProperty('connection');
    expect(res.body.connection.id).toBe(CONNECTION_ID);
  });

  it('GET /platforms/telegram/connections/:id with non-UUID returns 400', async () => {
    await request(app.getHttpServer())
      .get('/platforms/telegram/connections/not-a-uuid')
      .expect(HttpStatus.BAD_REQUEST);
  });

  // ── DELETE /platforms/telegram/connections/:id ─────────────────────────

  it('DELETE /platforms/telegram/connections/:id returns 200 with disconnect result', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/platforms/telegram/connections/${CONNECTION_ID}`)
      .expect(HttpStatus.OK);

    expect(res.body).toMatchObject({
      id: CONNECTION_ID,
      webhookRemoved: true,
    });
  });

  it('DELETE with non-UUID returns 400', async () => {
    await request(app.getHttpServer())
      .delete('/platforms/telegram/connections/not-a-uuid')
      .expect(HttpStatus.BAD_REQUEST);
  });

  // ── Response serialisation safety ─────────────────────────────────────

  it('no endpoint ever returns encryptedToken, secretTokenHash or webhookPathId', async () => {
    const responses = await Promise.all([
      request(app.getHttpServer()).get('/platforms/telegram/connections'),
      request(app.getHttpServer()).get(`/platforms/telegram/connections/${CONNECTION_ID}`),
      request(app.getHttpServer())
        .post('/platforms/telegram/connections')
        .send({ botToken: '123456789:AAHfakeTokenValueForTests_0123456789abc' }),
    ]);

    for (const res of responses) {
      const json = JSON.stringify(res.body);
      expect(json).not.toContain('encryptedToken');
      expect(json).not.toContain('secretTokenHash');
      expect(json).not.toContain('webhookPathId');
      expect(json).not.toContain('passwordHash');
    }
  });
});
