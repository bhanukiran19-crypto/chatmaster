import pino from 'pino';
import { PrismaClient, createTenantPrismaClient } from '@chatmaster/db';
import {
  AesGcmEncryptionService,
  loadKeyringFromEnv,
} from '@chatmaster/crypto';
import { HttpTelegramApiClient } from '@chatmaster/shared';
import { ChatMasterWorkerRunner } from './queue-worker.js';

const logger = pino({
  level: process.env['NODE_ENV'] === 'development' ? 'debug' : 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
});

async function bootstrap(): Promise<void> {
  const encryptionKeys = process.env['ENCRYPTION_KEYS'];
  if (!encryptionKeys) {
    throw new Error('ENCRYPTION_KEYS environment variable is required');
  }

  const keyring = loadKeyringFromEnv(process.env);
  const encryption = new AesGcmEncryptionService(keyring);

  const prisma = createTenantPrismaClient(new PrismaClient());

  const telegramClient = new HttpTelegramApiClient({
    baseUrl: process.env['TELEGRAM_API_BASE_URL'] ?? 'https://api.telegram.org',
    timeoutMs: Number(process.env['TELEGRAM_API_TIMEOUT_MS'] ?? '5000'),
  });

  const runner = new ChatMasterWorkerRunner({
    prisma,
    encryption,
    telegramClient,
    redisUrl: process.env['REDIS_URL'] ?? undefined,
  });

  logger.info('ChatMaster BullMQ worker started');

  const shutdown = async () => {
    logger.info('Shutting down worker...');
    await runner.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void bootstrap().catch((err) => {
  logger.error(err, 'Worker startup failed');
  process.exit(1);
});
