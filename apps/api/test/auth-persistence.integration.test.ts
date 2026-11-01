import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient, withAuthScope } from '@chatmaster/db';
import type { AuthRateLimiter, PasswordHasher } from '../src/auth/auth.contracts.js';
import { AuthService } from '../src/auth/auth.service.js';
import { PrismaAuthRepository } from '../src/auth/prisma-auth.repository.js';

const testDatabaseUrl = process.env['TEST_DATABASE_URL'];
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const prisma = testDatabaseUrl
  ? new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } })
  : null;
const fixedNow = new Date();
const rateLimiter: AuthRateLimiter = { consume: async () => true };
const passwordHasher: PasswordHasher = {
  hash: async (password) => `test-hash:${password}`,
  verify: async (hash, password) => hash === `test-hash:${password}`,
};

function makeService(repository: PrismaAuthRepository): AuthService {
  return new AuthService(
    repository,
    rateLimiter,
    { sendOtp: async () => undefined },
    { sendVerificationLink: async () => undefined, sendPasswordResetLink: async () => undefined },
    {
      jwtSecret: 'integration-test-key-material-with-at-least-thirty-two-bytes',
      issuer: 'chatmaster-integration-test',
      audience: 'chatmaster-integration-test-web',
      webAppUrl: 'https://integration-test.example',
    },
    passwordHasher,
    () => fixedNow,
  );
}

async function createUser(client: PrismaClient) {
  const unique = randomUUID();
  return withAuthScope(client, {}, (tx) =>
    tx.user.create({
      data: {
        email: `auth-${unique}@gmail.com`,
        phoneE164: `+1415${randomInt(1_000_000, 9_999_999)}`,
        passwordHash: 'test-hash:correct-password',
        emailVerifiedAt: fixedNow,
        phoneVerifiedAt: fixedNow,
        status: 'ACTIVE',
      },
    }),
  );
}

async function deleteUser(client: PrismaClient, userId: string): Promise<void> {
  await withAuthScope(client, {}, (tx) => tx.user.deleteMany({ where: { id: userId } }));
}

afterAll(async () => {
  await prisma?.$disconnect();
});

describeWithDatabase('PostgreSQL-backed authentication', () => {
  it('persists lockout and detects refresh-token reuse across requests', async () => {
    if (!prisma)
      throw new Error('TEST_DATABASE_URL must use the least-privilege chatmaster_api role');
    const repository = new PrismaAuthRepository(prisma);
    const service = makeService(repository);

    const lockedUser = await createUser(prisma);
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(
          service.login(lockedUser.email, 'wrong-password', { ipAddress: '127.0.0.1' }),
        ).rejects.toMatchObject({ status: 401 });
      }
      const persistedLock = await repository.findUserById(lockedUser.id);
      expect(persistedLock?.status).toBe('LOCKED');
      expect(persistedLock?.failedLoginCount).toBe(5);
    } finally {
      await deleteUser(prisma, lockedUser.id);
    }

    const refreshUser = await createUser(prisma);
    try {
      const initial = await service.login(refreshUser.phoneE164, 'correct-password', {
        ipAddress: '127.0.0.1',
      });
      const rotated = await service.refresh(initial.refreshToken, { ipAddress: '127.0.0.1' });
      expect(rotated.refreshToken).not.toBe(initial.refreshToken);
      await expect(
        service.refresh(initial.refreshToken, { ipAddress: '127.0.0.1' }),
      ).rejects.toMatchObject({
        status: 401,
      });
      expect(await repository.isSessionActive(rotated.sessionId, refreshUser.id, fixedNow)).toBe(
        false,
      );
    } finally {
      await deleteUser(prisma, refreshUser.id);
    }
  });
});
