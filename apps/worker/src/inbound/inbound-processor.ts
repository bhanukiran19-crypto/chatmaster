import { withTenantScope, type Prisma, type PrismaClient } from '@chatmaster/db';
import type {
  AnswerCallbackJobData,
  InboundTelegramJobData,
  OutboundTelegramJobData,
} from '@chatmaster/shared';
import {
  matchWorkflow,
  toInboundEvent,
  type InboundEvent,
  type MatchResult,
} from '../matching-engine/matcher.js';
import type { CooldownService } from '../cooldown/cooldown-service.js';

export interface OutboundReplyQueue {
  enqueueReply(replyData: OutboundTelegramJobData): Promise<void>;
  enqueueAnswerCallback(data: AnswerCallbackJobData): Promise<void>;
}

export type InboundSkipReason = 'duplicate' | 'unsupported_update' | 'no_match' | 'cooldown';

export interface InboundProcessResult {
  processed: boolean;
  matched: boolean;
  reason?: InboundSkipReason;
  workflowId?: string;
}

/** Toast shown when a pressed button no longer leads anywhere (edited, disabled or deleted). */
export const STALE_BUTTON_NOTICE = 'This option is no longer available.';

const WORKFLOW_SELECT = {
  id: true,
  enabled: true,
  priority: true,
  cooldownSeconds: true,
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

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

function toOutboundJob(
  job: InboundTelegramJobData,
  event: InboundEvent,
  match: MatchResult,
): OutboundTelegramJobData {
  return {
    tenantId: job.tenantId,
    platformConnectionId: job.platformConnectionId,
    chatId: event.chatId,
    text: match.reply.text,
    parseMode: match.reply.parseMode,
    buttons: match.reply.buttons.map((button) => ({
      row: button.row,
      column: button.column,
      type: button.type,
      label: button.label,
      ...(button.url ? { url: button.url } : {}),
      ...(button.nextReplyId ? { nextReplyId: button.nextReplyId } : {}),
    })),
    // Button presses get a fresh message rather than a quote of the bot's own message.
    ...(event.kind === 'message' ? { replyToMessageId: event.messageId } : {}),
    ...(event.kind === 'callback' ? { callbackQueryId: event.callbackQueryId } : {}),
    correlationUpdateId: job.updateId,
    workflowId: match.workflow.id,
    replyId: match.reply.id,
  };
}

export class InboundTelegramProcessor {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cooldownService: CooldownService,
    private readonly outboundQueue: OutboundReplyQueue,
  ) {}

  async processInboundJob(job: InboundTelegramJobData): Promise<InboundProcessResult> {
    const { tenantId, platformConnectionId, updateId, update } = job;

    return withTenantScope(this.prisma, { tenantId }, async (tx) => {
      // Idempotency backstop behind the Redis dedupe: unique (connection, update_id).
      try {
        await tx.processedUpdate.create({
          data: { tenantId, platformConnectionId, updateId: BigInt(updateId) },
        });
      } catch (error: unknown) {
        if (isUniqueViolation(error))
          return { processed: false, matched: false, reason: 'duplicate' };
        throw error;
      }

      const event = toInboundEvent(update);
      if (!event) return { processed: true, matched: false, reason: 'unsupported_update' };

      // Disabled workflows are excluded here and again inside the matcher.
      const workflows = await tx.workflow.findMany({
        where: { tenantId, platformConnectionId, enabled: true },
        select: WORKFLOW_SELECT,
        orderBy: [{ priority: 'asc' }, { id: 'asc' }],
      });

      const match = matchWorkflow(workflows, event);
      if (!match) {
        if (event.kind === 'callback') {
          // Telegram shows a spinner on the button until the query is answered.
          await this.outboundQueue.enqueueAnswerCallback({
            tenantId,
            platformConnectionId,
            callbackQueryId: event.callbackQueryId,
            text: STALE_BUTTON_NOTICE,
          });
        }
        return { processed: true, matched: false, reason: 'no_match' };
      }

      // Cooldown guards trigger-initiated replies against spam/loops. Button
      // presses are explicit navigation and are paced by the per-chat send limiter.
      const usesCooldown = match.kind === 'trigger' && match.workflow.cooldownSeconds > 0;
      if (usesCooldown) {
        const acquired = await this.cooldownService.tryAcquire(
          match.workflow.id,
          event.chatId,
          match.workflow.cooldownSeconds,
        );
        if (!acquired) {
          return {
            processed: true,
            matched: true,
            reason: 'cooldown',
            workflowId: match.workflow.id,
          };
        }
      }

      try {
        await this.outboundQueue.enqueueReply(toOutboundJob(job, event, match));
      } catch (error) {
        if (usesCooldown) await this.cooldownService.release(match.workflow.id, event.chatId);
        throw error;
      }

      return { processed: true, matched: true, workflowId: match.workflow.id };
    });
  }
}
