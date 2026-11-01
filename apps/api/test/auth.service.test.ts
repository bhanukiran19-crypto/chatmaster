import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@chatmaster/crypto';
import type {
  AuthCode,
  AuthRepository,
  AuthUser,
  AuditEvent,
  EmailProvider,
  NewCode,
  SmsProvider,
  NewSession,
  RotateResult,
} from '../src/auth/auth.contracts.js';
import { AuthService } from '../src/auth/auth.service.js';

const fixedNow = new Date('2026-10-29T12:00:00.000Z');
const testUser: AuthUser = {
  id: 'dd76418e-706d-438e-97a4-c0ec870edb5f',
  email: 'member@gmail.com',
  emailVerifiedAt: fixedNow,
  phoneE164: '+14155550123',
  phoneVerifiedAt: fixedNow,
  passwordHash: 'hash:correct-password',
  status: 'ACTIVE',
  failedLoginCount: 0,
  lockedUntil: null,
};

class MemoryAuthRepository implements AuthRepository {
  user: AuthUser = { ...testUser };
  readonly tokens = new Map<string, { used: boolean }>();
  readonly codes: AuthCode[] = [];
  sessionRevoked = false;
  auditEvents: AuditEvent[] = [];
  sessionId = '9d4ba531-cb56-4387-baf4-c1b256683692';

  async createPendingUser(input: {
    email: string;
    phoneE164: string;
    passwordHash: string;
    emailCode: NewCode;
    phoneCode: NewCode;
    audit: AuditEvent;
  }): Promise<AuthUser> {
    this.user.email = input.email;
    this.user.phoneE164 = input.phoneE164;
    this.user.passwordHash = input.passwordHash;
    this.user.emailVerifiedAt = null;
    this.user.phoneVerifiedAt = null;
    this.user.status = 'PENDING_VERIFICATION';
    this.codes.push(this.toCode(input.emailCode), this.toCode(input.phoneCode));
    this.auditEvents.push(input.audit);
    return this.user;
  }

  async findUserByIdentifier(identifier: string): Promise<AuthUser | null> {
    return identifier.includes('@')
      ? this.findUserByEmail(identifier)
      : identifier === this.user.phoneE164
        ? this.user
        : null;
  }

  async findUserById(userId: string): Promise<AuthUser | null> {
    return userId === this.user.id ? this.user : null;
  }

  async findTenantIdByUserId(userId: string): Promise<string | null> {
    return userId === this.user.id ? '1763ef96-a0ab-47d9-a086-72f6f7bf4f08' : null;
  }

  async findUserByEmail(email: string): Promise<AuthUser | null> {
    return email === this.user.email ? this.user : null;
  }

  async findCode(
    channel: AuthCode['channel'],
    purpose: AuthCode['purpose'],
    target: string,
  ): Promise<AuthCode | null> {
    return (
      this.codes.find(
        (code) =>
          code.channel === channel &&
          code.purpose === purpose &&
          code.target === target &&
          !code.consumedAt,
      ) ?? null
    );
  }

  async findCodeByHash(
    channel: AuthCode['channel'],
    purpose: AuthCode['purpose'],
    codeHash: string,
  ): Promise<AuthCode | null> {
    return (
      this.codes.find(
        (code) =>
          code.channel === channel &&
          code.purpose === purpose &&
          code.codeHash === codeHash &&
          !code.consumedAt,
      ) ?? null
    );
  }

  async incrementCodeAttempt(codeId: string): Promise<void> {
    const code = this.codes.find((candidate) => candidate.id === codeId);
    if (code) code.attempts += 1;
  }

  async completeVerification(input: {
    userId: string;
    codeId: string;
    channel: AuthCode['channel'];
    now: Date;
    audit: AuditEvent;
  }): Promise<boolean> {
    const code = this.codes.find(
      (candidate) =>
        candidate.id === input.codeId &&
        candidate.userId === input.userId &&
        candidate.channel === input.channel &&
        !candidate.consumedAt,
    );
    if (!code || code.expiresAt <= input.now || code.attempts >= code.maxAttempts) return false;
    code.consumedAt = input.now;
    if (input.channel === 'EMAIL') this.user.emailVerifiedAt = input.now;
    else this.user.phoneVerifiedAt = input.now;
    if (this.user.emailVerifiedAt && this.user.phoneVerifiedAt) this.user.status = 'ACTIVE';
    this.auditEvents.push(input.audit);
    return true;
  }

  async createCode(userId: string, code: NewCode, audit: AuditEvent): Promise<void> {
    for (const current of this.codes) {
      if (
        current.userId === userId &&
        current.channel === code.channel &&
        current.purpose === code.purpose
      ) {
        current.consumedAt = fixedNow;
      }
    }
    this.codes.push(this.toCode(code, userId));
    this.auditEvents.push(audit);
  }

  async resetPassword(input: {
    userId: string;
    codeId: string;
    passwordHash: string;
    now: Date;
    audit: AuditEvent;
  }): Promise<boolean> {
    const code = this.codes.find(
      (candidate) =>
        candidate.id === input.codeId && candidate.userId === input.userId && !candidate.consumedAt,
    );
    if (
      !code ||
      code.expiresAt <= input.now ||
      code.attempts >= code.maxAttempts ||
      this.user.status === 'DISABLED'
    )
      return false;
    code.consumedAt = input.now;
    this.user.passwordHash = input.passwordHash;
    this.user.failedLoginCount = 0;
    this.user.lockedUntil = null;
    this.user.status = 'ACTIVE';
    this.sessionRevoked = true;
    this.auditEvents.push(input.audit);
    return true;
  }

  private toCode(code: NewCode, userId = this.user.id): AuthCode {
    return {
      id: randomUUID(),
      userId,
      ...code,
      attempts: 0,
      maxAttempts: 5,
      consumedAt: null,
    };
  }

  async recordLoginFailure(
    userId: string,
    now: Date,
    threshold: number,
    lockMs: number,
    audit: AuditEvent,
  ): Promise<number> {
    if (userId !== this.user.id) throw new Error('Unexpected user scope');
    this.user.failedLoginCount += 1;
    if (this.user.failedLoginCount >= threshold) {
      this.user.status = 'LOCKED';
      this.user.lockedUntil = new Date(now.getTime() + lockMs);
    }
    this.auditEvents.push(audit);
    return this.user.failedLoginCount;
  }

  async clearLoginFailures(_userId: string, audit: AuditEvent): Promise<void> {
    this.user.failedLoginCount = 0;
    this.user.lockedUntil = null;
    this.user.status = 'ACTIVE';
    this.auditEvents.push(audit);
  }

  async createSession(input: NewSession): Promise<string> {
    this.tokens.set(input.tokenHash, { used: false });
    return this.sessionId;
  }

  async rotateRefreshToken(input: {
    tokenHash: string;
    replacementHash: string;
    replacementExpiresAt: Date;
    now: Date;
    audit: AuditEvent;
  }): Promise<RotateResult> {
    const token = this.tokens.get(input.tokenHash);
    if (!token) return { status: 'invalid' };
    if (token.used) {
      this.sessionRevoked = true;
      this.auditEvents.push(input.audit);
      return { status: 'reused' };
    }
    if (this.sessionRevoked) return { status: 'invalid' };
    token.used = true;
    this.tokens.set(input.replacementHash, { used: false });
    this.auditEvents.push(input.audit);
    return { status: 'rotated', sessionId: this.sessionId, user: this.user };
  }

  async isSessionActive(): Promise<boolean> {
    return !this.sessionRevoked;
  }
  async revokeSession(): Promise<void> {
    this.sessionRevoked = true;
  }
  async revokeByRefreshToken(): Promise<void> {
    this.sessionRevoked = true;
  }
  async audit(event: AuditEvent): Promise<void> {
    this.auditEvents.push(event);
  }
}

function makeService(
  repository: MemoryAuthRepository,
  smsProvider: SmsProvider = { sendOtp: async () => undefined },
  emailProvider: EmailProvider = {
    sendVerificationLink: async () => undefined,
    sendPasswordResetLink: async () => undefined,
  },
): AuthService {
  return new AuthService(
    repository,
    { consume: async () => true },
    smsProvider,
    emailProvider,
    {
      jwtSecret: 'test-only-secret-material-with-at-least-thirty-two-bytes',
      issuer: 'chatmaster-test',
      audience: 'chatmaster-test-web',
      webAppUrl: 'https://test.example',
    },
    {
      hash: async (value) => `hash:${value}`,
      verify: async (hash, value) => hash === `hash:${value}`,
    },
    () => fixedNow,
  );
}

describe('AuthService security flows', () => {
  it('requires both email and mobile verification before activating signup', async () => {
    const repository = new MemoryAuthRepository();
    let verificationLink = '';
    let deliveredMobile = '';
    let deliveredOtp = '';
    const service = makeService(
      repository,
      {
        sendOtp: async (mobile, otp) => {
          deliveredMobile = mobile;
          deliveredOtp = otp;
        },
      },
      {
        sendVerificationLink: async (_email, link) => {
          verificationLink = link;
        },
        sendPasswordResetLink: async () => undefined,
      },
    );

    await service.signup(
      { email: 'new.member@gmail.com', mobile: '+14155550124', password: 'long-password' },
      { ipAddress: '127.0.0.1' },
    );
    const emailToken = new URL(verificationLink).searchParams.get('token');
    expect(emailToken).toBeTruthy();
    expect(repository.codes.find((code) => code.purpose === 'EMAIL_VERIFY')?.codeHash).toBe(
      sha256Hex(emailToken ?? ''),
    );
    expect(repository.codes.find((code) => code.purpose === 'PHONE_VERIFY')?.codeHash).toBe(
      `hash:${deliveredOtp}`,
    );

    await service.verifyEmail(emailToken ?? '', { ipAddress: '127.0.0.1' });
    expect(repository.user.status).toBe('PENDING_VERIFICATION');
    await service.verifyMobile(deliveredMobile, deliveredOtp, { ipAddress: '127.0.0.1' });
    expect(repository.user.status).toBe('ACTIVE');
    expect(repository.user.emailVerifiedAt).toEqual(fixedNow);
    expect(repository.user.phoneVerifiedAt).toEqual(fixedNow);
  });

  it('consumes a hashed password-reset token and revokes sessions', async () => {
    const repository = new MemoryAuthRepository();
    const service = makeService(repository);
    const token = 'opaque-reset-token-for-unit-test-only';
    repository.codes.push({
      id: randomUUID(),
      userId: repository.user.id,
      channel: 'EMAIL',
      purpose: 'PASSWORD_RESET',
      target: repository.user.email,
      codeHash: sha256Hex(token),
      attempts: 0,
      maxAttempts: 5,
      expiresAt: new Date(fixedNow.getTime() + 60_000),
      consumedAt: null,
    });

    await service.resetPassword(token, 'new-long-password', { ipAddress: '127.0.0.1' });
    expect(repository.user.passwordHash).toBe('hash:new-long-password');
    expect(repository.sessionRevoked).toBe(true);
    expect(repository.codes[0]?.consumedAt).toEqual(fixedNow);
  });

  it('locks the account after repeated wrong passwords', async () => {
    const repository = new MemoryAuthRepository();
    const service = makeService(repository);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        service.login(repository.user.email, 'wrong-password', { ipAddress: '127.0.0.1' }),
      ).rejects.toMatchObject({ status: 401 });
    }

    expect(repository.user.failedLoginCount).toBe(5);
    expect(repository.user.status).toBe('LOCKED');
    expect(repository.user.lockedUntil?.getTime()).toBe(fixedNow.getTime() + 15 * 60 * 1000);
    await expect(
      service.login(repository.user.email, 'correct-password', { ipAddress: '127.0.0.1' }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('does not reactivate disabled accounts during login attempts', async () => {
    const repository = new MemoryAuthRepository();
    repository.user.status = 'DISABLED';
    const service = makeService(repository);

    await expect(
      service.login(repository.user.email, 'correct-password', { ipAddress: '127.0.0.1' }),
    ).rejects.toMatchObject({ status: 401 });
    expect(repository.user.status).toBe('DISABLED');
    expect(repository.user.failedLoginCount).toBe(0);
  });

  it('rotates refresh tokens and revokes the session when a used token is replayed', async () => {
    const repository = new MemoryAuthRepository();
    const service = makeService(repository);
    const initial = await service.login(repository.user.phoneE164, 'correct-password', {
      ipAddress: '127.0.0.1',
    });

    expect(repository.tokens.has(sha256Hex(initial.refreshToken))).toBe(true);
    expect(repository.tokens.has(initial.refreshToken)).toBe(false);

    const rotated = await service.refresh(initial.refreshToken, { ipAddress: '127.0.0.1' });
    expect(rotated.refreshToken).not.toBe(initial.refreshToken);
    expect(repository.tokens.get(sha256Hex(initial.refreshToken))?.used).toBe(true);

    await expect(
      service.refresh(initial.refreshToken, { ipAddress: '127.0.0.1' }),
    ).rejects.toMatchObject({ status: 401 });
    expect(repository.sessionRevoked).toBe(true);
    await expect(service.authenticateAccessToken(rotated.accessToken)).rejects.toMatchObject({
      status: 401,
    });
  });
});
