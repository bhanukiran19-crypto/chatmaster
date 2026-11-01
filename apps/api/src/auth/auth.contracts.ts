import type { VerificationChannel, VerificationPurpose } from '@chatmaster/db';

export type AuthUser = {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
  phoneE164: string;
  phoneVerifiedAt: Date | null;
  passwordHash: string;
  status: 'PENDING_VERIFICATION' | 'ACTIVE' | 'LOCKED' | 'DISABLED';
  failedLoginCount: number;
  lockedUntil: Date | null;
};

export type AuthCode = {
  id: string;
  userId: string;
  channel: VerificationChannel;
  purpose: VerificationPurpose;
  target: string;
  codeHash: string;
  attempts: number;
  maxAttempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
};

export type AuditEvent = {
  action: string;
  actorUserId?: string;
  entityId?: string;
  metadata?: Record<string, string | number | boolean | null>;
  ipAddress?: string;
  userAgent?: string;
};

export type NewCode = {
  channel: VerificationChannel;
  purpose: VerificationPurpose;
  target: string;
  codeHash: string;
  expiresAt: Date;
};

export type NewSession = {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  ipAddress?: string;
  userAgent?: string;
};

export type RotateResult =
  | { status: 'rotated'; sessionId: string; user: AuthUser }
  | { status: 'reused' }
  | { status: 'invalid' };

export interface AuthRepository {
  createPendingUser(input: {
    email: string;
    phoneE164: string;
    passwordHash: string;
    emailCode: NewCode;
    phoneCode: NewCode;
    audit: AuditEvent;
  }): Promise<AuthUser>;
  findUserByIdentifier(identifier: string): Promise<AuthUser | null>;
  findUserById(userId: string): Promise<AuthUser | null>;
  findTenantIdByUserId(userId: string): Promise<string | null>;
  findUserByEmail(email: string): Promise<AuthUser | null>;
  findCode(
    channel: VerificationChannel,
    purpose: VerificationPurpose,
    target: string,
  ): Promise<AuthCode | null>;
  findCodeByHash(
    channel: VerificationChannel,
    purpose: VerificationPurpose,
    codeHash: string,
  ): Promise<AuthCode | null>;
  incrementCodeAttempt(codeId: string): Promise<void>;
  completeVerification(input: {
    userId: string;
    codeId: string;
    channel: VerificationChannel;
    now: Date;
    audit: AuditEvent;
  }): Promise<boolean>;
  createCode(userId: string, code: NewCode, audit: AuditEvent): Promise<void>;
  resetPassword(input: {
    userId: string;
    codeId: string;
    passwordHash: string;
    now: Date;
    audit: AuditEvent;
  }): Promise<boolean>;
  recordLoginFailure(
    userId: string,
    now: Date,
    threshold: number,
    lockMs: number,
    audit: AuditEvent,
  ): Promise<number>;
  clearLoginFailures(userId: string, audit: AuditEvent): Promise<void>;
  createSession(input: NewSession, now: Date): Promise<string>;
  rotateRefreshToken(input: {
    tokenHash: string;
    replacementHash: string;
    replacementExpiresAt: Date;
    now: Date;
    audit: AuditEvent;
  }): Promise<RotateResult>;
  isSessionActive(sessionId: string, userId: string, now: Date): Promise<boolean>;
  revokeSession(
    sessionId: string,
    userId: string,
    now: Date,
    reason: string,
    audit: AuditEvent,
  ): Promise<void>;
  revokeByRefreshToken(tokenHash: string, now: Date, audit: AuditEvent): Promise<void>;
  audit(event: AuditEvent): Promise<void>;
}

export interface AuthRateLimiter {
  consume(action: string, ip: string, subject?: string): Promise<boolean>;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

export interface SmsProvider {
  sendOtp(phoneE164: string, otp: string): Promise<void>;
}

export interface EmailProvider {
  sendVerificationLink(email: string, link: string): Promise<void>;
  sendPasswordResetLink(email: string, link: string): Promise<void>;
}

export type AuthRequestContext = {
  ipAddress?: string;
  userAgent?: string;
};

export type AuthSession = {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  sessionId: string;
  user: Pick<AuthUser, 'id' | 'email' | 'phoneE164'>;
};
