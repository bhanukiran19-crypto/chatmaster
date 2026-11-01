import type { PrismaClient } from '@prisma/client';
import { isInsideRlsScope } from './tenant-context.js';

/**
 * Allowlist of PrismaClient methods that are _not_ model accessors and are
 * safe to call without tenant context (lifecycle + raw queries are controlled
 * by the caller, never by a service that forgot the scope).
 */
const PRISMA_META_METHODS = new Set([
  '$connect',
  '$disconnect',
  '$on',
  '$transaction',
  '$use',
  '$extends',
  '$queryRaw',
  '$executeRaw',
  '$queryRawUnsafe',
  '$executeRawUnsafe',
]);

/**
 * A defensive proxy around PrismaClient that traps every model accessor
 * (e.g. `.user`, `.tenant`, `.workflow`, …) and throws unless the caller is
 * inside a `withTenantScope`, `withAuthScope`, or `withWebhookLookupScope`
 * callback. This guarantees that no code path can accidentally issue an
 * unscoped query – even if a developer forgets to call a scope function.
 *
 * Usage:
 * ```ts
 * const raw = new PrismaClient();
 * const prisma = createTenantPrismaClient(raw);
 *
 * // Direct model access → throws at runtime
 * await prisma.user.findMany(); // Error: PrismaClient model access outside RLS scope
 *
 * // Scoped access → works normally
 * await withTenantScope(prisma, scope, async (tx) => {
 *   return tx.user.findMany(); // OK – tx is the scoped transaction client
 * });
 * ```
 *
 * The proxy is transparent: `prisma instanceof PrismaClient` is false but
 * `$connect`, `$disconnect` etc. pass through unchanged.
 */
export type TenantSafePrismaClient = PrismaClient & {
  /** Marker property so callers can check whether the proxy is active. */
  readonly __tenantSafe: true;
};

export function createTenantPrismaClient(prisma: PrismaClient): TenantSafePrismaClient {
  return new Proxy(prisma, {
    get(target: PrismaClient, prop: string | symbol, receiver: unknown) {
      if (prop === '__tenantSafe') return true;

      // Allow symbol properties and meta methods to pass through.
      if (typeof prop === 'symbol' || PRISMA_META_METHODS.has(prop)) {
        return Reflect.get(target, prop, receiver);
      }

      // If we are inside an active RLS scope (any scope), model access on the
      // original PrismaClient is still guarded by RLS at the Postgres level.
      // However, code should use the TransactionClient from the scope callback,
      // not the outer PrismaClient. We still allow it for the $transaction
      // methods that withRlsScope calls internally.
      if (isInsideRlsScope()) {
        // Inside a scope – pass through (Postgres RLS is set).
        return Reflect.get(target, prop, receiver);
      }

      // Check if this looks like a model accessor (Prisma model delegates are
      // always objects). Block object-typed properties outside a scope.
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'object' && value !== null) {
        // This is a model delegate (e.g. prisma.user). Block it.
        throw new Error(
          `PrismaClient model access (".${prop}") outside an RLS scope. ` +
            'Wrap your query in withTenantScope(), withAuthScope(), or withWebhookLookupScope().',
        );
      }

      return value;
    },
  }) as TenantSafePrismaClient;
}
