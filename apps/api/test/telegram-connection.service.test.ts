import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  BadRequestException,
  BadGatewayException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AesGcmEncryptionService, createKeyring, sha256Hex } from '@chatmaster/crypto';
import type { EncryptionService } from '@chatmaster/crypto';
import type { TransactionClient } from '@chatmaster/db';
import {
  TelegramApiError,
  TelegramUnavailableError,
  type SetWebhookInput,
  type TelegramApiClient,
  type TelegramBotIdentity,
} from '../src/platforms/telegram/telegram-api.client.js';
import { TelegramConnectionService } from '../src/platforms/telegram/telegram-connection.service.js';
import {
  botTokenSchema,
  connectTelegramSchema,
  connectionIdSchema,
} from '../src/platforms/telegram/telegram.validation.js';

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

const TOKEN = '123456789:AAHfakeTokenValueForTests_0123456789abc';
const TENANT_ID = randomUUID();
const OTHER_TENANT_ID = randomUUID();
const USER_ID = randomUUID();
const ACTOR = { tenantId: TENANT_ID, userId: USER_ID };
const IDENTITY: TelegramBotIdentity = {
  id: 123456789,
  isBot: true,
  username: 'my_bot',
  firstName: 'My Bot',
};

// ────────────────────────────────────────────────────────────────────────────
// In-memory fake transaction (simulates RLS tenant filtering)
// ────────────────────────────────────────────────────────────────────────────

type Row = {
  id: string;
  tenantId: string;
  platform: 'TELEGRAM';
  status: 'PENDING' | 'ACTIVE' | 'DISABLED' | 'ERROR';
  externalAccountId: string;
  displayName: string;
  encryptedToken: Uint8Array;
  tokenKeyVersion: number;
  webhookPathId: string;
  secretTokenHash: string;
  lastWebhookAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

class FakeTx {
  rows = new Map<string, Row>();
  audits: unknown[] = [];

  private pick(row: Row, select?: Record<string, boolean>): Record<string, unknown> {
    if (!select) return { ...row };
    return Object.fromEntries(Object.keys(select).map((key) => [key, row[key as keyof Row]]));
  }

  private matches(row: Row, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, value]) => row[key as keyof Row] === value);
  }

  platformConnection = {
    findMany: vi.fn(
      async ({
        where,
        select,
      }: {
        where: Record<string, unknown>;
        select?: Record<string, boolean>;
      }) =>
        [...this.rows.values()]
          .filter((row) => this.matches(row, where))
          .map((row) => this.pick(row, select)),
    ),
    findFirst: vi.fn(
      async ({
        where,
        select,
      }: {
        where: Record<string, unknown>;
        select?: Record<string, boolean>;
      }) => {
        const row = [...this.rows.values()].find((candidate) => this.matches(candidate, where));
        return row ? this.pick(row, select) : null;
      },
    ),
    create: vi.fn(
      async ({
        data,
        select,
      }: {
        data: Omit<Row, 'id' | 'createdAt' | 'updatedAt' | 'lastWebhookAt'>;
        select?: Record<string, boolean>;
      }) => {
        const now = new Date();
        const row: Row = {
          ...data,
          id: randomUUID(),
          lastWebhookAt: null,
          createdAt: now,
          updatedAt: now,
        };
        this.rows.set(row.id, row);
        return this.pick(row, select);
      },
    ),
    update: vi.fn(
      async ({
        where,
        data,
        select,
      }: {
        where: { id: string };
        data: Partial<Row>;
        select?: Record<string, boolean>;
      }) => {
        const row = this.rows.get(where.id);
        if (!row) throw new Error('Record not found');
        const next = { ...row, ...data, updatedAt: new Date() };
        this.rows.set(where.id, next);
        return this.pick(next, select);
      },
    ),
    delete: vi.fn(async ({ where }: { where: { id: string } }) => {
      const row = this.rows.get(where.id);
      if (!row) throw new Error('Record not found');
      this.rows.delete(where.id);
      return row;
    }),
  };

  auditLog = {
    create: vi.fn(async ({ data }: { data: unknown }) => {
      this.audits.push(data);
      return data;
    }),
  };
}

class FakeTelegram implements TelegramApiClient {
  getMe = vi.fn<(token: string) => Promise<TelegramBotIdentity>>(async () => IDENTITY);
  setWebhook = vi.fn<(token: string, input: SetWebhookInput) => Promise<void>>(
    async () => undefined,
  );
  deleteWebhook = vi.fn<(token: string) => Promise<void>>(async () => undefined);
  sendMessage = vi.fn<TelegramApiClient['sendMessage']>(async () => ({ messageId: 1 }));
  answerCallbackQuery = vi.fn<TelegramApiClient['answerCallbackQuery']>(async () => undefined);
}

function build(encryptionOverride?: EncryptionService) {
  const tx = new FakeTx();
  const telegram = new FakeTelegram();
  const encryption =
    encryptionOverride ??
    new AesGcmEncryptionService(createKeyring({ 1: new Uint8Array(randomBytes(32)) }));
  const service = new TelegramConnectionService(telegram, encryption, {
    publicApiUrl: 'https://api.example.com/',
    transactionClient: () => tx as unknown as TransactionClient,
  });
  return { tx, telegram, encryption, service };
}

// ────────────────────────────────────────────────────────────────────────────
// Zod validation schemas
// ────────────────────────────────────────────────────────────────────────────

describe('Telegram Zod validation schemas', () => {
  describe('botTokenSchema', () => {
    it('accepts a valid Telegram bot token', () => {
      expect(botTokenSchema.parse('123456789:AAHfakeTokenValueForTests_0123456789abc')).toBe(
        '123456789:AAHfakeTokenValueForTests_0123456789abc',
      );
    });

    it.each([
      ['empty string', ''],
      ['no colon', '123456789AAHfakeToken'],
      ['too-short numeric prefix', '12345:AAHfakeTokenValueForTests_0123456789abc'],
      ['letters in numeric prefix', 'abc456789:AAHfakeTokenValueForTests_0123456789abc'],
      ['secret too short', '123456789:short'],
      ['SQL injection attempt', "123456789:'; DROP TABLE users; --aaaaaaaaaaaaaaa"],
      ['path traversal', '../../admin:AAHfakeTokenValueForTests_0123456789abc'],
      ['newlines', '123456789:AAHfakeTokenValueForTests\n_0123456789'],
    ])('rejects %s', (_label, input) => {
      expect(botTokenSchema.safeParse(input).success).toBe(false);
    });

    it('trims whitespace', () => {
      const padded = '  123456789:AAHfakeTokenValueForTests_0123456789abc  ';
      expect(botTokenSchema.parse(padded)).toBe(
        '123456789:AAHfakeTokenValueForTests_0123456789abc',
      );
    });
  });

  describe('connectTelegramSchema', () => {
    it('accepts valid body and rejects unknown fields', () => {
      const valid = { botToken: TOKEN };
      expect(connectTelegramSchema.parse(valid)).toEqual({ botToken: TOKEN });

      const withExtra = { botToken: TOKEN, extra: 'field' };
      expect(connectTelegramSchema.safeParse(withExtra).success).toBe(false);
    });
  });

  describe('connectionIdSchema', () => {
    it('accepts a valid UUID', () => {
      const id = randomUUID();
      expect(connectionIdSchema.parse(id)).toBe(id);
    });

    it('rejects non-UUID strings', () => {
      expect(connectionIdSchema.safeParse('not-a-uuid').success).toBe(false);
      expect(connectionIdSchema.safeParse('').success).toBe(false);
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Connection Service – connect flow
// ────────────────────────────────────────────────────────────────────────────

describe('TelegramConnectionService.connect', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(() => {
    ctx = build();
  });

  it('validates with getMe, stores an encrypted token and registers the webhook', async () => {
    const view = await ctx.service.connect(ACTOR, TOKEN);

    expect(ctx.telegram.getMe).toHaveBeenCalledWith(TOKEN);
    expect(view).toMatchObject({
      platform: 'TELEGRAM',
      status: 'ACTIVE',
      botId: '123456789',
      botUsername: 'my_bot',
      lastError: null,
    });

    const row = [...ctx.tx.rows.values()][0]!;
    expect(row.tenantId).toBe(TENANT_ID);
    // The encrypted token must not contain the plaintext
    expect(Buffer.from(row.encryptedToken).toString('utf8')).not.toContain(TOKEN);
    // Decrypting with correct AAD yields the original token
    expect(
      ctx.encryption.decryptToString(row.encryptedToken, `telegram-bot-token:${TENANT_ID}`),
    ).toBe(TOKEN);
    expect(row.tokenKeyVersion).toBe(1);
    // Webhook path ID is 32 base64url chars (24 random bytes)
    expect(row.webhookPathId).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const [, webhook] = ctx.telegram.setWebhook.mock.calls[0]!;
    expect(webhook.url).toBe(`https://api.example.com/webhooks/telegram/${row.webhookPathId}`);
    // Secret token is 43 base64url chars (32 random bytes)
    expect(webhook.secretToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The stored hash matches the secret sent to Telegram
    expect(sha256Hex(webhook.secretToken)).toBe(row.secretTokenHash);
    expect(webhook.allowedUpdates).toEqual(['message', 'callback_query']);

    // Audit trail records the connection
    expect(ctx.tx.audits).toHaveLength(1);
    // Audit must never contain the token
    expect(JSON.stringify(ctx.tx.audits)).not.toContain(TOKEN);
  });

  it('never exposes secrets in the returned view', async () => {
    const view = await ctx.service.connect(ACTOR, TOKEN);
    const serialised = JSON.stringify(view);

    expect(Object.keys(view).sort()).toEqual([
      'botId',
      'botUsername',
      'createdAt',
      'id',
      'lastError',
      'lastWebhookAt',
      'platform',
      'status',
      'updatedAt',
    ]);
    expect(serialised).not.toContain(TOKEN);
    expect(serialised).not.toContain('encryptedToken');
    expect(serialised).not.toContain('secretTokenHash');
    expect(serialised).not.toContain('webhookPathId');
  });

  it('binds the ciphertext to the tenant via AAD', async () => {
    await ctx.service.connect(ACTOR, TOKEN);
    const row = [...ctx.tx.rows.values()][0]!;

    // Decrypting with a different tenant's AAD must fail
    expect(() =>
      ctx.encryption.decryptToString(row.encryptedToken, `telegram-bot-token:${OTHER_TENANT_ID}`),
    ).toThrow(/Decryption failed/);
  });

  it('reconnecting the same bot rotates token, path id and secret in place', async () => {
    const first = await ctx.service.connect(ACTOR, TOKEN);
    const before = { ...[...ctx.tx.rows.values()][0]! };

    const second = await ctx.service.connect(ACTOR, TOKEN);
    const after = [...ctx.tx.rows.values()][0]!;

    expect(second.id).toBe(first.id);
    expect(ctx.tx.rows.size).toBe(1);
    expect(after.webhookPathId).not.toBe(before.webhookPathId);
    expect(after.secretTokenHash).not.toBe(before.secretTokenHash);
    expect(Buffer.from(after.encryptedToken).equals(Buffer.from(before.encryptedToken))).toBe(
      false,
    );
    expect(ctx.tx.audits.at(-1)).toMatchObject({ action: 'platform.telegram.reconnected' });
  });

  it('rejects a token Telegram reports as unauthorized without touching the database', async () => {
    ctx.telegram.getMe.mockRejectedValueOnce(new TelegramApiError('getMe', 401, 'Unauthorized'));

    await expect(ctx.service.connect(ACTOR, TOKEN)).rejects.toBeInstanceOf(BadRequestException);
    expect(ctx.tx.platformConnection.create).not.toHaveBeenCalled();
    expect(ctx.telegram.setWebhook).not.toHaveBeenCalled();
  });

  it('rejects tokens that belong to a user account rather than a bot', async () => {
    ctx.telegram.getMe.mockResolvedValueOnce({ ...IDENTITY, isBot: false });

    await expect(ctx.service.connect(ACTOR, TOKEN)).rejects.toBeInstanceOf(BadRequestException);
    expect(ctx.tx.platformConnection.create).not.toHaveBeenCalled();
  });

  it('maps a getMe timeout to 503 and does not store anything', async () => {
    ctx.telegram.getMe.mockRejectedValueOnce(new TelegramUnavailableError('getMe', 'timeout'));

    const error = await ctx.service.connect(ACTOR, TOKEN).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toMatch(/did not respond/);
    expect(ctx.tx.rows.size).toBe(0);
  });

  it('maps a getMe network error to 503', async () => {
    ctx.telegram.getMe.mockRejectedValueOnce(new TelegramUnavailableError('getMe', 'network'));

    const error = await ctx.service.connect(ACTOR, TOKEN).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toMatch(/unavailable/);
    expect(ctx.tx.rows.size).toBe(0);
  });

  it('maps getMe 404 to BadRequest (token not found by Telegram)', async () => {
    ctx.telegram.getMe.mockRejectedValueOnce(new TelegramApiError('getMe', 404, 'Not Found'));

    await expect(ctx.service.connect(ACTOR, TOKEN)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps getMe 429 to ServiceUnavailable', async () => {
    ctx.telegram.getMe.mockRejectedValueOnce(
      new TelegramApiError('getMe', 429, 'Too Many Requests', 10),
    );

    await expect(ctx.service.connect(ACTOR, TOKEN)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('maps getMe 500 to BadGateway', async () => {
    ctx.telegram.getMe.mockRejectedValueOnce(
      new TelegramApiError('getMe', 500, 'Internal Server Error'),
    );

    await expect(ctx.service.connect(ACTOR, TOKEN)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it.each([
    [
      new TelegramApiError(
        'setWebhook',
        400,
        'Bad Request: bad webhook: HTTPS url must be provided',
      ),
      BadRequestException,
    ],
    [new TelegramApiError('setWebhook', 429, 'Too Many Requests', 5), ServiceUnavailableException],
    [new TelegramApiError('setWebhook', 500, 'Internal Server Error'), BadGatewayException],
    [new TelegramUnavailableError('setWebhook', 'network'), ServiceUnavailableException],
    [new TelegramUnavailableError('setWebhook', 'timeout'), ServiceUnavailableException],
  ])(
    'propagates setWebhook failure %o as %s so the transaction rolls back',
    async (failure, expected) => {
      ctx.telegram.setWebhook.mockRejectedValueOnce(failure);

      const error = await ctx.service.connect(ACTOR, TOKEN).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(expected);
      expect((error as Error).message).not.toContain(TOKEN);
      // The row was written before setWebhook; the surrounding request transaction rolls it back.
      expect([...ctx.tx.rows.values()][0]?.status).toBe('PENDING');
    },
  );

  it('never leaks the token in any error message', async () => {
    // getMe error
    ctx.telegram.getMe.mockRejectedValueOnce(new TelegramApiError('getMe', 401, 'Unauthorized'));
    const error1 = await ctx.service.connect(ACTOR, TOKEN).catch((e: unknown) => e);
    expect((error1 as Error).message).not.toContain(TOKEN);

    // setWebhook error
    ctx.telegram.getMe.mockResolvedValueOnce(IDENTITY);
    ctx.telegram.setWebhook.mockRejectedValueOnce(
      new TelegramApiError('setWebhook', 400, 'Bad webhook'),
    );
    const error2 = await ctx.service.connect(ACTOR, TOKEN).catch((e: unknown) => e);
    expect((error2 as Error).message).not.toContain(TOKEN);
  });

  it('strips trailing slashes from publicApiUrl in webhook URL', async () => {
    const customCtx = build();
    // The fixture already uses 'https://api.example.com/' (trailing slash)
    await customCtx.service.connect(ACTOR, TOKEN);
    const [, webhook] = customCtx.telegram.setWebhook.mock.calls[0]!;
    expect(webhook.url).toMatch(
      /^https:\/\/api\.example\.com\/webhooks\/telegram\/[A-Za-z0-9_-]+$/,
    );
    expect(webhook.url).not.toContain('//webhooks');
  });

  it('sets dropPendingUpdates=true on initial connect', async () => {
    await ctx.service.connect(ACTOR, TOKEN);
    const [, webhook] = ctx.telegram.setWebhook.mock.calls[0]!;
    expect(webhook.dropPendingUpdates).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Connection Service – disconnect flow
// ────────────────────────────────────────────────────────────────────────────

describe('TelegramConnectionService.disconnect', () => {
  let ctx: ReturnType<typeof build>;
  let connectionId: string;
  beforeEach(async () => {
    ctx = build();
    connectionId = (await ctx.service.connect(ACTOR, TOKEN)).id;
    ctx.telegram.deleteWebhook.mockClear();
  });

  it('calls deleteWebhook with the decrypted token and deletes the row', async () => {
    const result = await ctx.service.disconnect(ACTOR, connectionId);

    expect(ctx.telegram.deleteWebhook).toHaveBeenCalledWith(TOKEN);
    expect(result).toEqual({ id: connectionId, webhookRemoved: true });
    expect(ctx.tx.rows.size).toBe(0);
    expect(ctx.tx.audits.at(-1)).toMatchObject({
      action: 'platform.telegram.disconnected',
      metadata: { webhookRemoved: true },
    });
  });

  it('still deletes the token when Telegram is unreachable and reports webhookRemoved=false', async () => {
    ctx.telegram.deleteWebhook.mockRejectedValueOnce(
      new TelegramUnavailableError('deleteWebhook', 'timeout'),
    );

    const result = await ctx.service.disconnect(ACTOR, connectionId);

    expect(result).toEqual({ id: connectionId, webhookRemoved: false });
    expect(ctx.tx.rows.size).toBe(0);
  });

  it('still deletes the token on a network error and reports webhookRemoved=false', async () => {
    ctx.telegram.deleteWebhook.mockRejectedValueOnce(
      new TelegramUnavailableError('deleteWebhook', 'network'),
    );

    const result = await ctx.service.disconnect(ACTOR, connectionId);

    expect(result).toEqual({ id: connectionId, webhookRemoved: false });
    expect(ctx.tx.rows.size).toBe(0);
    expect(ctx.tx.audits.at(-1)).toMatchObject({
      metadata: expect.objectContaining({ webhookRemoved: false, failure: expect.any(String) }),
    });
  });

  it('treats an already-revoked token (401) as removed', async () => {
    ctx.telegram.deleteWebhook.mockRejectedValueOnce(
      new TelegramApiError('deleteWebhook', 401, 'Unauthorized'),
    );

    const result = await ctx.service.disconnect(ACTOR, connectionId);

    expect(result.webhookRemoved).toBe(true);
    expect(ctx.tx.rows.size).toBe(0);
  });

  it('treats a 404 from Telegram as removed', async () => {
    ctx.telegram.deleteWebhook.mockRejectedValueOnce(
      new TelegramApiError('deleteWebhook', 404, 'Not Found'),
    );

    const result = await ctx.service.disconnect(ACTOR, connectionId);

    expect(result.webhookRemoved).toBe(true);
    expect(ctx.tx.rows.size).toBe(0);
  });

  it('returns 404 for connections owned by another tenant (IDOR protection)', async () => {
    await expect(
      ctx.service.disconnect({ tenantId: OTHER_TENANT_ID, userId: randomUUID() }, connectionId),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(ctx.telegram.deleteWebhook).not.toHaveBeenCalled();
    expect(ctx.tx.rows.size).toBe(1);
  });

  it('returns 404 for unknown connection IDs', async () => {
    await expect(ctx.service.disconnect(ACTOR, randomUUID())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('handles EncryptionError during disconnect gracefully (still deletes the row)', async () => {
    // Simulate a key rotation that makes the stored token undecryptable:
    // build a service with key version 2, but the token was encrypted with key version 1
    const key2 = new Uint8Array(randomBytes(32));
    const encryptionV2 = new AesGcmEncryptionService(createKeyring({ 2: key2 }));
    // The existing row in ctx.tx was encrypted with key version 1 – the new encryption
    // service only knows key 2, so decryption will fail.
    const serviceV2 = new TelegramConnectionService(ctx.telegram, encryptionV2, {
      publicApiUrl: 'https://api.example.com/',
      transactionClient: () => ctx.tx as unknown as TransactionClient,
    });

    const result = await serviceV2.disconnect(ACTOR, connectionId);

    // The webhook could NOT be removed (token undecryptable), but the row IS deleted
    expect(result.webhookRemoved).toBe(false);
    expect(ctx.tx.rows.size).toBe(0);
    expect(ctx.telegram.deleteWebhook).not.toHaveBeenCalled();
    expect(ctx.tx.audits.at(-1)).toMatchObject({
      metadata: expect.objectContaining({ failure: 'token undecryptable' }),
    });
  });

  it('never leaks the token in the disconnect audit log', async () => {
    await ctx.service.disconnect(ACTOR, connectionId);

    const auditJson = JSON.stringify(ctx.tx.audits);
    expect(auditJson).not.toContain(TOKEN);
    expect(auditJson).not.toContain('encryptedToken');
  });

  it('records the bot ID in the disconnect audit for traceability', async () => {
    await ctx.service.disconnect(ACTOR, connectionId);

    expect(ctx.tx.audits.at(-1)).toMatchObject({
      metadata: expect.objectContaining({ botId: '123456789' }),
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Connection Service – list / get
// ────────────────────────────────────────────────────────────────────────────

describe('TelegramConnectionService.list / get', () => {
  it('lists only the tenant connections with safe fields', async () => {
    const ctx = build();
    await ctx.service.connect(ACTOR, TOKEN);

    const mine = await ctx.service.list(ACTOR);
    const theirs = await ctx.service.list({ tenantId: OTHER_TENANT_ID, userId: randomUUID() });

    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(0);
    expect(JSON.stringify(mine)).not.toContain(TOKEN);
    expect(mine[0]).not.toHaveProperty('encryptedToken');
    expect(mine[0]).not.toHaveProperty('secretTokenHash');
    expect(mine[0]).not.toHaveProperty('webhookPathId');
  });

  it('get returns 404 across tenants (IDOR protection)', async () => {
    const ctx = build();
    const { id } = await ctx.service.connect(ACTOR, TOKEN);

    await expect(ctx.service.get(ACTOR, id)).resolves.toMatchObject({ id });
    await expect(
      ctx.service.get({ tenantId: OTHER_TENANT_ID, userId: randomUUID() }, id),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('get returns 404 for a random UUID', async () => {
    const ctx = build();
    await expect(ctx.service.get(ACTOR, randomUUID())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('list returns connections ordered by createdAt ascending', async () => {
    const ctx = build();
    // Connect two different bots
    const identity2: TelegramBotIdentity = {
      id: 987654321,
      isBot: true,
      username: 'bot_two',
      firstName: 'Bot Two',
    };
    await ctx.service.connect(ACTOR, TOKEN);
    ctx.telegram.getMe.mockResolvedValueOnce(identity2);
    const TOKEN2 = '987654321:BBHfakeTokenValueForTests_0123456789abc';
    await ctx.service.connect(ACTOR, TOKEN2);

    const list = await ctx.service.list(ACTOR);
    expect(list).toHaveLength(2);
    // First connection should be first (earlier createdAt)
    expect(list[0]!.botId).toBe('123456789');
    expect(list[1]!.botId).toBe('987654321');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Connection Service – encryption key rotation support
// ────────────────────────────────────────────────────────────────────────────

describe('TelegramConnectionService – key rotation', () => {
  it('stores the key version alongside the ciphertext', async () => {
    const ctx = build();
    await ctx.service.connect(ACTOR, TOKEN);
    const row = [...ctx.tx.rows.values()][0]!;

    expect(row.tokenKeyVersion).toBe(ctx.encryption.activeKeyVersion);
  });

  it('connects with a multi-key keyring and stores the active version', async () => {
    const key1 = new Uint8Array(randomBytes(32));
    const key2 = new Uint8Array(randomBytes(32));
    const multiKeyEncryption = new AesGcmEncryptionService(createKeyring({ 1: key1, 2: key2 }, 2));
    const ctx = build(multiKeyEncryption);

    await ctx.service.connect(ACTOR, TOKEN);
    const row = [...ctx.tx.rows.values()][0]!;

    expect(row.tokenKeyVersion).toBe(2);
    expect(
      multiKeyEncryption.decryptToString(row.encryptedToken, `telegram-bot-token:${TENANT_ID}`),
    ).toBe(TOKEN);
  });
});
