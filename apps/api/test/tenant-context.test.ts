import { describe, expect, it } from 'vitest';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import {
  PrismaClient,
  createTenantPrismaClient,
  requireTenantTransactionClient,
  type TransactionClient,
  withAuthScope,
  withTenantScope,
} from '@chatmaster/db';
import { lastValueFrom, of } from 'rxjs';
import { AuthenticatedTenantGuard } from '../src/auth/authenticated-tenant.guard.js';
import type { AuthRepository } from '../src/auth/auth.contracts.js';
import type { AuthService } from '../src/auth/auth.service.js';
import { ACCESS_COOKIE_NAME } from '../src/auth/auth.security.js';
import { TenantContextInterceptor } from '../src/auth/tenant-context.interceptor.js';
import type { TenantContextRequest } from '../src/auth/tenant-auth-context.js';

const tenantId = '7f5d5200-3309-45ba-859f-5d2bb15ea0f7';
const userId = '8f5d5200-3309-45ba-859f-5d2bb15ea0f7';

function createPrismaStub() {
  const settings: { name: unknown; value: unknown; isLocal: boolean }[] = [];
  const transactionClient = {
    $queryRaw: async (query: { values: unknown[]; sql: string }) => {
      settings.push({
        name: query.values[0],
        value: query.values[1],
        isLocal: /,\s*true\s*\)$/.test(query.sql),
      });
      return [];
    },
  } as unknown as TransactionClient;
  const prisma = {
    $transaction: async <T>(callback: (tx: TransactionClient) => Promise<T>) =>
      callback(transactionClient),
  } as unknown as PrismaClient;
  return { prisma, settings, transactionClient };
}

describe('tenant transaction context', () => {
  it('fails closed when a tenant service requests Prisma outside tenant scope', async () => {
    expect(() => requireTenantTransactionClient()).toThrow(
      'Tenant database access requires an active tenant transaction',
    );

    const { prisma } = createPrismaStub();
    await expect(
      withAuthScope(prisma, {}, async () => requireTenantTransactionClient()),
    ).rejects.toThrow('Tenant database access requires an active tenant transaction');
  });

  it('sets all RLS settings transaction-locally and exposes only the scoped transaction', async () => {
    const { prisma, settings, transactionClient } = createPrismaStub();
    const result = await withTenantScope(prisma, { tenantId, userId }, async () =>
      requireTenantTransactionClient(),
    );

    expect(result).toBe(transactionClient);
    expect(settings).toEqual([
      { name: 'app.tenant_id', value: tenantId, isLocal: true },
      { name: 'app.user_id', value: userId, isLocal: true },
      { name: 'app.webhook_path_id', value: '', isLocal: true },
      { name: 'app.context', value: '', isLocal: true },
    ]);
    expect(() => requireTenantTransactionClient()).toThrow(
      'Tenant database access requires an active tenant transaction',
    );
  });

  it('resolves an active session to its server-owned tenant context', async () => {
    const request = {
      cookies: { [ACCESS_COOKIE_NAME]: 'valid-test-access-token-value' },
    } as unknown as TenantContextRequest;
    const auth = {
      authenticateAccessToken: async () => ({
        userId,
        sessionId: '9f5d5200-3309-45ba-859f-5d2bb15ea0f7',
      }),
      getCurrentUser: async () => ({
        id: userId,
        email: 'member@gmail.com',
        phoneE164: '+14155550123',
      }),
    } as unknown as AuthService;
    const repository = {
      findTenantIdByUserId: async () => tenantId,
    } as unknown as AuthRepository;
    const guard = new AuthenticatedTenantGuard(auth, repository);
    const executionContext = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(executionContext)).resolves.toBe(true);
    expect(request.tenantContext).toMatchObject({ userId, tenantId });
  });

  it('rejects authenticated users without a tenant', async () => {
    const request = {
      cookies: { [ACCESS_COOKIE_NAME]: 'valid-test-access-token-value' },
    } as unknown as TenantContextRequest;
    const auth = {
      authenticateAccessToken: async () => ({
        userId,
        sessionId: '9f5d5200-3309-45ba-859f-5d2bb15ea0f7',
      }),
      getCurrentUser: async () => ({
        id: userId,
        email: 'member@gmail.com',
        phoneE164: '+14155550123',
      }),
    } as unknown as AuthService;
    const repository = { findTenantIdByUserId: async () => null } as unknown as AuthRepository;
    const guard = new AuthenticatedTenantGuard(auth, repository);
    const executionContext = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(executionContext)).rejects.toMatchObject({ status: 401 });
  });

  it('wraps authenticated HTTP handlers in their resolved tenant transaction', async () => {
    const { prisma, settings, transactionClient } = createPrismaStub();
    const interceptor = new TenantContextInterceptor(prisma);
    const request = {
      tenantContext: {
        tenantId,
        userId,
        sessionId: '9f5d5200-3309-45ba-859f-5d2bb15ea0f7',
        user: { id: userId, email: 'member@gmail.com', phoneE164: '+14155550123' },
      },
    } as TenantContextRequest;
    const executionContext = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    const handler = {
      handle: () => of(requireTenantTransactionClient()),
    } as CallHandler<TransactionClient>;

    const result = await lastValueFrom(interceptor.intercept(executionContext, handler));

    expect(result).toBe(transactionClient);
    expect(settings).toEqual([
      { name: 'app.tenant_id', value: tenantId, isLocal: true },
      { name: 'app.user_id', value: userId, isLocal: true },
      { name: 'app.webhook_path_id', value: '', isLocal: true },
      { name: 'app.context', value: '', isLocal: true },
    ]);
  });
});

describe('TenantPrismaClient proxy', () => {
  function createProxiedPrismaStub() {
    const stub = createPrismaStub();
    // Add model-like delegates to the stub so the proxy can detect them
    const prismaWithModels = {
      ...stub.prisma,
      user: { findMany: async () => [] },
      tenant: { findMany: async () => [] },
      workflow: { findMany: async () => [] },
    } as unknown as PrismaClient;
    const proxied = createTenantPrismaClient(prismaWithModels);
    return { ...stub, prisma: prismaWithModels, proxied };
  }

  it('blocks model access outside any RLS scope', () => {
    const { proxied } = createProxiedPrismaStub();
    expect(() => (proxied as unknown as Record<string, unknown>)['user']).toThrow(
      'PrismaClient model access (".user") outside an RLS scope',
    );
    expect(() => (proxied as unknown as Record<string, unknown>)['tenant']).toThrow(
      'outside an RLS scope',
    );
    expect(() => (proxied as unknown as Record<string, unknown>)['workflow']).toThrow(
      'outside an RLS scope',
    );
  });

  it('allows meta methods ($connect, $disconnect, $transaction) through the proxy', () => {
    const { proxied } = createProxiedPrismaStub();
    expect(typeof proxied.$transaction).toBe('function');
  });

  it('exposes __tenantSafe marker', () => {
    const { proxied } = createProxiedPrismaStub();
    expect(proxied.__tenantSafe).toBe(true);
  });

  it('allows model access inside a tenant scope callback', async () => {
    const { proxied } = createProxiedPrismaStub();
    // The withTenantScope will set the AsyncLocalStorage, so inner access
    // on the proxy should not throw. The actual model access happens on
    // the transaction client (tx), not the proxy.
    const result = await withTenantScope(
      proxied,
      { tenantId, userId },
      async () => requireTenantTransactionClient(),
    );
    expect(result).toBeDefined();
  });

  it('rejects tenantId that is not a valid UUID', async () => {
    const { proxied } = createProxiedPrismaStub();
    await expect(
      withTenantScope(proxied, { tenantId: 'not-a-uuid' }, async () => 'ok'),
    ).rejects.toThrow('tenantId must be a UUID');
  });

  it('rejects userId that is not a valid UUID', async () => {
    const { proxied } = createProxiedPrismaStub();
    await expect(
      withTenantScope(proxied, { tenantId, userId: 'not-a-uuid' }, async () => 'ok'),
    ).rejects.toThrow('userId must be a UUID');
  });
});
