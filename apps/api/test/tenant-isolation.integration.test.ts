/**
 * Integration tests that prove PostgreSQL RLS enforces tenant isolation for
 * every tenant-owned table. Each test seeds two tenants with related data,
 * then verifies from tenant A's scope that:
 *
 *   1. Cross-tenant reads return null / empty.
 *   2. Cross-tenant updateMany/deleteMany affect 0 rows.
 *   3. IDOR attempts (guessing tenant B's row IDs) fail silently.
 *   4. After the attack, tenant B's data is unchanged.
 *
 * Requires TEST_DATABASE_URL using the least-privilege chatmaster_api role.
 */

import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PrismaClient,
  createTenantPrismaClient,
  withAuthScope,
  withTenantScope,
  requireTenantTransactionClient,
  type TenantSafePrismaClient,
  type TransactionClient,
} from '@chatmaster/db';

const testDatabaseUrl = process.env['TEST_DATABASE_URL'];
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

let rawPrisma: PrismaClient;
let prisma: TenantSafePrismaClient;

beforeAll(() => {
  if (!testDatabaseUrl) return;
  rawPrisma = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  prisma = createTenantPrismaClient(rawPrisma);
});

afterAll(async () => {
  await rawPrisma?.$disconnect();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Unique suffix to avoid collisions with parallel test runs. */
const RUN = randomUUID().slice(0, 8);

interface TenantFixture {
  userId: string;
  tenantId: string;
  connectionId: string;
  workflowId: string;
  triggerId: string;
  replyId: string;
  buttonId: string;
  activeContactId: string;
  processedUpdateId: string;
  subscriptionId: string;
}

async function createTenantFixture(
  label: string,
  planId: string,
): Promise<TenantFixture> {
  const unique = `${label}-${RUN}`;

  // Create user (auth scope allows unrestricted user creation)
  const user = await withAuthScope(prisma, {}, (tx) =>
    tx.user.create({
      data: {
        email: `rls-${unique}@gmail.com`,
        phoneE164: `+1415${randomInt(1_000_000, 9_999_999)}`,
        passwordHash: '$argon2id$test-placeholder',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        phoneVerifiedAt: new Date(),
      },
    }),
  );

  // Create tenant (via auth scope with userId so the user-based RLS also passes)
  const tenant = await withAuthScope(prisma, { userId: user.id }, (tx) =>
    tx.tenant.create({
      data: { ownerUserId: user.id, name: `Tenant ${label}` },
    }),
  );

  // Everything below is tenant-scoped
  const scope = { tenantId: tenant.id, userId: user.id };
  const january = new Date('2026-01-01T00:00:00.000Z');

  return withTenantScope(prisma, scope, async (tx) => {
    const connection = await tx.platformConnection.create({
      data: {
        tenantId: tenant.id,
        platform: 'TELEGRAM',
        status: 'ACTIVE',
        externalAccountId: `bot-${unique}`,
        displayName: `@bot_${unique}`,
        encryptedToken: Buffer.from('test-encrypted-placeholder'),
        tokenKeyVersion: 1,
        webhookPathId: `wh_${unique}_${randomUUID().replace(/-/g, '').slice(0, 32)}`,
        secretTokenHash: 'a'.repeat(64),
      },
    });

    const workflow = await tx.workflow.create({
      data: {
        tenantId: tenant.id,
        platformConnectionId: connection.id,
        name: `Workflow ${unique}`,
        enabled: true,
        priority: 1,
      },
    });

    const trigger = await tx.workflowTrigger.create({
      data: {
        tenantId: tenant.id,
        workflowId: workflow.id,
        type: 'EXACT',
        value: `trigger-${unique}`,
        caseInsensitive: true,
      },
    });

    const reply = await tx.workflowReply.create({
      data: {
        tenantId: tenant.id,
        workflowId: workflow.id,
        position: 0,
        text: `Reply from ${label}`,
      },
    });

    const button = await tx.workflowReplyButton.create({
      data: {
        tenantId: tenant.id,
        replyId: reply.id,
        row: 0,
        column: 0,
        type: 'URL',
        label: `Button ${unique}`,
        url: `https://example.com/${unique}`,
      },
    });

    const activeContact = await tx.activeContact.create({
      data: {
        tenantId: tenant.id,
        platform: 'TELEGRAM',
        externalChatId: `chat-${unique}`,
        month: january,
      },
    });

    const processedUpdate = await tx.processedUpdate.create({
      data: {
        tenantId: tenant.id,
        platformConnectionId: connection.id,
        updateId: BigInt(randomInt(1_000_000, 999_999_999)),
      },
    });

    const subscription = await tx.subscription.create({
      data: {
        tenantId: tenant.id,
        planId,
        status: 'TRIALING',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    const auditLog = await tx.auditLog.create({
      data: {
        tenantId: tenant.id,
        actorUserId: user.id,
        action: 'test.fixture.created',
        entityType: 'test',
        entityId: workflow.id,
      },
    });

    return {
      userId: user.id,
      tenantId: tenant.id,
      connectionId: connection.id,
      workflowId: workflow.id,
      triggerId: trigger.id,
      replyId: reply.id,
      buttonId: button.id,
      activeContactId: activeContact.id,
      processedUpdateId: processedUpdate.id,
      subscriptionId: subscription.id,
    };
  });
}

async function cleanupFixture(fixture: TenantFixture): Promise<void> {
  // Clean up in tenant scope (RLS applies)
  await withTenantScope(
    prisma,
    { tenantId: fixture.tenantId, userId: fixture.userId },
    async (tx) => {
      await tx.subscription.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.processedUpdate.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.activeContact.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.workflowReplyButton.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.workflowReply.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.workflowTrigger.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.workflow.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.platformConnection.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.auditLog.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.tenant.deleteMany({ where: { id: fixture.tenantId } });
    },
  );
  await withAuthScope(prisma, {}, (tx) =>
    tx.user.deleteMany({ where: { id: fixture.userId } }),
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describeWithDatabase('TenantPrismaClient proxy prevents unscoped access', () => {
  it('blocks model access outside any RLS scope', () => {
    expect(() => (prisma as PrismaClient).user).toThrow(
      'PrismaClient model access (".user") outside an RLS scope',
    );
    expect(() => (prisma as PrismaClient).tenant).toThrow(
      'outside an RLS scope',
    );
    expect(() => (prisma as PrismaClient).workflow).toThrow(
      'outside an RLS scope',
    );
    expect(() => (prisma as PrismaClient).platformConnection).toThrow(
      'outside an RLS scope',
    );
  });

  it('allows $connect, $disconnect, and $transaction through the proxy', async () => {
    // These should not throw
    expect(typeof prisma.$connect).toBe('function');
    expect(typeof prisma.$disconnect).toBe('function');
    expect(typeof prisma.$transaction).toBe('function');
  });

  it('exposes __tenantSafe marker', () => {
    expect(prisma.__tenantSafe).toBe(true);
  });

  it('requireTenantTransactionClient() throws outside any scope', () => {
    expect(() => requireTenantTransactionClient()).toThrow(
      'Tenant database access requires an active tenant transaction',
    );
  });

  it('requireTenantTransactionClient() throws inside auth scope (no tenantId)', async () => {
    await expect(
      withAuthScope(prisma, {}, async () => requireTenantTransactionClient()),
    ).rejects.toThrow('Tenant database access requires an active tenant transaction');
  });
});

describeWithDatabase('PostgreSQL RLS: comprehensive cross-tenant isolation', () => {
  let fixtureA: TenantFixture;
  let fixtureB: TenantFixture;
  let planId: string;

  beforeAll(async () => {
    if (!prisma) throw new Error('TEST_DATABASE_URL must use the chatmaster_api role');

    // Create a shared plan (plans are not tenant-scoped)
    const planCode = `test_rls_${RUN}`;
    // Plans are read-only for the app role, so we insert via raw SQL
    // through the auth scope (the plan table has a public-read policy).
    // Actually, plans need to be seeded by the migration role.
    // We'll use $queryRaw through the prisma client.
    const existingPlans = await withAuthScope(prisma, {}, async (tx) => {
      // Look for any active plan we can use
      return tx.plan.findFirst({ where: { isActive: true }, select: { id: true } });
    });

    if (existingPlans) {
      planId = existingPlans.id;
    } else {
      // Create via raw query if no plan exists (bypass RLS for test setup)
      const newPlanId = randomUUID();
      await rawPrisma.$executeRaw`
        INSERT INTO plans (id, code, name, price_cents, active_contact_limit, is_default, is_active, updated_at)
        VALUES (${newPlanId}::uuid, ${planCode}, 'Test Plan', 0, 1000, false, true, now())
      `;
      planId = newPlanId;
    }

    fixtureA = await createTenantFixture('A', planId);
    fixtureB = await createTenantFixture('B', planId);
  }, 30_000);

  afterAll(async () => {
    if (fixtureA) await cleanupFixture(fixtureA);
    if (fixtureB) await cleanupFixture(fixtureB);
  }, 30_000);

  const scopeA = () => ({ tenantId: fixtureA.tenantId, userId: fixtureA.userId });

  // ── Tenant table ──────────────────────────────────────────────────────

  it('tenant A cannot read tenant B', async () => {
    const tenants = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.tenant.findMany({ select: { id: true } }),
    );
    const ids = tenants.map((t) => t.id);
    expect(ids).toContain(fixtureA.tenantId);
    expect(ids).not.toContain(fixtureB.tenantId);
  });

  it('tenant A cannot findUnique tenant B by guessed ID (IDOR)', async () => {
    const result = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.tenant.findUnique({ where: { id: fixtureB.tenantId } }),
    );
    expect(result).toBeNull();
  });

  it('tenant A cannot update tenant B', async () => {
    const result = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.tenant.updateMany({
        where: { id: fixtureB.tenantId },
        data: { name: 'COMPROMISED' },
      }),
    );
    expect(result.count).toBe(0);

    // Verify B is unchanged
    const bTenant = await withTenantScope(
      prisma,
      { tenantId: fixtureB.tenantId, userId: fixtureB.userId },
      (tx) => tx.tenant.findUnique({ where: { id: fixtureB.tenantId }, select: { name: true } }),
    );
    expect(bTenant?.name).toBe('Tenant B');
  });

  it('tenant A cannot delete tenant B', async () => {
    const result = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.tenant.deleteMany({ where: { id: fixtureB.tenantId } }),
    );
    expect(result.count).toBe(0);
  });

  // ── PlatformConnection table ──────────────────────────────────────────

  it('tenant A cannot read tenant B platform connections', async () => {
    const connections = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.platformConnection.findMany({ select: { id: true } }),
    );
    const ids = connections.map((c) => c.id);
    expect(ids).toContain(fixtureA.connectionId);
    expect(ids).not.toContain(fixtureB.connectionId);
  });

  it('IDOR: tenant A findUnique on tenant B connection returns null', async () => {
    const result = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.platformConnection.findUnique({ where: { id: fixtureB.connectionId } }),
    );
    expect(result).toBeNull();
  });

  it('tenant A cannot update tenant B platform connection', async () => {
    const result = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.platformConnection.updateMany({
        where: { id: fixtureB.connectionId },
        data: { lastError: 'COMPROMISED' },
      }),
    );
    expect(result.count).toBe(0);
  });

  it('tenant A cannot delete tenant B platform connection', async () => {
    const result = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.platformConnection.deleteMany({ where: { id: fixtureB.connectionId } }),
    );
    expect(result.count).toBe(0);
  });

  // ── Workflow table ────────────────────────────────────────────────────

  it('tenant A cannot read tenant B workflows', async () => {
    const workflows = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.workflow.findMany({ select: { id: true } }),
    );
    const ids = workflows.map((w) => w.id);
    expect(ids).toContain(fixtureA.workflowId);
    expect(ids).not.toContain(fixtureB.workflowId);
  });

  it('IDOR: tenant A findUnique on tenant B workflow returns null', async () => {
    const result = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.workflow.findUnique({ where: { id: fixtureB.workflowId } }),
    );
    expect(result).toBeNull();
  });

  it('tenant A cannot update tenant B workflow', async () => {
    const result = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.workflow.updateMany({
        where: { id: fixtureB.workflowId },
        data: { name: 'COMPROMISED' },
      }),
    );
    expect(result.count).toBe(0);

    const bWorkflow = await withTenantScope(
      prisma,
      { tenantId: fixtureB.tenantId, userId: fixtureB.userId },
      (tx) => tx.workflow.findUnique({ where: { id: fixtureB.workflowId }, select: { name: true } }),
    );
    expect(bWorkflow?.name).toContain('Workflow B');
  });

  it('tenant A cannot delete tenant B workflow', async () => {
    const result = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.workflow.deleteMany({ where: { id: fixtureB.workflowId } }),
    );
    expect(result.count).toBe(0);
  });

  // ── WorkflowTrigger table ─────────────────────────────────────────────

  it('tenant A cannot read tenant B workflow triggers', async () => {
    const triggers = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.workflowTrigger.findMany({ select: { id: true } }),
    );
    expect(triggers.map((t) => t.id)).not.toContain(fixtureB.triggerId);
  });

  it('IDOR: tenant A findUnique on tenant B trigger returns null', async () => {
    const result = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.workflowTrigger.findUnique({ where: { id: fixtureB.triggerId } }),
    );
    expect(result).toBeNull();
  });

  it('tenant A cannot update tenant B workflow trigger', async () => {
    const result = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.workflowTrigger.updateMany({
        where: { id: fixtureB.triggerId },
        data: { caseInsensitive: false },
      }),
    );
    expect(result.count).toBe(0);
  });

  it('tenant A cannot delete tenant B workflow trigger', async () => {
    const result = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.workflowTrigger.deleteMany({ where: { id: fixtureB.triggerId } }),
    );
    expect(result.count).toBe(0);
  });

  // ── WorkflowReply table ───────────────────────────────────────────────

  it('tenant A cannot read tenant B workflow replies', async () => {
    const replies = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.workflowReply.findMany({ select: { id: true } }),
    );
    expect(replies.map((r) => r.id)).not.toContain(fixtureB.replyId);
  });

  it('IDOR: tenant A findUnique on tenant B reply returns null', async () => {
    const result = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.workflowReply.findUnique({ where: { id: fixtureB.replyId } }),
    );
    expect(result).toBeNull();
  });

  it('tenant A cannot update tenant B workflow reply', async () => {
    const result = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.workflowReply.updateMany({
        where: { id: fixtureB.replyId },
        data: { text: 'COMPROMISED' },
      }),
    );
    expect(result.count).toBe(0);

    const bReply = await withTenantScope(
      prisma,
      { tenantId: fixtureB.tenantId, userId: fixtureB.userId },
      (tx) => tx.workflowReply.findUnique({ where: { id: fixtureB.replyId }, select: { text: true } }),
    );
    expect(bReply?.text).toBe('Reply from B');
  });

  it('tenant A cannot delete tenant B workflow reply', async () => {
    const result = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.workflowReply.deleteMany({ where: { id: fixtureB.replyId } }),
    );
    expect(result.count).toBe(0);
  });

  // ── WorkflowReplyButton table ─────────────────────────────────────────

  it('tenant A cannot read tenant B buttons', async () => {
    const buttons = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.workflowReplyButton.findMany({ select: { id: true } }),
    );
    expect(buttons.map((b) => b.id)).not.toContain(fixtureB.buttonId);
  });

  it('IDOR: tenant A findUnique on tenant B button returns null', async () => {
    const result = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.workflowReplyButton.findUnique({ where: { id: fixtureB.buttonId } }),
    );
    expect(result).toBeNull();
  });

  it('tenant A cannot update tenant B button', async () => {
    const result = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.workflowReplyButton.updateMany({
        where: { id: fixtureB.buttonId },
        data: { label: 'COMPROMISED' },
      }),
    );
    expect(result.count).toBe(0);
  });

  it('tenant A cannot delete tenant B button', async () => {
    const result = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.workflowReplyButton.deleteMany({ where: { id: fixtureB.buttonId } }),
    );
    expect(result.count).toBe(0);
  });

  // ── ActiveContact table ───────────────────────────────────────────────

  it('tenant A cannot read tenant B active contacts', async () => {
    const contacts = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.activeContact.findMany({ select: { id: true } }),
    );
    expect(contacts.map((c) => c.id)).toContain(fixtureA.activeContactId);
    expect(contacts.map((c) => c.id)).not.toContain(fixtureB.activeContactId);
  });

  it('IDOR: tenant A findUnique on tenant B active contact returns null', async () => {
    const result = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.activeContact.findUnique({ where: { id: fixtureB.activeContactId } }),
    );
    expect(result).toBeNull();
  });

  it('tenant A cannot update tenant B active contact', async () => {
    const result = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.activeContact.updateMany({
        where: { id: fixtureB.activeContactId },
        data: { externalChatId: 'COMPROMISED' },
      }),
    );
    expect(result.count).toBe(0);
  });

  it('tenant A cannot delete tenant B active contact', async () => {
    const result = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.activeContact.deleteMany({ where: { id: fixtureB.activeContactId } }),
    );
    expect(result.count).toBe(0);
  });

  // ── ProcessedUpdate table ─────────────────────────────────────────────

  it('tenant A cannot read tenant B processed updates', async () => {
    const updates = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.processedUpdate.findMany({ select: { id: true } }),
    );
    expect(updates.map((u) => u.id)).not.toContain(fixtureB.processedUpdateId);
  });

  it('IDOR: tenant A findUnique on tenant B processed update returns null', async () => {
    const result = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.processedUpdate.findUnique({ where: { id: fixtureB.processedUpdateId } }),
    );
    expect(result).toBeNull();
  });

  it('tenant A cannot delete tenant B processed update', async () => {
    const result = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.processedUpdate.deleteMany({ where: { id: fixtureB.processedUpdateId } }),
    );
    expect(result.count).toBe(0);
  });

  // ── Subscription table ────────────────────────────────────────────────

  it('tenant A cannot read tenant B subscription', async () => {
    const subs = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.subscription.findMany({ select: { id: true } }),
    );
    expect(subs.map((s) => s.id)).toContain(fixtureA.subscriptionId);
    expect(subs.map((s) => s.id)).not.toContain(fixtureB.subscriptionId);
  });

  it('IDOR: tenant A findUnique on tenant B subscription returns null', async () => {
    const result = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.subscription.findUnique({ where: { id: fixtureB.subscriptionId } }),
    );
    expect(result).toBeNull();
  });

  it('tenant A cannot update tenant B subscription', async () => {
    const result = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.subscription.updateMany({
        where: { id: fixtureB.subscriptionId },
        data: { cancelAtPeriodEnd: true },
      }),
    );
    expect(result.count).toBe(0);
  });

  it('tenant A cannot delete tenant B subscription', async () => {
    const result = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.subscription.deleteMany({ where: { id: fixtureB.subscriptionId } }),
    );
    expect(result.count).toBe(0);
  });

  // ── AuditLog table ────────────────────────────────────────────────────

  it('tenant A cannot read tenant B audit logs', async () => {
    const logs = await withTenantScope(prisma, scopeA(), (tx) =>
      tx.auditLog.findMany({ select: { tenantId: true } }),
    );
    for (const log of logs) {
      expect(log.tenantId).toBe(fixtureA.tenantId);
    }
  });

  // ── No-context queries see nothing ────────────────────────────────────

  it('queries without any scope return zero rows', async () => {
    // Use the auth scope with no userId and no context override to simulate
    // a completely empty scope (all settings will be '').
    // Actually, we want truly "no context". The withAuthScope sets context='auth'
    // which opens up certain tables. Instead, use withRlsScope equivalent with
    // all empty values to test the "no context" case.
    // The simplest way: directly test through a $transaction with explicit empty settings.
    const result = await rawPrisma.$transaction(async (tx) => {
      // Set all settings to empty (this is what "no context" looks like)
      await tx.$queryRaw`SELECT set_config('app.tenant_id', '', true)`;
      await tx.$queryRaw`SELECT set_config('app.user_id', '', true)`;
      await tx.$queryRaw`SELECT set_config('app.webhook_path_id', '', true)`;
      await tx.$queryRaw`SELECT set_config('app.context', '', true)`;

      const tenants = await tx.tenant.findMany();
      const users = await tx.user.findMany();
      const connections = await tx.platformConnection.findMany();
      const workflows = await tx.workflow.findMany();

      return { tenants, users, connections, workflows };
    });

    expect(result.tenants).toHaveLength(0);
    expect(result.users).toHaveLength(0);
    expect(result.connections).toHaveLength(0);
    expect(result.workflows).toHaveLength(0);
  });

  // ── Final integrity checks ────────────────────────────────────────────

  it('after all IDOR attempts, tenant B data is fully intact', async () => {
    const scopeB = { tenantId: fixtureB.tenantId, userId: fixtureB.userId };

    const result = await withTenantScope(prisma, scopeB, async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: fixtureB.tenantId },
        select: { name: true },
      });
      const connection = await tx.platformConnection.findUnique({
        where: { id: fixtureB.connectionId },
        select: { displayName: true, lastError: true },
      });
      const workflow = await tx.workflow.findUnique({
        where: { id: fixtureB.workflowId },
        select: { name: true },
      });
      const trigger = await tx.workflowTrigger.findUnique({
        where: { id: fixtureB.triggerId },
        select: { caseInsensitive: true },
      });
      const reply = await tx.workflowReply.findUnique({
        where: { id: fixtureB.replyId },
        select: { text: true },
      });
      const button = await tx.workflowReplyButton.findUnique({
        where: { id: fixtureB.buttonId },
        select: { label: true },
      });
      const contact = await tx.activeContact.findUnique({
        where: { id: fixtureB.activeContactId },
        select: { externalChatId: true },
      });
      const update = await tx.processedUpdate.findUnique({
        where: { id: fixtureB.processedUpdateId },
        select: { id: true },
      });
      const sub = await tx.subscription.findUnique({
        where: { id: fixtureB.subscriptionId },
        select: { cancelAtPeriodEnd: true },
      });

      return { tenant, connection, workflow, trigger, reply, button, contact, update, sub };
    });

    expect(result.tenant?.name).toBe('Tenant B');
    expect(result.connection?.displayName).toContain('bot_B');
    expect(result.connection?.lastError).toBeNull();
    expect(result.workflow?.name).toContain('Workflow B');
    expect(result.trigger?.caseInsensitive).toBe(true);
    expect(result.reply?.text).toBe('Reply from B');
    expect(result.button?.label).toContain('Button B');
    expect(result.contact?.externalChatId).toContain('chat-B');
    expect(result.update).not.toBeNull();
    expect(result.sub?.cancelAtPeriodEnd).toBe(false);
  });
});
