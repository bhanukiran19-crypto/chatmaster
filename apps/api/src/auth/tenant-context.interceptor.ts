import { Injectable } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { PrismaClient, withTenantScope } from '@chatmaster/db';
import type { Observable } from 'rxjs';
import { defer, from, lastValueFrom } from 'rxjs';
import type { TenantContextRequest } from './tenant-auth-context.js';

/**
 * Upper bound for a request-scoped tenant transaction. Platform connect flows
 * make up to two bounded third-party calls (each capped by its own timeout), so
 * this must exceed their sum while staying short enough to bound connection use.
 */
const REQUEST_TRANSACTION_TIMEOUT_MS = 30_000;

@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaClient) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<TenantContextRequest>();
    const tenant = request.tenantContext;
    if (!tenant) return next.handle();

    return defer(() =>
      from(
        withTenantScope(
          this.prisma,
          { tenantId: tenant.tenantId, userId: tenant.userId },
          () => lastValueFrom(next.handle(), { defaultValue: undefined }),
          { timeoutMs: REQUEST_TRANSACTION_TIMEOUT_MS },
        ),
      ),
    );
  }
}
