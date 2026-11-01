import { randomInt } from 'node:crypto';
import argon2 from 'argon2';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { generateOpaqueToken, sha256Hex } from '@chatmaster/crypto';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import type {
  AuthRateLimiter,
  AuthRepository,
  AuthRequestContext,
  AuthSession,
  AuthUser,
  EmailProvider,
  PasswordHasher,
  SmsProvider,
} from './auth.contracts.js';
import { makeCsrfToken } from './auth.security.js';

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const EMAIL_CODE_TTL_MS = 30 * 60 * 1000;
const SMS_CODE_TTL_MS = 10 * 60 * 1000;
const RESET_CODE_TTL_MS = 20 * 60 * 1000;
const DUMMY_PASSWORD = 'chatmaster-unusable-dummy-password';
const accessClaimsSchema = z.object({ sub: z.string().uuid(), sid: z.string().uuid() });

export type AuthConfig = {
  jwtSecret: string;
  issuer: string;
  audience: string;
  webAppUrl: string;
  accessTtlSeconds?: number;
  refreshTtlMs?: number;
};

type AccessClaims = { userId: string; sessionId: string };

export class Argon2idPasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

function normalizeIdentifier(value: string): string {
  const identifier = value.trim();
  return identifier.includes('@') ? identifier.toLowerCase() : identifier;
}

function publicUser(user: AuthUser): AuthSession['user'] {
  return { id: user.id, email: user.email, phoneE164: user.phoneE164 };
}

export class AuthService {
  private readonly secret: Uint8Array;
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlMs: number;
  private dummyHashPromise: Promise<string> | undefined;

  constructor(
    private readonly repository: AuthRepository,
    private readonly rateLimiter: AuthRateLimiter,
    private readonly smsProvider: SmsProvider,
    private readonly emailProvider: EmailProvider,
    private readonly config: AuthConfig,
    private readonly passwordHasher: PasswordHasher = new Argon2idPasswordHasher(),
    private readonly now: () => Date = () => new Date(),
  ) {
    if (Buffer.byteLength(config.jwtSecret, 'utf8') < 32) {
      throw new Error('AUTH_JWT_SECRET must contain at least 32 bytes');
    }
    this.secret = new TextEncoder().encode(config.jwtSecret);
    this.accessTtlSeconds = config.accessTtlSeconds ?? ACCESS_TTL_SECONDS;
    this.refreshTtlMs = config.refreshTtlMs ?? REFRESH_TTL_MS;
  }

  createCsrfToken(): string {
    return makeCsrfToken(this.config.jwtSecret);
  }

  async signup(
    input: { email: string; mobile: string; password: string },
    context: AuthRequestContext,
  ): Promise<void> {
    await this.enforceLimit('signup', context, `${input.email}:${input.mobile}`);
    const emailToken = generateOpaqueToken();
    const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const now = this.now();
    const passwordHash = await this.passwordHasher.hash(input.password);
    const otpHash = await this.passwordHasher.hash(otp);

    let user: AuthUser;
    try {
      user = await this.repository.createPendingUser({
        email: input.email.toLowerCase(),
        phoneE164: input.mobile,
        passwordHash,
        emailCode: {
          channel: 'EMAIL',
          purpose: 'EMAIL_VERIFY',
          target: input.email.toLowerCase(),
          codeHash: sha256Hex(emailToken),
          expiresAt: new Date(now.getTime() + EMAIL_CODE_TTL_MS),
        },
        phoneCode: {
          channel: 'SMS',
          purpose: 'PHONE_VERIFY',
          target: input.mobile,
          codeHash: otpHash,
          expiresAt: new Date(now.getTime() + SMS_CODE_TTL_MS),
        },
        audit: this.auditEvent('auth.signup.created', context, { emailDomain: 'gmail.com' }),
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        await this.repository.audit(this.auditEvent('auth.signup.duplicate', context));
        return;
      }
      throw error;
    }

    const verificationUrl = new URL('/verify-email', this.config.webAppUrl);
    verificationUrl.searchParams.set('token', emailToken);
    await Promise.all([
      this.emailProvider.sendVerificationLink(user.email, verificationUrl.toString()),
      this.smsProvider.sendOtp(user.phoneE164, otp),
    ]);
  }

  async verifyEmail(token: string, context: AuthRequestContext): Promise<void> {
    await this.enforceLimit('verifyEmail', context);
    const now = this.now();
    const code = await this.repository.findCodeByHash('EMAIL', 'EMAIL_VERIFY', sha256Hex(token));
    if (!code || code.expiresAt <= now || code.attempts >= code.maxAttempts) {
      await this.repository.audit(this.auditEvent('auth.email_verification.failed', context));
      throw new BadRequestException('Verification link is invalid or expired');
    }
    const completed = await this.repository.completeVerification({
      userId: code.userId,
      codeId: code.id,
      channel: 'EMAIL',
      now,
      audit: this.auditEvent('auth.email_verification.succeeded', context),
    });
    if (!completed) throw new BadRequestException('Verification link is invalid or expired');
  }

  async verifyMobile(mobile: string, otp: string, context: AuthRequestContext): Promise<void> {
    await this.enforceLimit('verifyMobile', context, mobile);
    const now = this.now();
    const code = await this.repository.findCode('SMS', 'PHONE_VERIFY', mobile);
    if (!code || code.expiresAt <= now || code.attempts >= code.maxAttempts) {
      await this.repository.audit(this.auditEvent('auth.mobile_verification.failed', context));
      throw new BadRequestException('Verification code is invalid or expired');
    }
    if (!(await this.passwordHasher.verify(code.codeHash, otp))) {
      await this.repository.incrementCodeAttempt(code.id);
      await this.repository.audit(
        this.auditEvent('auth.mobile_verification.failed', context, { userId: code.userId }),
      );
      throw new BadRequestException('Verification code is invalid or expired');
    }
    const completed = await this.repository.completeVerification({
      userId: code.userId,
      codeId: code.id,
      channel: 'SMS',
      now,
      audit: this.auditEvent('auth.mobile_verification.succeeded', context),
    });
    if (!completed) throw new BadRequestException('Verification code is invalid or expired');
  }

  async login(
    identifier: string,
    password: string,
    context: AuthRequestContext,
  ): Promise<AuthSession> {
    const normalized = normalizeIdentifier(identifier);
    await this.enforceLimit('login', context, normalized);
    const user = await this.repository.findUserByIdentifier(normalized);
    const passwordMatches = await this.passwordHasher.verify(
      user?.passwordHash ?? (await this.getDummyHash()),
      password,
    );
    const now = this.now();
    const locked = Boolean(user?.lockedUntil && user.lockedUntil > now);
    const verified = Boolean(user?.emailVerifiedAt && user.phoneVerifiedAt);
    const allowed = Boolean(
      user && user.status !== 'DISABLED' && !locked && verified && passwordMatches,
    );

    if (!allowed || !user) {
      if (user && user.status !== 'DISABLED') {
        await this.repository.recordLoginFailure(
          user.id,
          now,
          LOGIN_FAILURE_LIMIT,
          LOCKOUT_MS,
          this.auditEvent('auth.login.failed', context),
        );
      } else {
        await this.repository.audit(
          this.auditEvent('auth.login.failed', context, user ? { userId: user.id } : undefined),
        );
      }
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.repository.clearLoginFailures(
      user.id,
      this.auditEvent('auth.login.failures_reset', context),
    );
    return this.issueSession(user, context, now);
  }

  async requestPasswordReset(email: string, context: AuthRequestContext): Promise<void> {
    await this.enforceLimit('requestPasswordReset', context, email);
    const user = await this.repository.findUserByEmail(email.toLowerCase());
    if (!user || user.status !== 'ACTIVE' || !user.emailVerifiedAt) return;

    const token = generateOpaqueToken();
    const now = this.now();
    await this.repository.createCode(
      user.id,
      {
        channel: 'EMAIL',
        purpose: 'PASSWORD_RESET',
        target: user.email,
        codeHash: sha256Hex(token),
        expiresAt: new Date(now.getTime() + RESET_CODE_TTL_MS),
      },
      this.auditEvent('auth.password_reset.requested', context, { userId: user.id }),
    );
    const resetUrl = new URL('/reset-password', this.config.webAppUrl);
    resetUrl.searchParams.set('token', token);
    await this.emailProvider.sendPasswordResetLink(user.email, resetUrl.toString());
  }

  async resetPassword(token: string, password: string, context: AuthRequestContext): Promise<void> {
    await this.enforceLimit('resetPassword', context);
    const now = this.now();
    const code = await this.repository.findCodeByHash('EMAIL', 'PASSWORD_RESET', sha256Hex(token));
    if (!code || code.expiresAt <= now || code.attempts >= code.maxAttempts) {
      await this.repository.audit(this.auditEvent('auth.password_reset.failed', context));
      throw new BadRequestException('Password reset link is invalid or expired');
    }
    const passwordHash = await this.passwordHasher.hash(password);
    const reset = await this.repository.resetPassword({
      userId: code.userId,
      codeId: code.id,
      passwordHash,
      now,
      audit: this.auditEvent('auth.password_reset.completed', context),
    });
    if (!reset) throw new BadRequestException('Password reset link is invalid or expired');
  }

  async refresh(refreshToken: string, context: AuthRequestContext): Promise<AuthSession> {
    await this.enforceLimit('refresh', context, sha256Hex(refreshToken));
    const now = this.now();
    const nextRefreshToken = generateOpaqueToken();
    const result = await this.repository.rotateRefreshToken({
      tokenHash: sha256Hex(refreshToken),
      replacementHash: sha256Hex(nextRefreshToken),
      replacementExpiresAt: new Date(now.getTime() + this.refreshTtlMs),
      now,
      audit: this.auditEvent('auth.refresh.rotated', context),
    });
    if (result.status === 'reused') {
      throw new UnauthorizedException('Refresh token reuse detected; session revoked');
    }
    if (result.status !== 'rotated') {
      await this.repository.audit(this.auditEvent('auth.refresh.failed', context));
      throw new UnauthorizedException('Refresh token is invalid or expired');
    }
    const accessToken = await this.createAccessToken(result.user.id, result.sessionId, now);
    return {
      accessToken,
      refreshToken: nextRefreshToken,
      csrfToken: this.createCsrfToken(),
      sessionId: result.sessionId,
      user: publicUser(result.user),
    };
  }

  async authenticateAccessToken(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: ['HS256'],
      });
      const claims = accessClaimsSchema.parse({ sub: payload.sub, sid: payload['sid'] });
      if (!(await this.repository.isSessionActive(claims.sid, claims.sub, this.now()))) {
        throw new Error('Inactive session');
      }
      return { userId: claims.sub, sessionId: claims.sid };
    } catch {
      throw new UnauthorizedException('Session is invalid or expired');
    }
  }

  async getCurrentUser(userId: string): Promise<AuthSession['user']> {
    const user = await this.repository.findUserById(userId);
    if (!user || user.id !== userId || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Session is invalid or expired');
    }
    return publicUser(user);
  }

  async logout(refreshToken: string | undefined, context: AuthRequestContext): Promise<void> {
    if (!refreshToken) return;
    await this.repository.revokeByRefreshToken(
      sha256Hex(refreshToken),
      this.now(),
      this.auditEvent('auth.logout', context),
    );
  }

  private async issueSession(
    user: AuthUser,
    context: AuthRequestContext,
    now: Date,
  ): Promise<AuthSession> {
    const refreshToken = generateOpaqueToken();
    const expiresAt = new Date(now.getTime() + this.refreshTtlMs);
    const sessionId = await this.repository.createSession(
      {
        userId: user.id,
        tokenHash: sha256Hex(refreshToken),
        expiresAt,
        ...(context.ipAddress ? { ipAddress: context.ipAddress } : {}),
        ...(context.userAgent ? { userAgent: context.userAgent } : {}),
      },
      now,
    );
    return {
      accessToken: await this.createAccessToken(user.id, sessionId, now),
      refreshToken,
      csrfToken: this.createCsrfToken(),
      sessionId,
      user: publicUser(user),
    };
  }

  private async createAccessToken(userId: string, sessionId: string, now: Date): Promise<string> {
    return new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(this.config.issuer)
      .setAudience(this.config.audience)
      .setSubject(userId)
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor(now.getTime() / 1000) + this.accessTtlSeconds)
      .sign(this.secret);
  }

  private async enforceLimit(
    action: string,
    context: AuthRequestContext,
    subject = '',
  ): Promise<void> {
    const allowed = await this.rateLimiter.consume(action, context.ipAddress ?? 'unknown', subject);
    if (!allowed)
      throw new HttpException('Too many authentication attempts', HttpStatus.TOO_MANY_REQUESTS);
  }

  private auditEvent(
    action: string,
    context: AuthRequestContext,
    metadata?: Record<string, string | number | boolean | null>,
  ) {
    const { userId, ...safeMetadata } = metadata ?? {};
    const actorUserId = typeof userId === 'string' ? userId : undefined;
    return {
      action,
      ...(actorUserId ? { actorUserId } : {}),
      ...(Object.keys(safeMetadata).length ? { metadata: safeMetadata } : {}),
      ...(context.ipAddress ? { ipAddress: context.ipAddress } : {}),
      ...(context.userAgent ? { userAgent: context.userAgent } : {}),
    };
  }

  private async getDummyHash(): Promise<string> {
    this.dummyHashPromise ??= this.passwordHasher.hash(DUMMY_PASSWORD);
    return this.dummyHashPromise;
  }
}
