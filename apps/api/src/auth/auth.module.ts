import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaClient, createTenantPrismaClient } from '@chatmaster/db';
import { loadApiEnvironment } from '../env.js';
import { AuthController } from './auth.controller.js';
import { ConsoleEmailProvider, ConsoleSmsProvider } from './auth.providers.js';
import { RedisAuthRateLimiter } from './auth.rate-limit.js';
import { AuthService } from './auth.service.js';
import { CsrfGuard } from './auth.security.js';
import { AuthenticatedTenantGuard } from './authenticated-tenant.guard.js';
import { TenantContextInterceptor } from './tenant-context.interceptor.js';
import {
  AUTH_EMAIL_PROVIDER,
  AUTH_RATE_LIMITER,
  AUTH_REPOSITORY,
  AUTH_SERVICE,
  AUTH_SMS_PROVIDER,
} from './auth.tokens.js';
import { PrismaAuthRepository } from './prisma-auth.repository.js';

@Module({
  controllers: [AuthController],
  providers: [
    {
      provide: PrismaClient,
      useFactory: () => createTenantPrismaClient(new PrismaClient()),
    },
    ConsoleEmailProvider,
    ConsoleSmsProvider,
    RedisAuthRateLimiter,
    {
      provide: AUTH_REPOSITORY,
      useFactory: (prisma: PrismaClient) => new PrismaAuthRepository(prisma),
      inject: [PrismaClient],
    },
    { provide: AUTH_RATE_LIMITER, useExisting: RedisAuthRateLimiter },
    { provide: AUTH_EMAIL_PROVIDER, useExisting: ConsoleEmailProvider },
    { provide: AUTH_SMS_PROVIDER, useExisting: ConsoleSmsProvider },
    {
      provide: AUTH_SERVICE,
      useFactory: (
        repository: PrismaAuthRepository,
        rateLimiter: RedisAuthRateLimiter,
        smsProvider: ConsoleSmsProvider,
        emailProvider: ConsoleEmailProvider,
      ) => {
        const env = loadApiEnvironment();
        return new AuthService(repository, rateLimiter, smsProvider, emailProvider, {
          jwtSecret: env.AUTH_JWT_SECRET,
          issuer: env.AUTH_TOKEN_ISSUER,
          audience: env.AUTH_TOKEN_AUDIENCE,
          webAppUrl: env.WEB_APP_URL,
        });
      },
      inject: [AUTH_REPOSITORY, AUTH_RATE_LIMITER, AUTH_SMS_PROVIDER, AUTH_EMAIL_PROVIDER],
    },
    {
      provide: APP_GUARD,
      useFactory: () => new CsrfGuard(loadApiEnvironment().AUTH_JWT_SECRET),
    },
    AuthenticatedTenantGuard,
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
  ],
  // Feature modules reuse the tenant guard; its dependencies must be visible to them.
  exports: [AuthenticatedTenantGuard, AUTH_SERVICE, AUTH_REPOSITORY, PrismaClient],
})
export class AuthModule {}

export { AUTH_SERVICE };
