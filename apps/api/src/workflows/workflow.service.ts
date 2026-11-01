import { randomUUID } from 'node:crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { requireTenantTransactionClient } from '@chatmaster/db';
import type { ButtonType, ParseMode, Prisma, TransactionClient, TriggerType } from '@chatmaster/db';
import type {
  CreateWorkflowInput,
  ListWorkflowsQuery,
  PatchWorkflowInput,
  ReorderWorkflowsInput,
  ReplaceWorkflowInput,
} from '@chatmaster/shared';
import { decodeWorkflowCursor, encodeWorkflowCursor } from './workflow-cursor.js';

export interface TenantActor {
  tenantId: string;
  userId: string;
}

export interface WorkflowSummaryView {
  id: string;
  platformConnectionId: string;
  name: string;
  enabled: boolean;
  priority: number;
  cooldownSeconds: number;
  triggerCount: number;
  replyCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowTriggerView {
  id: string;
  type: TriggerType;
  value: string | null;
  caseInsensitive: boolean;
  position: number;
}

export interface WorkflowButtonView {
  id: string;
  row: number;
  column: number;
  type: ButtonType;
  label: string;
  url: string | null;
  nextReplyId: string | null;
  /** `key` of the target reply in this workflow, so the definition can be PUT back as-is. */
  nextReplyKey: string | null;
}

export interface WorkflowReplyView {
  id: string;
  /** Stable handle derived from position; use it as `key` when replacing the definition. */
  key: string;
  position: number;
  text: string;
  parseMode: ParseMode;
  buttons: WorkflowButtonView[];
}

export interface WorkflowDetailView extends Omit<
  WorkflowSummaryView,
  'triggerCount' | 'replyCount'
> {
  triggers: WorkflowTriggerView[];
  replies: WorkflowReplyView[];
}

export interface WorkflowPage {
  items: WorkflowSummaryView[];
  nextCursor: string | null;
}

export interface ReorderResult {
  platformConnectionId: string;
  order: { id: string; priority: number }[];
}

export interface WorkflowServiceOptions {
  /** Test seam; production uses the request-scoped tenant transaction. */
  transactionClient?: () => TransactionClient;
}

/** Gap between reordered priorities so a single workflow can later be slotted in between. */
export const REORDER_PRIORITY_STEP = 10;

type Definition = Omit<ReplaceWorkflowInput, 'name' | 'enabled' | 'priority' | 'cooldownSeconds'>;

const BASE_SELECT = {
  id: true,
  platformConnectionId: true,
  name: true,
  enabled: true,
  priority: true,
  cooldownSeconds: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.WorkflowSelect;

const SUMMARY_SELECT = {
  ...BASE_SELECT,
  _count: { select: { triggers: true, replies: true } },
} satisfies Prisma.WorkflowSelect;

const DETAIL_SELECT = {
  ...BASE_SELECT,
  triggers: {
    select: { id: true, type: true, value: true, caseInsensitive: true, position: true },
    orderBy: { position: 'asc' },
  },
  replies: {
    select: {
      id: true,
      position: true,
      text: true,
      parseMode: true,
      buttons: {
        select: {
          id: true,
          row: true,
          column: true,
          type: true,
          label: true,
          url: true,
          nextReplyId: true,
        },
        orderBy: [{ row: 'asc' }, { column: 'asc' }],
      },
    },
    orderBy: { position: 'asc' },
  },
} satisfies Prisma.WorkflowSelect;

type SummaryRow = Prisma.WorkflowGetPayload<{ select: typeof SUMMARY_SELECT }>;
type DetailRow = Prisma.WorkflowGetPayload<{ select: typeof DETAIL_SELECT }>;

function replyKey(position: number): string {
  return `reply-${String(position)}`;
}

function toSummary(row: SummaryRow): WorkflowSummaryView {
  return {
    id: row.id,
    platformConnectionId: row.platformConnectionId,
    name: row.name,
    enabled: row.enabled,
    priority: row.priority,
    cooldownSeconds: row.cooldownSeconds,
    triggerCount: row._count.triggers,
    replyCount: row._count.replies,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDetail(row: DetailRow): WorkflowDetailView {
  const keyById = new Map(row.replies.map((reply) => [reply.id, replyKey(reply.position)]));
  return {
    id: row.id,
    platformConnectionId: row.platformConnectionId,
    name: row.name,
    enabled: row.enabled,
    priority: row.priority,
    cooldownSeconds: row.cooldownSeconds,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    triggers: row.triggers.map((trigger) => ({
      id: trigger.id,
      type: trigger.type,
      value: trigger.value,
      caseInsensitive: trigger.caseInsensitive,
      position: trigger.position,
    })),
    replies: row.replies.map((reply) => ({
      id: reply.id,
      key: replyKey(reply.position),
      position: reply.position,
      text: reply.text,
      parseMode: reply.parseMode,
      buttons: reply.buttons.map((button) => ({
        id: button.id,
        row: button.row,
        column: button.column,
        type: button.type,
        label: button.label,
        url: button.url,
        nextReplyId: button.nextReplyId,
        nextReplyKey: button.nextReplyId ? (keyById.get(button.nextReplyId) ?? null) : null,
      })),
    })),
  };
}

/**
 * Tenant-scoped workflow management. Every query filters by the actor's
 * tenant in addition to PostgreSQL RLS, so a missing policy alone cannot leak
 * or modify another tenant's rows. Cross-tenant ids surface as 404, never 403,
 * to avoid confirming that the id exists.
 */
export class WorkflowService {
  private readonly tx: () => TransactionClient;

  constructor(options: WorkflowServiceOptions = {}) {
    this.tx = options.transactionClient ?? requireTenantTransactionClient;
  }

  async list(actor: TenantActor, query: ListWorkflowsQuery): Promise<WorkflowPage> {
    const cursor = query.cursor ? decodeWorkflowCursor(query.cursor) : null;
    const rows = await this.tx().workflow.findMany({
      where: {
        tenantId: actor.tenantId,
        ...(query.platformConnectionId ? { platformConnectionId: query.platformConnectionId } : {}),
        ...(query.enabled !== undefined ? { enabled: query.enabled } : {}),
        ...(cursor
          ? {
              OR: [
                { priority: { gt: cursor.priority } },
                { priority: cursor.priority, id: { gt: cursor.id } },
              ],
            }
          : {}),
      },
      select: SUMMARY_SELECT,
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
      take: query.limit + 1,
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map(toSummary),
      nextCursor:
        hasMore && last ? encodeWorkflowCursor({ priority: last.priority, id: last.id }) : null,
    };
  }

  async get(actor: TenantActor, workflowId: string): Promise<WorkflowDetailView> {
    const row = await this.tx().workflow.findFirst({
      where: { id: workflowId, tenantId: actor.tenantId },
      select: DETAIL_SELECT,
    });
    if (!row) throw new NotFoundException('Workflow not found');
    return toDetail(row);
  }

  async create(actor: TenantActor, input: CreateWorkflowInput): Promise<WorkflowDetailView> {
    const tx = this.tx();
    const connection = await tx.platformConnection.findFirst({
      where: { id: input.platformConnectionId, tenantId: actor.tenantId },
      select: { id: true },
    });
    if (!connection) throw new NotFoundException('Connection not found');
    if (input.replies.some((reply) => reply.id)) {
      throw new BadRequestException('Reply ids cannot be supplied when creating a workflow');
    }

    const workflowId = randomUUID();
    await tx.workflow.create({
      data: {
        id: workflowId,
        tenantId: actor.tenantId,
        platformConnectionId: connection.id,
        name: input.name,
        enabled: input.enabled,
        priority: input.priority,
        cooldownSeconds: input.cooldownSeconds,
      },
      select: { id: true },
    });
    await this.writeDefinition(tx, actor.tenantId, workflowId, input, new Set());
    await this.audit(tx, actor, 'workflow.created', workflowId, {
      platformConnectionId: connection.id,
      triggerCount: input.triggers.length,
      replyCount: input.replies.length,
    });
    return this.get(actor, workflowId);
  }

  /**
   * Replaces triggers, replies and buttons atomically (the request runs in one
   * tenant transaction). Supplying an existing reply `id` keeps it stable so
   * inline keyboards already delivered to users keep resolving.
   */
  async replace(
    actor: TenantActor,
    workflowId: string,
    input: ReplaceWorkflowInput,
  ): Promise<WorkflowDetailView> {
    const tx = this.tx();
    const existing = await tx.workflow.findFirst({
      where: { id: workflowId, tenantId: actor.tenantId },
      select: { id: true, replies: { select: { id: true } } },
    });
    if (!existing) throw new NotFoundException('Workflow not found');

    const existingReplyIds = new Set(existing.replies.map((reply) => reply.id.toLowerCase()));
    for (const reply of input.replies) {
      if (reply.id && !existingReplyIds.has(reply.id.toLowerCase())) {
        throw new BadRequestException('Reply id does not belong to this workflow');
      }
    }

    await tx.workflow.updateMany({
      where: { id: workflowId, tenantId: actor.tenantId },
      data: {
        name: input.name,
        enabled: input.enabled,
        priority: input.priority,
        cooldownSeconds: input.cooldownSeconds,
      },
    });
    await this.deleteDefinition(tx, actor.tenantId, workflowId, [...existingReplyIds]);
    await this.writeDefinition(tx, actor.tenantId, workflowId, input, existingReplyIds);
    await this.audit(tx, actor, 'workflow.updated', workflowId, {
      triggerCount: input.triggers.length,
      replyCount: input.replies.length,
    });
    return this.get(actor, workflowId);
  }

  /** Metadata-only update; this is the enable/disable path. */
  async patch(
    actor: TenantActor,
    workflowId: string,
    input: PatchWorkflowInput,
  ): Promise<WorkflowDetailView> {
    const tx = this.tx();
    const data: Prisma.WorkflowUpdateManyMutationInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.enabled !== undefined) data.enabled = input.enabled;
    if (input.priority !== undefined) data.priority = input.priority;
    if (input.cooldownSeconds !== undefined) data.cooldownSeconds = input.cooldownSeconds;

    const { count } = await tx.workflow.updateMany({
      where: { id: workflowId, tenantId: actor.tenantId },
      data,
    });
    if (count === 0) throw new NotFoundException('Workflow not found');

    const action =
      input.enabled === true
        ? 'workflow.enabled'
        : input.enabled === false
          ? 'workflow.disabled'
          : 'workflow.updated';
    await this.audit(tx, actor, action, workflowId, { fields: Object.keys(data) });
    return this.get(actor, workflowId);
  }

  /**
   * Rewrites priorities to match `workflowIds` order (10, 20, 30, ...). The
   * list must be exactly the connection's workflows so no workflow keeps a
   * stale priority that interleaves unpredictably.
   */
  async reorder(actor: TenantActor, input: ReorderWorkflowsInput): Promise<ReorderResult> {
    const tx = this.tx();
    const connection = await tx.platformConnection.findFirst({
      where: { id: input.platformConnectionId, tenantId: actor.tenantId },
      select: { id: true },
    });
    if (!connection) throw new NotFoundException('Connection not found');

    const current = await tx.workflow.findMany({
      where: { tenantId: actor.tenantId, platformConnectionId: connection.id },
      select: { id: true, priority: true },
    });
    const currentPriority = new Map(current.map((row) => [row.id.toLowerCase(), row.priority]));
    const requested = input.workflowIds.map((id) => id.toLowerCase());
    if (
      requested.length !== currentPriority.size ||
      requested.some((id) => !currentPriority.has(id))
    ) {
      throw new BadRequestException(
        'workflowIds must list every workflow on the connection exactly once',
      );
    }

    const order = requested.map((id, index) => ({
      id,
      priority: (index + 1) * REORDER_PRIORITY_STEP,
    }));
    for (const entry of order) {
      if (currentPriority.get(entry.id) === entry.priority) continue;
      await tx.workflow.updateMany({
        where: { id: entry.id, tenantId: actor.tenantId },
        data: { priority: entry.priority },
      });
    }
    await this.audit(tx, actor, 'workflow.reordered', connection.id, { count: order.length });
    return { platformConnectionId: connection.id, order };
  }

  async delete(actor: TenantActor, workflowId: string): Promise<{ id: string }> {
    const tx = this.tx();
    const existing = await tx.workflow.findFirst({
      where: { id: workflowId, tenantId: actor.tenantId },
      select: { id: true, replies: { select: { id: true } } },
    });
    if (!existing) throw new NotFoundException('Workflow not found');

    await this.deleteDefinition(
      tx,
      actor.tenantId,
      workflowId,
      existing.replies.map((reply) => reply.id),
    );
    await tx.workflow.deleteMany({ where: { id: workflowId, tenantId: actor.tenantId } });
    await this.audit(tx, actor, 'workflow.deleted', workflowId, {});
    return { id: workflowId };
  }

  /**
   * Buttons go first: `next_reply_id` is ON DELETE SET NULL, and nulling it on
   * a CALLBACK button violates `workflow_reply_buttons_payload_matches_type_check`
   * if Postgres applies the SET NULL before the reply cascade removes the row.
   */
  private async deleteDefinition(
    tx: TransactionClient,
    tenantId: string,
    workflowId: string,
    replyIds: string[],
  ): Promise<void> {
    if (replyIds.length) {
      await tx.workflowReplyButton.deleteMany({ where: { tenantId, replyId: { in: replyIds } } });
    }
    await tx.workflowReply.deleteMany({ where: { tenantId, workflowId } });
    await tx.workflowTrigger.deleteMany({ where: { tenantId, workflowId } });
  }

  private async writeDefinition(
    tx: TransactionClient,
    tenantId: string,
    workflowId: string,
    definition: Definition,
    reusableReplyIds: ReadonlySet<string>,
  ): Promise<void> {
    await tx.workflowTrigger.createMany({
      data: definition.triggers.map((trigger, position) => ({
        tenantId,
        workflowId,
        type: trigger.type,
        value: 'value' in trigger ? trigger.value : null,
        caseInsensitive: 'caseInsensitive' in trigger ? trigger.caseInsensitive : true,
        position,
      })),
    });

    const idByKey = new Map<string, string>();
    const replies = definition.replies.map((reply, position) => {
      const reusable = reply.id?.toLowerCase();
      const id = reusable && reusableReplyIds.has(reusable) ? reusable : randomUUID();
      idByKey.set(reply.key, id);
      return { id, tenantId, workflowId, position, text: reply.text, parseMode: reply.parseMode };
    });
    await tx.workflowReply.createMany({ data: replies });

    const buttons: Prisma.WorkflowReplyButtonCreateManyInput[] = [];
    definition.replies.forEach((reply, index) => {
      const replyId = replies[index]?.id;
      if (!replyId) return;
      for (const button of reply.buttons) {
        const nextReplyId =
          button.type === 'CALLBACK' ? idByKey.get(button.nextReplyKey) : undefined;
        if (button.type === 'CALLBACK' && !nextReplyId) {
          // Schema validation guarantees resolvable keys; this guards future callers.
          throw new BadRequestException('Callback button references an unknown reply key');
        }
        buttons.push({
          tenantId,
          replyId,
          row: button.row,
          column: button.column,
          type: button.type,
          label: button.label,
          url: button.type === 'URL' ? button.url : null,
          nextReplyId: nextReplyId ?? null,
        });
      }
    });
    if (buttons.length) await tx.workflowReplyButton.createMany({ data: buttons });
  }

  private async audit(
    tx: TransactionClient,
    actor: TenantActor,
    action: string,
    entityId: string,
    metadata: Prisma.InputJsonObject,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action,
        entityType: action === 'workflow.reordered' ? 'platform_connection' : 'workflow',
        entityId,
        metadata,
      },
    });
  }
}
