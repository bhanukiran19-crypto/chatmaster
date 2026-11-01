import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { accessCookieSchema } from './auth.validation.js';
import type { AuthRepository } from './auth.contracts.js';
import { AuthService } from './auth.service.js';
import { ACCESS_COOKIE_NAME } from './auth.security.js';
import { AUTH_REPOSITORY, AUTH_SERVICE } from './auth.tokens.js';
import type { AuthenticatedTenantContext, TenantContextRequest } from './tenant-auth-context.js';

@Injectable()
export class AuthenticatedTenantGuard implements CanActivate {
  constructor(
    @Inject(AUTH_SERVICE) private readonly auth: AuthService,
    @Inject(AUTH_REPOSITORY) private readonly repository: AuthRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & TenantContextRequest>();
    const parsedAccessToken = accessCookieSchema.safeParse(request.cookies?.[ACCESS_COOKIE_NAME]);
    if (!parsedAccessToken.success) throw new UnauthorizedException('Session is missing');

    const claims = await this.auth.authenticateAccessToken(parsedAccessToken.data);
    const [tenantId, user] = await Promise.all([
      this.repository.findTenantIdByUserId(claims.userId),
      this.auth.getCurrentUser(claims.userId),
    ]);
    if (!tenantId) throw new UnauthorizedException('A tenant is required for this session');

    const authenticatedTenant: AuthenticatedTenantContext = {
      userId: claims.userId,
      sessionId: claims.sessionId,
      tenantId,
      user,
    };
    request.tenantContext = authenticatedTenant;
    return true;
  }
}
