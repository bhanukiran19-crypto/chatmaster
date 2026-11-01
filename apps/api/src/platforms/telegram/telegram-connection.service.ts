import {
  BadGatewayException,
  BadRequestException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EncryptionError, generateOpaqueToken, sha256Hex } from '@chatmaster/crypto';
import type { EncryptionService } from '@chatmaster/crypto';
import { requireTenantTransactionClient } from '@chatmaster/db';
import type { ConnectionStatus, TransactionClient } from '@chatmaster/db';
import {
  TelegramApiError,
  TelegramUnavailableError,
  type TelegramApiClient,
} from './telegram-api.client.js';

export interface TenantActor {
  tenantId: string;
  userId: string;
}

/**
 * What the API returns for a connection. Deliberately an allow-list: the
 * encrypted token, secret-token hash and webhook path id never leave the
 * service, so a serialisation mistake cannot leak them.
 */
export interface TelegramConnectionView {
  id: string;
  platform: 'TELEGRAM';
  status: ConnectionStatus;
  botId: string;
  botUsername: string;
  lastWebhookAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DisconnectResult {
  id: string;
  /** False when Telegram could not be reached; the local token is still deleted. */
  webhookRemoved: boolean;
}

export interface TelegramConnectionServiceOptions {
  /** Public origin (optionally with base path) that Telegram posts updates to. */
  publicApiUrl: string;
  /** Test seam; production uses the request-scoped tenant transaction. */
  transactionClient?: () => TransactionClient;
}

const CONNECTION_SELECT = {
  id: true,
  status: true,
  externalAccountId: true,
  displayName: true,
  lastWebhookAt: true,
  lastError: true,
  createdAt: true,
  updatedAt: true,
} as const;

type ConnectionRow = {
  id: string;
  status: ConnectionStatus;
  externalAccountId: string;
  displayName: string;
  lastWebhookAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Updates the inbound handler understands; anything else is dropped by Telegram. */
const ALLOWED_UPDATES = ['message', 'callback_query'] as const;
const WEBHOOK_PATH_ID_BYTES = 24; // 32 base64url chars
const SECRET_TOKEN_BYTES = 32; // 43 base64url chars (Telegram allows 1-256 of [A-Za-z0-9_-])
const MAX_STORED_ERROR = 1024;

function tokenAad(tenantId: string): string {
  // Binds the ciphertext to its tenant: a row copied between tenants will not decrypt.
  return `telegram-bot-token:${tenantId}`;
}

function toView(row: ConnectionRow): TelegramConnectionView {
  return {
    id: row.id,
    platform: 'TELEGRAM',
    status: row.status,
    botId: row.externalAccountId,
    botUsername: row.displayName,
    lastWebhookAt: row.lastWebhookAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Maps client errors to HTTP responses that never echo the token or raw upstream text. */
function toHttpError(error: unknown, action: 'validate' | 'register webhook'): Error {
  if (error instanceof TelegramApiError) {
    if (error.errorCode === 401 || error.errorCode === 404) {
      return new BadRequestException('Telegram rejected the bot token');
    }
    if (error.errorCode === 429) {
      return new ServiceUnavailableException('Telegram is rate limiting requests; try again later');
    }
    if (error.errorCode >= 400 && error.errorCode < 500) {
      return new BadRequestException(`Telegram could not ${action}: ${error.description}`);
    }
    return new BadGatewayException(`Telegram could not ${action}`);
  }
  if (error instanceof TelegramUnavailableError) {
    return new ServiceUnavailableException(
      error.reason === 'timeout'
        ? 'Telegram did not respond in time; try again'
        : 'Telegram is unavailable; try again later',
    );
  }
  return error instanceof Error ? error : new Error('Unknown Telegram error');
}

export class TelegramConnectionService {
  private readonly logger = new Logger(TelegramConnectionService.name);
  private readonly webhookBaseUrl: string;
  private readonly tx: () => TransactionClient;

  constructor(
    private readonly telegram: TelegramApiClient,
    private readonly encryption: EncryptionService,
    options: TelegramConnectionServiceOptions,
  ) {
    this.webhookBaseUrl = options.publicApiUrl.replace(/\/+$/, '');
    this.tx = options.transactionClient ?? requireTenantTransactionClient;
  }

  async list(actor: TenantActor): Promise<TelegramConnectionView[]> {
    const rows = await this.tx().platformConnection.findMany({
      where: { tenantId: actor.tenantId, platform: 'TELEGRAM' },
      select: CONNECTION_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toView);
  }

  async get(actor: TenantActor, connectionId: string): Promise<TelegramConnectionView> {
    const row = await this.tx().platformConnection.findFirst({
      where: { id: connectionId, tenantId: actor.tenantId, platform: 'TELEGRAM' },
      select: CONNECTION_SELECT,
    });
    if (!row) throw new NotFoundException('Connection not found');
    return toView(row);
  }

  /**
   * Validates the token with getMe, stores it encrypted, mints a fresh webhook
   * path id + secret and registers the webhook. Runs inside the request's
   * tenant transaction, so a setWebhook failure rolls the row back: a
   * connection either exists fully wired or not at all. Re-connecting the same
   * bot rotates its token, path id and secret in place.
   */
  async connect(actor: TenantActor, botToken: string): Promise<TelegramConnectionView> {
    let identity;
    try {
      identity = await this.telegram.getMe(botToken);
    } catch (error) {
      throw toHttpError(error, 'validate');
    }
    if (!identity.isBot) throw new BadRequestException('Token does not belong to a bot');

    const tx = this.tx();
    const botId = String(identity.id);
    const webhookPathId = generateOpaqueToken(WEBHOOK_PATH_ID_BYTES);
    const secretToken = generateOpaqueToken(SECRET_TOKEN_BYTES);
    const encrypted = this.encryption.encrypt(botToken, tokenAad(actor.tenantId));
    const tokenFields = {
      displayName: identity.username,
      encryptedToken: Buffer.from(encrypted.ciphertext),
      tokenKeyVersion: encrypted.keyVersion,
      webhookPathId,
      secretTokenHash: sha256Hex(secretToken),
      status: 'PENDING' as const,
      lastError: null,
    };

    const existing = await tx.platformConnection.findFirst({
      where: { tenantId: actor.tenantId, platform: 'TELEGRAM', externalAccountId: botId },
      select: { id: true },
    });
    const row = existing
      ? await tx.platformConnection.update({
          where: { id: existing.id },
          data: tokenFields,
          select: CONNECTION_SELECT,
        })
      : await tx.platformConnection.create({
          data: {
            tenantId: actor.tenantId,
            platform: 'TELEGRAM',
            externalAccountId: botId,
            ...tokenFields,
          },
          select: CONNECTION_SELECT,
        });

    try {
      await this.telegram.setWebhook(botToken, {
        url: `${this.webhookBaseUrl}/webhooks/telegram/${webhookPathId}`,
        secretToken,
        allowedUpdates: ALLOWED_UPDATES,
        dropPendingUpdates: true,
      });
    } catch (error) {
      this.logger.warn(
        `setWebhook failed for connection ${row.id}: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      throw toHttpError(error, 'register webhook');
    }

    const active = await tx.platformConnection.update({
      where: { id: row.id },
      data: { status: 'ACTIVE', lastError: null },
      select: CONNECTION_SELECT,
    });
    await tx.auditLog.create({
      data: {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: existing ? 'platform.telegram.reconnected' : 'platform.telegram.connected',
        entityType: 'platform_connection',
        entityId: active.id,
        metadata: { botId, botUsername: identity.username },
      },
    });
    return toView(active);
  }

  /**
   * Best-effort deleteWebhook, then unconditional local deletion. The local
   * delete must not depend on Telegram being up: once the row is gone the
   * webhook path 404s and the token ciphertext no longer exists, so a stale
   * Telegram-side webhook is harmless.
   */
  async disconnect(actor: TenantActor, connectionId: string): Promise<DisconnectResult> {
    const tx = this.tx();
    const row = await tx.platformConnection.findFirst({
      where: { id: connectionId, tenantId: actor.tenantId, platform: 'TELEGRAM' },
      select: { id: true, encryptedToken: true, externalAccountId: true },
    });
    if (!row) throw new NotFoundException('Connection not found');

    let webhookRemoved = false;
    let failureNote: string | undefined;
    try {
      const botToken = this.encryption.decryptToString(
        new Uint8Array(row.encryptedToken),
        tokenAad(actor.tenantId),
      );
      await this.telegram.deleteWebhook(botToken);
      webhookRemoved = true;
    } catch (error) {
      if (error instanceof TelegramApiError && (error.errorCode === 401 || error.errorCode === 404)) {
        // Token already revoked on Telegram's side: nothing left to remove.
        webhookRemoved = true;
      } else if (error instanceof EncryptionError) {
        failureNote = 'token undecryptable';
      } else if (error instanceof TelegramApiError || error instanceof TelegramUnavailableError) {
        failureNote = error.message.slice(0, MAX_STORED_ERROR);
      } else {
        throw error;
      }
      this.logger.warn(`deleteWebhook skipped for connection ${row.id}: ${failureNote ?? 'n/a'}`);
    }

    await tx.platformConnection.delete({ where: { id: row.id } });
    await tx.auditLog.create({
      data: {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: 'platform.telegram.disconnected',
        entityType: 'platform_connection',
        entityId: row.id,
        metadata: {
          botId: row.externalAccountId,
          webhookRemoved,
          ...(failureNote ? { failure: failureNote } : {}),
        },
      },
    });
    return { id: row.id, webhookRemoved };
  }
}
