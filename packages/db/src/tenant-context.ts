import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * Names of the PostgreSQL settings read by the RLS policies. They are always
 * set with `is_local = true` inside the transaction that runs tenant queries.
 */
export const RLS_SETTINGS = {
  tenantId: 'app.tenant_id',
  userId: 'app.user_id',
  webhookPathId: 'app.webhook_path_id',
  context: 'app.context',
} as const;

export type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export interface TenantScope {
  tenantId: string;
  userId?: string;
}

export interface AuthScope {
  userId?: string;
}

export interface WebhookLookupScope {
  webhookPathId: string;
}

/**
 * Interactive-transaction limits. Request-level tenant transactions that call
 * out to third parties (e.g. Telegram setWebhook) need a longer `timeoutMs`
 * than Prisma's 5 s default; keep it bounded so a stuck call cannot pin a
 * connection indefinitely.
 */
export interface ScopeOptions {
  timeoutMs?: number;
  maxWaitMs?: number;
}

type ActiveTransaction = {
  client: TransactionClient;
  tenantId?: string;
};

type RlsScope = {
  tenantId?: string;
  userId?: string;
  webhookPathId?: string;
  context?: 'auth' | 'webhook';
};

const activeTransaction = new AsyncLocalStorage<ActiveTransaction>();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PATH_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;

function assertUuid(value: string, name: string): void {
  if (!UUID_RE.test(value)) throw new TypeError(`${name} must be a UUID`);
}

async function withRlsScope<T>(
  prisma: PrismaClient,
  scope: RlsScope,
  fn: (tx: TransactionClient) => Promise<T>,
  options: ScopeOptions = {},
): Promise<T> {
  if (scope.tenantId !== undefined) assertUuid(scope.tenantId, 'tenantId');
  if (scope.userId !== undefined) assertUuid(scope.userId, 'userId');
  if (scope.webhookPathId !== undefined && !PATH_ID_RE.test(scope.webhookPathId)) {
    throw new TypeError('webhookPathId has an unexpected format');
  }
  const transactionOptions = {
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    ...(options.maxWaitMs !== undefined ? { maxWait: options.maxWaitMs } : {}),
  };

  return prisma.$transaction(async (tx) => {
    const settings: [string, string][] = [
      [RLS_SETTINGS.tenantId, scope.tenantId ?? ''],
      [RLS_SETTINGS.userId, scope.userId ?? ''],
      [RLS_SETTINGS.webhookPathId, scope.webhookPathId ?? ''],
      [RLS_SETTINGS.context, scope.context ?? ''],
    ];

    return activeTransaction.run(
      { client: tx, ...(scope.tenantId ? { tenantId: scope.tenantId } : {}) },
      async () => {
        for (const [name, value] of settings) {
          await tx.$queryRaw(Prisma.sql`SELECT set_config(${name}, ${value}, true)`);
        }
        return fn(tx);
      },
    );
  }, transactionOptions);
}

/**
 * Runs tenant queries in an interactive transaction with a required tenant ID.
 * The callback is the only place a transaction client is exposed. Tenant
 * services outside a callback must use `requireTenantTransactionClient()`,
 * which fails closed when no authenticated tenant transaction is active.
 */
export function withTenantScope<T>(
  prisma: PrismaClient,
  scope: TenantScope,
  fn: (tx: TransactionClient) => Promise<T>,
  options?: ScopeOptions,
): Promise<T> {
  return withRlsScope(prisma, scope, fn, options);
}

/** Pre-login and identity operations use a separately named, non-tenant scope. */
export function withAuthScope<T>(
  prisma: PrismaClient,
  scope: AuthScope,
  fn: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  return withRlsScope(prisma, { ...scope, context: 'auth' }, fn);
}

/** The webhook path is the only permitted pre-tenant lookup context. */
export function withWebhookLookupScope<T>(
  prisma: PrismaClient,
  scope: WebhookLookupScope,
  fn: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  return withRlsScope(prisma, { ...scope, context: 'webhook' }, fn);
}

/**
 * Returns the active tenant transaction for request-scoped tenant services.
 * This intentionally throws outside a tenant transaction, preventing a
 * service from silently falling back to an unscoped Prisma client.
 */
export function requireTenantTransactionClient(): TransactionClient {
  const current = activeTransaction.getStore();
  if (!current?.tenantId) {
    throw new Error('Tenant database access requires an active tenant transaction');
  }
  return current.client;
}

/**
 * Returns true when an active RLS scope (tenant, auth, or webhook) is set.
 * Used by the TenantPrismaClient proxy to decide whether model access is safe.
 */
export function isInsideRlsScope(): boolean {
  return activeTransaction.getStore() !== undefined;
}
