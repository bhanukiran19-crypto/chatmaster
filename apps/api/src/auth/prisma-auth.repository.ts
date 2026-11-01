import type { OnModuleDestroy } from '@nestjs/common';
import {
  Prisma,
  type PrismaClient,
  type TransactionClient,
  withAuthScope,
  type User,
  type VerificationCode,
} from '@chatmaster/db';
import type {
  AuditEvent,
  AuthCode,
  AuthRepository,
  AuthUser,
  NewCode,
  NewSession,
  RotateResult,
} from './auth.contracts.js';

const AUTH_SCOPE = {};
const MAX_CODE_ATTEMPTS = 5;

function toAuthUser(user: User): AuthUser {
  return {
    id: user.id,
    email: user.email,
    emailVerifiedAt: user.emailVerifiedAt,
    phoneE164: user.phoneE164,
    phoneVerifiedAt: user.phoneVerifiedAt,
    passwordHash: user.passwordHash,
    status: user.status,
    failedLoginCount: user.failedLoginCount,
    lockedUntil: user.lockedUntil,
  };
}

function toAuthCode(code: VerificationCode): AuthCode {
  return {
    id: code.id,
    userId: code.userId,
    channel: code.channel,
    purpose: code.purpose,
    target: code.target,
    codeHash: code.codeHash,
    attempts: code.attempts,
    maxAttempts: code.maxAttempts,
    expiresAt: code.expiresAt,
    consumedAt: code.consumedAt,
  };
}

async function writeAudit(tx: TransactionClient, event: AuditEvent): Promise<void> {
  await tx.auditLog.create({
    data: {
      ...(event.actorUserId ? { actorUserId: event.actorUserId } : {}),
      action: event.action.slice(0, 64),
      entityType: 'AUTH',
      ...(event.entityId ? { entityId: event.entityId } : {}),
      metadata: event.metadata ? (event.metadata as Prisma.InputJsonValue) : Prisma.JsonNull,
      ...(event.ipAddress ? { ipAddress: event.ipAddress.slice(0, 64) } : {}),
      ...(event.userAgent ? { userAgent: event.userAgent.slice(0, 512) } : {}),
    },
  });
}

async function writeCode(tx: TransactionClient, userId: string, code: NewCode): Promise<void> {
  await tx.verificationCode.create({
    data: {
      userId,
      channel: code.channel,
      purpose: code.purpose,
      target: code.target,
      codeHash: code.codeHash,
      expiresAt: code.expiresAt,
      maxAttempts: MAX_CODE_ATTEMPTS,
    },
  });
}

export class PrismaAuthRepository implements AuthRepository, OnModuleDestroy {
  constructor(private readonly prisma: PrismaClient) {}

  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
  }

  async createPendingUser(input: {
    email: string;
    phoneE164: string;
    passwordHash: string;
    emailCode: NewCode;
    phoneCode: NewCode;
    audit: AuditEvent;
  }): Promise<AuthUser> {
    return withAuthScope(this.prisma, AUTH_SCOPE, async (tx) => {
      const user = await tx.user.create({
        data: {
          email: input.email,
          phoneE164: input.phoneE164,
          passwordHash: input.passwordHash,
          status: 'PENDING_VERIFICATION',
        },
      });
      await Promise.all([
        writeCode(tx, user.id, input.emailCode),
        writeCode(tx, user.id, input.phoneCode),
      ]);
      await writeAudit(tx, { ...input.audit, actorUserId: user.id, entityId: user.id });
      return toAuthUser(user);
    });
  }

  async findUserByIdentifier(identifier: string): Promise<AuthUser | null> {
    return withAuthScope(this.prisma, AUTH_SCOPE, async (tx) => {
      const user = await tx.user.findFirst({
        where: identifier.includes('@') ? { email: identifier } : { phoneE164: identifier },
      });
      return user ? toAuthUser(user) : null;
    });
  }

  async findUserById(userId: string): Promise<AuthUser | null> {
    return withAuthScope(this.prisma, { ...AUTH_SCOPE, userId }, async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      return user ? toAuthUser(user) : null;
    });
  }

  async findTenantIdByUserId(userId: string): Promise<string | null> {
    return withAuthScope(this.prisma, { userId }, async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { ownerUserId: userId },
        select: { id: true },
      });
      return tenant?.id ?? null;
    });
  }

  async findUserByEmail(email: string): Promise<AuthUser | null> {
    return withAuthScope(this.prisma, AUTH_SCOPE, async (tx) => {
      const user = await tx.user.findUnique({ where: { email } });
      return user ? toAuthUser(user) : null;
    });
  }

  async findCode(
    channel: AuthCode['channel'],
    purpose: AuthCode['purpose'],
    target: string,
  ): Promise<AuthCode | null> {
    return withAuthScope(this.prisma, AUTH_SCOPE, async (tx) => {
      const code = await tx.verificationCode.findFirst({
        where: { channel, purpose, target, consumedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      return code ? toAuthCode(code) : null;
    });
  }

  async findCodeByHash(
    channel: AuthCode['channel'],
    purpose: AuthCode['purpose'],
    codeHash: string,
  ): Promise<AuthCode | null> {
    return withAuthScope(this.prisma, AUTH_SCOPE, async (tx) => {
      const code = await tx.verificationCode.findFirst({
        where: { channel, purpose, codeHash, consumedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      return code ? toAuthCode(code) : null;
    });
  }

  async incrementCodeAttempt(codeId: string): Promise<void> {
    await withAuthScope(this.prisma, AUTH_SCOPE, async (tx) => {
      await tx.verificationCode.updateMany({
        where: { id: codeId, consumedAt: null, attempts: { lt: MAX_CODE_ATTEMPTS } },
        data: { attempts: { increment: 1 } },
      });
    });
  }

  async completeVerification(input: {
    userId: string;
    codeId: string;
    channel: AuthCode['channel'];
    now: Date;
    audit: AuditEvent;
  }): Promise<boolean> {
    return withAuthScope(this.prisma, { ...AUTH_SCOPE, userId: input.userId }, async (tx) => {
      const consumed = await tx.verificationCode.updateMany({
        where: {
          id: input.codeId,
          userId: input.userId,
          channel: input.channel,
          consumedAt: null,
          expiresAt: { gt: input.now },
          attempts: { lt: MAX_CODE_ATTEMPTS },
        },
        data: { consumedAt: input.now },
      });
      if (consumed.count !== 1) return false;

      const user = await tx.user.findUnique({ where: { id: input.userId } });
      if (!user || user.status === 'DISABLED') return false;
      const updated = await tx.user.update({
        where: { id: input.userId },
        data:
          input.channel === 'EMAIL'
            ? { emailVerifiedAt: input.now }
            : { phoneVerifiedAt: input.now },
      });
      if (updated.emailVerifiedAt && updated.phoneVerifiedAt) {
        await tx.user.update({ where: { id: user.id }, data: { status: 'ACTIVE' } });
        const tenantName =
          user.email.slice(0, user.email.indexOf('@')).slice(0, 120) || 'Workspace';
        await tx.tenant.upsert({
          where: { ownerUserId: user.id },
          create: { ownerUserId: user.id, name: tenantName },
          update: {},
        });
      }
      await writeAudit(tx, { ...input.audit, actorUserId: user.id, entityId: user.id });
      return true;
    });
  }

  async createCode(userId: string, code: NewCode, audit: AuditEvent): Promise<void> {
    await withAuthScope(this.prisma, { ...AUTH_SCOPE, userId }, async (tx) => {
      await tx.verificationCode.updateMany({
        where: { userId, channel: code.channel, purpose: code.purpose, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      await writeCode(tx, userId, code);
      await writeAudit(tx, { ...audit, actorUserId: userId, entityId: userId });
    });
  }

  async resetPassword(input: {
    userId: string;
    codeId: string;
    passwordHash: string;
    now: Date;
    audit: AuditEvent;
  }): Promise<boolean> {
    return withAuthScope(this.prisma, { ...AUTH_SCOPE, userId: input.userId }, async (tx) => {
      const consumed = await tx.verificationCode.updateMany({
        where: {
          id: input.codeId,
          userId: input.userId,
          channel: 'EMAIL',
          purpose: 'PASSWORD_RESET',
          consumedAt: null,
          expiresAt: { gt: input.now },
          attempts: { lt: MAX_CODE_ATTEMPTS },
        },
        data: { consumedAt: input.now },
      });
      if (consumed.count !== 1) return false;
      const updatedUser = await tx.user.updateMany({
        where: { id: input.userId, status: { not: 'DISABLED' } },
        data: {
          passwordHash: input.passwordHash,
          failedLoginCount: 0,
          lockedUntil: null,
          status: 'ACTIVE',
        },
      });
      if (updatedUser.count !== 1) return false;
      await tx.session.updateMany({
        where: { userId: input.userId, revokedAt: null },
        data: { revokedAt: input.now, revokeReason: 'PASSWORD_RESET' },
      });
      await writeAudit(tx, { ...input.audit, actorUserId: input.userId, entityId: input.userId });
      return true;
    });
  }

  async recordLoginFailure(
    userId: string,
    now: Date,
    threshold: number,
    lockMs: number,
    audit: AuditEvent,
  ): Promise<number> {
    return withAuthScope(this.prisma, { ...AUTH_SCOPE, userId }, async (tx) => {
      const changed = await tx.user.updateMany({
        where: { id: userId, status: { not: 'DISABLED' } },
        data: { failedLoginCount: { increment: 1 } },
      });
      if (changed.count !== 1) {
        await writeAudit(tx, { ...audit, actorUserId: userId, entityId: userId });
        return 0;
      }
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) return 0;
      const count = user.failedLoginCount;
      if (count >= threshold && user.status !== 'DISABLED') {
        await tx.user.update({
          where: { id: userId },
          data: { status: 'LOCKED', lockedUntil: new Date(now.getTime() + lockMs) },
        });
      }
      await writeAudit(tx, {
        ...audit,
        actorUserId: userId,
        entityId: userId,
        action: count >= threshold ? 'auth.login.locked' : 'auth.login.failed',
        metadata: { failedLoginCount: count },
      });
      return count;
    });
  }

  async clearLoginFailures(userId: string, audit: AuditEvent): Promise<void> {
    await withAuthScope(this.prisma, { ...AUTH_SCOPE, userId }, async (tx) => {
      await tx.user.updateMany({
        where: { id: userId, status: { not: 'DISABLED' } },
        data: { failedLoginCount: 0, lockedUntil: null, status: 'ACTIVE' },
      });
      await writeAudit(tx, { ...audit, actorUserId: userId, entityId: userId });
    });
  }

  async createSession(input: NewSession, now: Date): Promise<string> {
    return withAuthScope(this.prisma, { ...AUTH_SCOPE, userId: input.userId }, async (tx) => {
      const session = await tx.session.create({
        data: {
          userId: input.userId,
          expiresAt: input.expiresAt,
          ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
          ...(input.userAgent ? { userAgent: input.userAgent.slice(0, 512) } : {}),
          lastSeenAt: now,
          refreshTokens: { create: { tokenHash: input.tokenHash, expiresAt: input.expiresAt } },
        },
      });
      await writeAudit(tx, {
        action: 'auth.login.succeeded',
        actorUserId: input.userId,
        entityId: session.id,
        ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
        ...(input.userAgent ? { userAgent: input.userAgent } : {}),
      });
      return session.id;
    });
  }

  async rotateRefreshToken(input: {
    tokenHash: string;
    replacementHash: string;
    replacementExpiresAt: Date;
    now: Date;
    audit: AuditEvent;
  }): Promise<RotateResult> {
    return withAuthScope(this.prisma, AUTH_SCOPE, async (tx) => {
      const previous = await tx.refreshToken.findUnique({
        where: { tokenHash: input.tokenHash },
        include: { session: { include: { user: true } } },
      });
      if (!previous) return { status: 'invalid' };
      const session = previous.session;
      if (previous.usedAt) {
        await tx.session.updateMany({
          where: { id: session.id, revokedAt: null },
          data: { revokedAt: input.now, revokeReason: 'REFRESH_TOKEN_REUSE' },
        });
        await writeAudit(tx, {
          ...input.audit,
          actorUserId: session.userId,
          entityId: session.id,
          action: 'auth.refresh.reuse_detected',
        });
        return { status: 'reused' };
      }
      if (
        previous.expiresAt <= input.now ||
        session.expiresAt <= input.now ||
        session.revokedAt ||
        session.user.status !== 'ACTIVE'
      ) {
        return { status: 'invalid' };
      }

      const replacementId = crypto.randomUUID();
      const claimed = await tx.refreshToken.updateMany({
        where: { id: previous.id, usedAt: null, expiresAt: { gt: input.now } },
        data: { usedAt: input.now, replacedBy: replacementId },
      });
      if (claimed.count !== 1) {
        const current = await tx.refreshToken.findUnique({ where: { id: previous.id } });
        if (current?.usedAt) {
          await tx.session.updateMany({
            where: { id: session.id, revokedAt: null },
            data: { revokedAt: input.now, revokeReason: 'REFRESH_TOKEN_REUSE' },
          });
          await writeAudit(tx, {
            ...input.audit,
            actorUserId: session.userId,
            entityId: session.id,
            action: 'auth.refresh.reuse_detected',
          });
          return { status: 'reused' };
        }
        return { status: 'invalid' };
      }
      await tx.refreshToken.create({
        data: {
          id: replacementId,
          sessionId: session.id,
          tokenHash: input.replacementHash,
          expiresAt: new Date(
            Math.min(input.replacementExpiresAt.getTime(), session.expiresAt.getTime()),
          ),
        },
      });
      await tx.session.update({ where: { id: session.id }, data: { lastSeenAt: input.now } });
      await writeAudit(tx, {
        ...input.audit,
        actorUserId: session.userId,
        entityId: session.id,
        action: 'auth.refresh.rotated',
      });
      return { status: 'rotated', sessionId: session.id, user: toAuthUser(session.user) };
    });
  }

  async isSessionActive(sessionId: string, userId: string, now: Date): Promise<boolean> {
    return withAuthScope(this.prisma, { ...AUTH_SCOPE, userId }, async (tx) => {
      const session = await tx.session.findFirst({
        where: {
          id: sessionId,
          userId,
          revokedAt: null,
          expiresAt: { gt: now },
          user: { status: 'ACTIVE' },
        },
        select: { id: true },
      });
      return session !== null;
    });
  }

  async revokeSession(
    sessionId: string,
    userId: string,
    now: Date,
    reason: string,
    audit: AuditEvent,
  ): Promise<void> {
    await withAuthScope(this.prisma, { ...AUTH_SCOPE, userId }, async (tx) => {
      const changed = await tx.session.updateMany({
        where: { id: sessionId, userId, revokedAt: null },
        data: { revokedAt: now, revokeReason: reason.slice(0, 64) },
      });
      if (changed.count > 0)
        await writeAudit(tx, { ...audit, actorUserId: userId, entityId: sessionId });
    });
  }

  async revokeByRefreshToken(tokenHash: string, now: Date, audit: AuditEvent): Promise<void> {
    await withAuthScope(this.prisma, AUTH_SCOPE, async (tx) => {
      const token = await tx.refreshToken.findUnique({
        where: { tokenHash },
        select: { sessionId: true },
      });
      if (!token) return;
      const changed = await tx.session.updateMany({
        where: { id: token.sessionId, revokedAt: null },
        data: { revokedAt: now, revokeReason: 'LOGOUT' },
      });
      if (changed.count > 0) {
        const session = await tx.session.findUnique({
          where: { id: token.sessionId },
          select: { userId: true },
        });
        if (session)
          await writeAudit(tx, {
            ...audit,
            actorUserId: session.userId,
            entityId: token.sessionId,
          });
      }
    });
  }

  async audit(event: AuditEvent): Promise<void> {
    await withAuthScope(this.prisma, AUTH_SCOPE, (tx) => writeAudit(tx, event));
  }
}
