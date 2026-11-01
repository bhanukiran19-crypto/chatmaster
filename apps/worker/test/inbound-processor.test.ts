/* eslint-disable @typescript-eslint/require-await -- in-memory fakes mirror async Prisma/Redis/BullMQ APIs */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@chatmaster/db';
import type {
  AnswerCallbackJobData,
  InboundTelegramJobData,
  OutboundTelegramJobData,
  TelegramUpdate,
} from '@chatmaster/shared';
import {
  InboundTelegramProcessor,
  STALE_BUTTON_NOTICE,
  type OutboundReplyQueue,
} from '../src/inbound/inbound-processor.js';
import { RedisCooldownService, type CooldownStore } from '../src/cooldown/cooldown-service.js';
import type { WorkflowView } from '../src/matching-engine/matcher.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CONN_ID = '22222222-2222-4222-8222-222222222222';
const R_WELCOME = '30000000-0000-4000-8000-000000000001';
const R_PRICING = '30000000-0000-4000-8000-000000000002';

/** Mimics Redis SET NX EX with a controllable clock. */
class FakeCooldownStore implements CooldownStore {
  now = 0;
  readonly expiries = new Map<string, number>();
  async setIfAbsent(key: string, ttlSeconds: number): Promise<boolean> {
    const expiry = this.expiries.get(key);
    if (expiry !== undefined && expiry > this.now) return false;
    this.expiries.set(key, this.now + ttlSeconds * 1000);
    return true;
  }
  async delete(key: string): Promise<void> {
    this.expiries.delete(key);
  }
}

function welcomeWorkflow(partial: Partial<WorkflowView> = {}): WorkflowView {
  return {
    id: 'wf-welcome',
    enabled: true,
    priority: 10,
    cooldownSeconds: 30,
    triggers: [{ id: 'tr-1', type: 'START', value: null, caseInsensitive: true, position: 0 }],
    replies: [
      {
        id: R_WELCOME,
        position: 0,
        text: 'Welcome to ChatMaster!',
        parseMode: 'NONE',
        buttons: [
          {
            id: 'b-url',
            row: 0,
            column: 0,
            type: 'URL',
            label: 'Website',
            url: 'https://example.com',
            nextReplyId: null,
          },
          {
            id: 'b-cb',
            row: 1,
            column: 0,
            type: 'CALLBACK',
            label: 'Pricing',
            url: null,
            nextReplyId: R_PRICING,
          },
        ],
      },
      { id: R_PRICING, position: 1, text: 'Pricing details', parseMode: 'HTML', buttons: [] },
    ],
    ...partial,
  };
}

const catchAll: WorkflowView = {
  id: 'wf-catch-all',
  enabled: true,
  priority: 1000,
  cooldownSeconds: 0,
  triggers: [{ id: 'tr-any', type: 'ANY', value: null, caseInsensitive: true, position: 0 }],
  replies: [
    {
      id: '30000000-0000-4000-8000-0000000000ff',
      position: 0,
      text: 'Fallback',
      parseMode: 'NONE',
      buttons: [],
    },
  ],
};

let nextUpdateId = 5000;

function messageJob(text: string, chatId = 99999): InboundTelegramJobData {
  nextUpdateId += 1;
  return {
    tenantId: TENANT_ID,
    platformConnectionId: CONN_ID,
    botId: '123456',
    updateId: nextUpdateId,
    update: {
      update_id: nextUpdateId,
      message: { message_id: 10, date: 1_700_000_000, chat: { id: chatId, type: 'private' }, text },
    },
    receivedAt: new Date().toISOString(),
  };
}

function callbackJob(data: string, chatId = 99999): InboundTelegramJobData {
  nextUpdateId += 1;
  const update: TelegramUpdate = {
    update_id: nextUpdateId,
    callback_query: {
      id: `cbq-${String(nextUpdateId)}`,
      from: { id: chatId, is_bot: false, first_name: 'U' },
      data,
      message: { message_id: 77, date: 1_700_000_000, chat: { id: chatId, type: 'private' } },
    },
  };
  return {
    tenantId: TENANT_ID,
    platformConnectionId: CONN_ID,
    botId: '123456',
    updateId: nextUpdateId,
    update,
    receivedAt: new Date().toISOString(),
  };
}

describe('InboundTelegramProcessor', () => {
  let workflows: WorkflowView[];
  let processed: Set<string>;
  let replies: OutboundTelegramJobData[];
  let answers: AnswerCallbackJobData[];
  let store: FakeCooldownStore;
  let queue: OutboundReplyQueue;
  let failNextEnqueue: Error | null;
  let tx: {
    $queryRaw: ReturnType<typeof vi.fn>;
    processedUpdate: { create: ReturnType<typeof vi.fn> };
    workflow: { findMany: ReturnType<typeof vi.fn> };
  };
  let processor: InboundTelegramProcessor;

  beforeEach(() => {
    workflows = [welcomeWorkflow()];
    processed = new Set();
    replies = [];
    answers = [];
    store = new FakeCooldownStore();
    failNextEnqueue = null;
    queue = {
      enqueueReply: vi.fn(async (job: OutboundTelegramJobData) => {
        if (failNextEnqueue) {
          const error = failNextEnqueue;
          failNextEnqueue = null;
          throw error;
        }
        replies.push(job);
      }),
      enqueueAnswerCallback: vi.fn(async (job: AnswerCallbackJobData) => {
        answers.push(job);
      }),
    };
    tx = {
      $queryRaw: vi.fn(async () => []),
      processedUpdate: {
        create: vi.fn(
          async ({ data }: { data: { platformConnectionId: string; updateId: bigint } }) => {
            const key = `${data.platformConnectionId}:${data.updateId.toString()}`;
            if (processed.has(key))
              throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
            processed.add(key);
            return { id: 'pu', ...data };
          },
        ),
      },
      workflow: { findMany: vi.fn(async () => workflows) },
    };
    const prisma = {
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaClient;
    processor = new InboundTelegramProcessor(prisma, new RedisCooldownService(store), queue);
  });

  it('records the update and enqueues the matched reply with buttons', async () => {
    const job = messageJob('/start');
    const result = await processor.processInboundJob(job);

    expect(result).toEqual({ processed: true, matched: true, workflowId: 'wf-welcome' });
    expect(tx.processedUpdate.create).toHaveBeenCalledWith({
      data: { tenantId: TENANT_ID, platformConnectionId: CONN_ID, updateId: BigInt(job.updateId) },
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      tenantId: TENANT_ID,
      platformConnectionId: CONN_ID,
      chatId: '99999',
      text: 'Welcome to ChatMaster!',
      replyToMessageId: 10,
      correlationUpdateId: job.updateId,
      workflowId: 'wf-welcome',
      replyId: R_WELCOME,
      buttons: [
        { row: 0, column: 0, type: 'URL', label: 'Website', url: 'https://example.com' },
        { row: 1, column: 0, type: 'CALLBACK', label: 'Pricing', nextReplyId: R_PRICING },
      ],
    });
    expect(replies[0]?.callbackQueryId).toBeUndefined();
  });

  it('only loads enabled workflows for this tenant and connection, in priority order', async () => {
    await processor.processInboundJob(messageJob('/start'));
    expect(tx.workflow.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT_ID, platformConnectionId: CONN_ID, enabled: true },
        orderBy: [{ priority: 'asc' }, { id: 'asc' }],
      }),
    );
  });

  it('skips duplicate deliveries via the processed_updates unique constraint', async () => {
    const job = messageJob('/start');
    await processor.processInboundJob(job);
    const duplicate = await processor.processInboundJob(job);

    expect(duplicate).toEqual({ processed: false, matched: false, reason: 'duplicate' });
    expect(replies).toHaveLength(1);
    expect(tx.workflow.findMany).toHaveBeenCalledTimes(1);
  });

  it('reports no_match without enqueueing anything for unmatched text', async () => {
    const result = await processor.processInboundJob(messageJob('unmatched'));
    expect(result).toEqual({ processed: true, matched: false, reason: 'no_match' });
    expect(replies).toHaveLength(0);
    expect(answers).toHaveLength(0);
  });

  it('ignores update kinds the engine does not handle', async () => {
    nextUpdateId += 1;
    const result = await processor.processInboundJob({
      ...messageJob('x'),
      updateId: nextUpdateId,
      update: { update_id: nextUpdateId },
    });
    expect(result).toEqual({ processed: true, matched: false, reason: 'unsupported_update' });
    expect(tx.workflow.findMany).not.toHaveBeenCalled();
  });

  describe('per-chat cooldown', () => {
    it('suppresses a repeat trigger in the same chat inside the window', async () => {
      await processor.processInboundJob(messageJob('/start'));
      const second = await processor.processInboundJob(messageJob('/start'));

      expect(second).toEqual({
        processed: true,
        matched: true,
        reason: 'cooldown',
        workflowId: 'wf-welcome',
      });
      expect(replies).toHaveLength(1);
    });

    it('does not fall through to a lower-priority catch-all while cooling down', async () => {
      workflows = [welcomeWorkflow(), catchAll];
      await processor.processInboundJob(messageJob('/start'));
      await processor.processInboundJob(messageJob('/start'));

      expect(replies.map((reply) => reply.workflowId)).toEqual(['wf-welcome']);
    });

    it('is scoped per chat', async () => {
      await processor.processInboundJob(messageJob('/start', 1));
      await processor.processInboundJob(messageJob('/start', 2));
      expect(replies.map((reply) => reply.chatId)).toEqual(['1', '2']);
    });

    it('is scoped per workflow', async () => {
      workflows = [welcomeWorkflow(), { ...catchAll, cooldownSeconds: 30 }];
      await processor.processInboundJob(messageJob('/start'));
      await processor.processInboundJob(messageJob('hello'));
      expect(replies.map((reply) => reply.workflowId)).toEqual(['wf-welcome', 'wf-catch-all']);
    });

    it('allows the workflow again once the window expires', async () => {
      await processor.processInboundJob(messageJob('/start'));
      store.now += 30_001;
      await processor.processInboundJob(messageJob('/start'));
      expect(replies).toHaveLength(2);
    });

    it('never applies when cooldownSeconds is 0', async () => {
      workflows = [welcomeWorkflow({ cooldownSeconds: 0 })];
      await processor.processInboundJob(messageJob('/start'));
      await processor.processInboundJob(messageJob('/start'));
      expect(replies).toHaveLength(2);
      expect(store.expiries.size).toBe(0);
    });

    it('releases the window when the reply cannot be enqueued, so a retry can reply', async () => {
      failNextEnqueue = new Error('redis down');
      await expect(processor.processInboundJob(messageJob('/start'))).rejects.toThrow('redis down');
      expect(store.expiries.size).toBe(0);

      await processor.processInboundJob(messageJob('/start'));
      expect(replies).toHaveLength(1);
    });
  });

  describe('callback_query (inline buttons)', () => {
    it('enqueues the chained reply with the callback id and no quote', async () => {
      const job = callbackJob(`r:${R_PRICING}`);
      const result = await processor.processInboundJob(job);

      expect(result).toEqual({ processed: true, matched: true, workflowId: 'wf-welcome' });
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({
        chatId: '99999',
        text: 'Pricing details',
        parseMode: 'HTML',
        replyId: R_PRICING,
        callbackQueryId: `cbq-${String(job.updateId)}`,
      });
      expect(replies[0]?.replyToMessageId).toBeUndefined();
      expect(answers).toHaveLength(0);
    });

    it('is not blocked by the trigger cooldown', async () => {
      await processor.processInboundJob(messageJob('/start'));
      await processor.processInboundJob(callbackJob(`r:${R_PRICING}`));
      await processor.processInboundJob(callbackJob(`r:${R_PRICING}`));
      expect(replies.map((reply) => reply.replyId)).toEqual([R_WELCOME, R_PRICING, R_PRICING]);
    });

    it('answers stale or forged presses with a notice instead of a reply', async () => {
      for (const data of [`r:${R_WELCOME}`, 'r:30000000-0000-4000-8000-000000000999', 'garbage']) {
        const job = callbackJob(data);
        const result = await processor.processInboundJob(job);
        expect(result).toMatchObject({ matched: false, reason: 'no_match' });
        expect(answers.at(-1)).toEqual({
          tenantId: TENANT_ID,
          platformConnectionId: CONN_ID,
          callbackQueryId: `cbq-${String(job.updateId)}`,
          text: STALE_BUTTON_NOTICE,
        });
      }
      expect(replies).toHaveLength(0);
    });

    it('answers presses on buttons whose workflow was disabled', async () => {
      workflows = [welcomeWorkflow({ enabled: false })];
      await processor.processInboundJob(callbackJob(`r:${R_PRICING}`));
      expect(replies).toHaveLength(0);
      expect(answers).toHaveLength(1);
    });
  });
});
