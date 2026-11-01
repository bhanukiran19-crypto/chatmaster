import { Worker, Queue } from 'bullmq';
import { Redis as IORedis } from 'ioredis';
import type { PrismaClient } from '@chatmaster/db';
import type { EncryptionService } from '@chatmaster/crypto';
import {
  QUEUES,
  OUTBOUND_JOBS,
  type AnswerCallbackJobData,
  type InboundTelegramJobData,
  type OutboundTelegramJobData,
  type DeadLetterJobData,
  type TelegramApiClient,
} from '@chatmaster/shared';
import { InboundTelegramProcessor, type OutboundReplyQueue } from './inbound/inbound-processor.js';
import {
  OutboundTelegramProcessor,
  TelegramRateLimitError,
  type DeadLetterQueue,
} from './outbound/outbound-processor.js';
import { RedisCooldownService, ioredisCooldownStore } from './cooldown/cooldown-service.js';

type OutboundJobData = OutboundTelegramJobData | AnswerCallbackJobData;

/** Callback answers are useless after Telegram's ~15 s window, so don't retry long. */
const ANSWER_CALLBACK_ATTEMPTS = 2;
import { RedisChatRateLimiter } from './rate-limit/chat-rate-limiter.js';

export interface WorkerRunnerOptions {
  redisUrl?: string | undefined;
  prisma: PrismaClient;
  encryption: EncryptionService;
  telegramClient: TelegramApiClient;
}

export class ChatMasterWorkerRunner {
  private readonly redisClient: IORedis;
  private readonly inboundWorker: Worker<InboundTelegramJobData>;
  private readonly outboundWorker: Worker<OutboundJobData>;
  private readonly outboundQueue: Queue<OutboundJobData>;
  private readonly dlqQueue: Queue<DeadLetterJobData>;

  constructor(options: WorkerRunnerOptions) {
    const url = options.redisUrl ?? process.env['REDIS_URL'] ?? 'redis://localhost:6379';
    this.redisClient = new IORedis(url, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });

    const cooldownService = new RedisCooldownService(ioredisCooldownStore(this.redisClient));
    const chatRateLimiter = new RedisChatRateLimiter(url);

    this.outboundQueue = new Queue<OutboundJobData>(QUEUES.TELEGRAM_OUTBOUND, {
      connection: this.redisClient,
      defaultJobOptions: {
        attempts: 5,
        backoff: {
          type: 'telegramRateLimit',
          delay: 1000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    });

    this.dlqQueue = new Queue<DeadLetterJobData>(QUEUES.TELEGRAM_OUTBOUND_DLQ, {
      connection: this.redisClient,
    });

    const dlq: DeadLetterQueue = {
      sendToDlq: async (data) => {
        await this.dlqQueue.add('dead.letter', data);
      },
    };

    const outboundQueueProducer: OutboundReplyQueue = {
      enqueueReply: async (replyData) => {
        await this.outboundQueue.add(OUTBOUND_JOBS.REPLY, replyData);
      },
      enqueueAnswerCallback: async (data) => {
        await this.outboundQueue.add(OUTBOUND_JOBS.ANSWER_CALLBACK, data, {
          attempts: ANSWER_CALLBACK_ATTEMPTS,
        });
      },
    };

    const inboundProcessor = new InboundTelegramProcessor(
      options.prisma,
      cooldownService,
      outboundQueueProducer,
    );

    const outboundProcessor = new OutboundTelegramProcessor(
      options.prisma,
      options.encryption,
      options.telegramClient,
      chatRateLimiter,
      dlq,
    );

    // Inbound worker
    this.inboundWorker = new Worker<InboundTelegramJobData>(
      QUEUES.TELEGRAM_INBOUND,
      async (job) => {
        return inboundProcessor.processInboundJob(job.data);
      },
      {
        connection: this.redisClient,
        concurrency: 10,
      },
    );

    // Outbound worker with global rate limiter (~30 msgs/s) and custom 429 retry_after backoff
    this.outboundWorker = new Worker<OutboundJobData>(
      QUEUES.TELEGRAM_OUTBOUND,
      async (job) => {
        if (job.name === OUTBOUND_JOBS.ANSWER_CALLBACK) {
          return outboundProcessor.processAnswerCallbackJob(job.data as AnswerCallbackJobData);
        }
        return outboundProcessor.processOutboundJob(
          job.data as OutboundTelegramJobData,
          job.attemptsMade,
          job.opts.attempts ?? 5,
        );
      },
      {
        connection: this.redisClient,
        concurrency: 5,
        limiter: {
          max: 30,
          duration: 1000,
        },
        settings: {
          backoffStrategy: (attemptsMade: number, _type?: string, err?: Error) => {
            if (err instanceof TelegramRateLimitError) {
              return err.retryAfterSeconds * 1000;
            }
            return Math.min(1000 * Math.pow(2, attemptsMade), 60_000);
          },
        },
      },
    );
  }

  async close(): Promise<void> {
    await Promise.all([
      this.inboundWorker.close(),
      this.outboundWorker.close(),
      this.outboundQueue.close(),
      this.dlqQueue.close(),
    ]);
    this.redisClient.disconnect();
  }
}
