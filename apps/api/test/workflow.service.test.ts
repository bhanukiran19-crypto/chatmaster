/* eslint-disable @typescript-eslint/require-await -- in-memory fakes mirror Prisma's async API */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { TransactionClient } from '@chatmaster/db';
import {
  createWorkflowSchema,
  listWorkflowsQuerySchema,
  replaceWorkflowSchema,
} from '@chatmaster/shared';
import { WorkflowService, type TenantActor } from '../src/workflows/workflow.service.js';

// ────────────────────────────────────────────────────────────────────────────
// In-memory fake transaction.
// - Refuses any tenant-table query whose `where` lacks a tenantId, proving the
//   service layer scopes every query on its own (RLS is the second layer).
// - Enforces the workflow_reply_buttons FK/CHECK hazard: deleting a reply that
//   a surviving button still references throws, like Postgres would.
// ────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown> & { id: string; tenantId: string };
type Where = Record<string, unknown>;

function requireTenant(where: Where | undefined, model: string): void {
  if (!where || typeof where['tenantId'] !== 'string') {
    throw new Error(`${model} query without tenantId scope`);
  }
}

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return (condition as Where[]).some((branch) => matches(row, branch));
    const value = row[key];
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      const op = condition as { in?: unknown[]; gt?: string | number };
      if (op.in) return op.in.includes(value);
      if (op.gt !== undefined) return (value as string | number) > op.gt;
    }
    return value === condition;
  });
}

class FakeTx {
  connections: Row[] = [];
  workflows: Row[] = [];
  triggers: Row[] = [];
  replies: Row[] = [];
  buttons: Row[] = [];
  audits: Row[] = [];

  private graph(wf: Row) {
    const replies = this.replies
      .filter((reply) => reply['workflowId'] === wf.id)
      .sort((a, b) => (a['position'] as number) - (b['position'] as number))
      .map((reply) => ({
        ...reply,
        buttons: this.buttons
          .filter((button) => button['replyId'] === reply.id)
          .sort(
            (a, b) =>
              (a['row'] as number) - (b['row'] as number) ||
              (a['column'] as number) - (b['column'] as number),
          ),
      }));
    const triggers = this.triggers
      .filter((trigger) => trigger['workflowId'] === wf.id)
      .sort((a, b) => (a['position'] as number) - (b['position'] as number));
    return {
      ...wf,
      triggers,
      replies,
      _count: { triggers: triggers.length, replies: replies.length },
    };
  }

  platformConnection = {
    findFirst: async ({ where }: { where: Where }) => {
      requireTenant(where, 'platformConnection');
      return this.connections.find((row) => matches(row, where)) ?? null;
    },
  };

  workflow = {
    findMany: async ({ where, take }: { where: Where; take?: number }) => {
      requireTenant(where, 'workflow');
      const rows = this.workflows
        .filter((row) => matches(row, where))
        .sort(
          (a, b) =>
            (a['priority'] as number) - (b['priority'] as number) ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        )
        .map((row) => this.graph(row));
      return take === undefined ? rows : rows.slice(0, take);
    },
    findFirst: async ({ where }: { where: Where }) => {
      requireTenant(where, 'workflow');
      const row = this.workflows.find((candidate) => matches(candidate, where));
      return row ? this.graph(row) : null;
    },
    create: async ({ data }: { data: Row }) => {
      const row = { createdAt: new Date(), updatedAt: new Date(), ...data };
      this.workflows.push(row);
      return { id: row.id };
    },
    updateMany: async ({ where, data }: { where: Where; data: Where }) => {
      requireTenant(where, 'workflow');
      const rows = this.workflows.filter((row) => matches(row, where));
      for (const row of rows) Object.assign(row, data, { updatedAt: new Date() });
      return { count: rows.length };
    },
    deleteMany: async ({ where }: { where: Where }) => {
      requireTenant(where, 'workflow');
      const before = this.workflows.length;
      this.workflows = this.workflows.filter((row) => !matches(row, where));
      return { count: before - this.workflows.length };
    },
  };

  private table(name: 'triggers' | 'replies' | 'buttons', model: string) {
    return {
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
        for (const row of data) {
          this[name].push({
            ...row,
            id: typeof row['id'] === 'string' ? row['id'] : randomUUID(),
          } as Row);
        }
        return { count: data.length };
      },
      deleteMany: async ({ where }: { where: Where }) => {
        requireTenant(where, model);
        const removed = this[name].filter((row) => matches(row, where));
        if (name === 'replies') {
          const removedIds = new Set(removed.map((row) => row.id));
          const dangling = this.buttons.some(
            (button) =>
              removedIds.has(button['replyId'] as string) ||
              removedIds.has(button['nextReplyId'] as string),
          );
          if (dangling)
            throw new Error('violates workflow_reply_buttons_payload_matches_type_check');
        }
        this[name] = this[name].filter((row) => !removed.includes(row));
        return { count: removed.length };
      },
    };
  }

  workflowTrigger = this.table('triggers', 'workflowTrigger');
  workflowReply = this.table('replies', 'workflowReply');
  workflowReplyButton = this.table('buttons', 'workflowReplyButton');

  auditLog = {
    create: async ({ data }: { data: Row }) => {
      this.audits.push(data);
      return data;
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const ACTOR_A: TenantActor = { tenantId: TENANT_A, userId: randomUUID() };
const ACTOR_B: TenantActor = { tenantId: TENANT_B, userId: randomUUID() };
const CONN_A = randomUUID();
const CONN_B = randomUUID();

function definition(overrides: Record<string, unknown> = {}) {
  return createWorkflowSchema.parse({
    platformConnectionId: CONN_A,
    name: 'Menu',
    triggers: [{ type: 'START' }, { type: 'CONTAINS', value: 'menu', caseInsensitive: false }],
    replies: [
      {
        key: 'main',
        text: 'Main',
        buttons: [
          { row: 0, column: 0, type: 'CALLBACK', label: 'Pricing', nextReplyKey: 'pricing' },
          { row: 1, column: 0, type: 'URL', label: 'Site', url: 'https://example.com' },
        ],
      },
      {
        key: 'pricing',
        text: 'Prices',
        parseMode: 'HTML',
        buttons: [{ row: 0, column: 0, type: 'CALLBACK', label: 'Back', nextReplyKey: 'main' }],
      },
    ],
    ...overrides,
  });
}

describe('WorkflowService', () => {
  let tx: FakeTx;
  let service: WorkflowService;

  beforeEach(() => {
    tx = new FakeTx();
    tx.connections.push({ id: CONN_A, tenantId: TENANT_A }, { id: CONN_B, tenantId: TENANT_B });
    service = new WorkflowService({ transactionClient: () => tx as unknown as TransactionClient });
  });

  describe('create', () => {
    it('persists triggers, replies and buttons with callback keys resolved to reply ids', async () => {
      const created = await service.create(ACTOR_A, definition());

      expect(created).toMatchObject({
        name: 'Menu',
        enabled: true,
        priority: 100,
        platformConnectionId: CONN_A,
      });
      expect(created.triggers.map((t) => [t.type, t.value, t.caseInsensitive, t.position])).toEqual(
        [
          ['START', null, true, 0],
          ['CONTAINS', 'menu', false, 1],
        ],
      );
      const [main, pricing] = created.replies;
      expect(main?.key).toBe('reply-0');
      expect(main?.buttons[0]).toMatchObject({
        type: 'CALLBACK',
        nextReplyId: pricing?.id,
        nextReplyKey: 'reply-1',
        url: null,
      });
      expect(main?.buttons[1]).toMatchObject({
        type: 'URL',
        url: 'https://example.com',
        nextReplyId: null,
      });
      expect(pricing?.buttons[0]).toMatchObject({ nextReplyId: main?.id });

      expect(
        [...tx.triggers, ...tx.replies, ...tx.buttons].every((row) => row.tenantId === TENANT_A),
      ).toBe(true);
      expect(tx.audits).toEqual([
        expect.objectContaining({
          action: 'workflow.created',
          tenantId: TENANT_A,
          entityId: created.id,
        }),
      ]);
    });

    it("refuses another tenant's connection with 404", async () => {
      await expect(
        service.create(ACTOR_A, definition({ platformConnectionId: CONN_B })),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.workflows).toHaveLength(0);
    });

    it('refuses client-supplied reply ids on create', async () => {
      const input = definition({ replies: [{ key: 'a', id: randomUUID(), text: 'x' }] });
      await expect(service.create(ACTOR_A, input)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('tenant isolation', () => {
    it("tenant B cannot read, replace, patch, reorder or delete tenant A's workflow", async () => {
      const { id } = await service.create(ACTOR_A, definition());
      const replacement = replaceWorkflowSchema.parse({
        name: 'hijack',
        triggers: [{ type: 'ANY' }],
        replies: [{ key: 'a', text: 'x' }],
      });

      await expect(service.get(ACTOR_B, id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.replace(ACTOR_B, id, replacement)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(service.patch(ACTOR_B, id, { enabled: false })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(service.delete(ACTOR_B, id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.reorder(ACTOR_B, { platformConnectionId: CONN_A, workflowIds: [id] }),
      ).rejects.toBeInstanceOf(NotFoundException);

      const untouched = await service.get(ACTOR_A, id);
      expect(untouched).toMatchObject({ enabled: true, name: 'Menu' });
      expect((await service.list(ACTOR_B, listWorkflowsQuerySchema.parse({}))).items).toEqual([]);
    });
  });

  describe('list', () => {
    async function seed(count: number) {
      for (let index = 0; index < count; index += 1) {
        await service.create(
          ACTOR_A,
          definition({ name: `wf-${String(index)}`, priority: (index % 3) * 10 }),
        );
      }
      await service.create(
        ACTOR_B,
        definition({ platformConnectionId: CONN_B, name: 'other tenant' }),
      );
    }

    it('pages through every workflow exactly once in priority/id order', async () => {
      await seed(7);
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await service.list(
          ACTOR_A,
          listWorkflowsQuerySchema.parse({ limit: '3', ...(cursor ? { cursor } : {}) }),
        );
        seen.push(...page.items.map((item) => item.id));
        expect(page.items.length).toBeLessThanOrEqual(3);
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor);

      expect(pages).toBe(3);
      expect(new Set(seen).size).toBe(7);
      const expected = tx.workflows
        .filter((row) => row.tenantId === TENANT_A)
        .sort(
          (a, b) => (a['priority'] as number) - (b['priority'] as number) || (a.id < b.id ? -1 : 1),
        )
        .map((row) => row.id);
      expect(seen).toEqual(expected);
    });

    it('returns summaries with counts and filters by enabled/connection', async () => {
      await seed(2);
      const [first] = (await service.list(ACTOR_A, listWorkflowsQuerySchema.parse({}))).items;
      expect(first).toMatchObject({ triggerCount: 2, replyCount: 2 });
      expect(first).not.toHaveProperty('triggers');

      if (first) await service.patch(ACTOR_A, first.id, { enabled: false });
      const enabledOnly = await service.list(
        ACTOR_A,
        listWorkflowsQuerySchema.parse({ enabled: 'true' }),
      );
      expect(enabledOnly.items.map((item) => item.id)).not.toContain(first?.id);

      const byOtherConn = await service.list(
        ACTOR_A,
        listWorkflowsQuerySchema.parse({ platformConnectionId: CONN_B }),
      );
      expect(byOtherConn.items).toEqual([]);
    });

    it('rejects tampered cursors', async () => {
      await expect(
        service.list(
          ACTOR_A,
          listWorkflowsQuerySchema.parse({
            cursor: Buffer.from('{"p":"x"}').toString('base64url'),
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('replace', () => {
    it('keeps supplied reply ids stable so delivered keyboards keep working', async () => {
      const created = await service.create(ACTOR_A, definition());
      const pricingId = created.replies[1]?.id ?? '';

      const updated = await service.replace(
        ACTOR_A,
        created.id,
        replaceWorkflowSchema.parse({
          name: 'Menu v2',
          cooldownSeconds: 60,
          triggers: [{ type: 'COMMAND', value: '/menu' }],
          replies: [
            {
              key: 'home',
              text: 'New main',
              buttons: [
                { row: 0, column: 0, type: 'CALLBACK', label: 'Prices', nextReplyKey: 'p' },
              ],
            },
            { key: 'p', id: pricingId, text: 'New prices' },
          ],
        }),
      );

      expect(updated).toMatchObject({ name: 'Menu v2', cooldownSeconds: 60 });
      expect(updated.triggers).toEqual([
        expect.objectContaining({ type: 'COMMAND', value: 'menu', position: 0 }),
      ]);
      expect(updated.replies[1]?.id).toBe(pricingId);
      expect(updated.replies[0]?.id).not.toBe(created.replies[0]?.id);
      expect(updated.replies[0]?.buttons[0]?.nextReplyId).toBe(pricingId);
      expect(tx.replies.filter((row) => row['workflowId'] === created.id)).toHaveLength(2);
      expect(tx.triggers.filter((row) => row['workflowId'] === created.id)).toHaveLength(1);
    });

    it('rejects reply ids from another workflow', async () => {
      const a = await service.create(ACTOR_A, definition());
      const b = await service.create(ACTOR_A, definition({ name: 'Other' }));
      const foreignReply = b.replies[0]?.id ?? '';
      await expect(
        service.replace(
          ACTOR_A,
          a.id,
          replaceWorkflowSchema.parse({
            name: 'x',
            triggers: [{ type: 'ANY' }],
            replies: [{ key: 'a', id: foreignReply, text: 'x' }],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect((await service.get(ACTOR_A, b.id)).replies).toHaveLength(2);
    });
  });

  describe('patch (enable/disable)', () => {
    it('disables and re-enables with distinct audit actions', async () => {
      const { id } = await service.create(ACTOR_A, definition());
      expect((await service.patch(ACTOR_A, id, { enabled: false })).enabled).toBe(false);
      expect((await service.patch(ACTOR_A, id, { enabled: true })).enabled).toBe(true);
      expect((await service.patch(ACTOR_A, id, { priority: 5, name: 'Renamed' })).priority).toBe(5);
      expect(tx.audits.map((audit) => audit['action'])).toEqual([
        'workflow.created',
        'workflow.disabled',
        'workflow.enabled',
        'workflow.updated',
      ]);
    });

    it('returns 404 for unknown ids', async () => {
      await expect(service.patch(ACTOR_A, randomUUID(), { enabled: false })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('reorder', () => {
    it('assigns spaced priorities in the requested order', async () => {
      const a = await service.create(ACTOR_A, definition({ name: 'a', priority: 1 }));
      const b = await service.create(ACTOR_A, definition({ name: 'b', priority: 2 }));
      const c = await service.create(ACTOR_A, definition({ name: 'c', priority: 3 }));

      const result = await service.reorder(ACTOR_A, {
        platformConnectionId: CONN_A,
        workflowIds: [c.id, a.id, b.id],
      });

      expect(result.order).toEqual([
        { id: c.id, priority: 10 },
        { id: a.id, priority: 20 },
        { id: b.id, priority: 30 },
      ]);
      const listed = await service.list(ACTOR_A, listWorkflowsQuerySchema.parse({}));
      expect(listed.items.map((item) => item.name)).toEqual(['c', 'a', 'b']);
    });

    it('requires the complete set of workflows on the connection', async () => {
      const a = await service.create(ACTOR_A, definition({ name: 'a' }));
      await service.create(ACTOR_A, definition({ name: 'b' }));
      await expect(
        service.reorder(ACTOR_A, { platformConnectionId: CONN_A, workflowIds: [a.id] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.reorder(ACTOR_A, {
          platformConnectionId: CONN_A,
          workflowIds: [a.id, randomUUID()],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('delete', () => {
    it('removes buttons before replies (FK/CHECK safe) and the workflow itself', async () => {
      const { id } = await service.create(ACTOR_A, definition());
      await expect(service.delete(ACTOR_A, id)).resolves.toEqual({ id });
      expect(tx.workflows).toHaveLength(0);
      expect(tx.replies).toHaveLength(0);
      expect(tx.buttons).toHaveLength(0);
      expect(tx.triggers).toHaveLength(0);
      await expect(service.get(ACTOR_A, id)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
