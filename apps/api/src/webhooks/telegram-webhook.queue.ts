import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis as IORedis } from 'ioredis';
import { QUEUES, type InboundTelegramJobData } from '@chatmaster/shared';

export interface TelegramWebhookQueue {
  enqueueUpdate(jobData: InboundTelegramJobData): Promise<void>;
}

@Injectable()
export class BullMqTelegramWebhookQueue implements TelegramWebhookQueue, OnModuleDestroy {
  private readonly queue: Queue<InboundTelegramJobData> | null = null;
  private readonly redisClient: IORedis | null = null;
  public readonly inMemoryEnqueued: InboundTelegramJobData[] = [];

  constructor(redisUrl?: string) {
    const url = redisUrl ?? process.env['REDIS_URL'];
    if (url) {
      this.redisClient = new IORedis(url, {
        maxRetriesPerRequest: null, // Required by BullMQ
        lazyConnect: true,
      });

      this.queue = new Queue<InboundTelegramJobData>(QUEUES.TELEGRAM_INBOUND, {
        connection: this.redisClient,
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 1000,
          },
          removeOnComplete: true,
          removeOnFail: false,
        },
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.queue) {
      await this.queue.close();
    }
    if (this.redisClient) {
      this.redisClient.disconnect();
    }
  }

  async enqueueUpdate(jobData: InboundTelegramJobData): Promise<void> {
    if (this.queue) {
      await this.queue.add('telegram.update', jobData, {
        jobId: `${jobData.platformConnectionId}:${String(jobData.updateId)}`,
      });
      return;
    }

    // In-memory fallback
    this.inMemoryEnqueued.push(jobData);
  }
}
