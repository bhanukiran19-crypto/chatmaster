import { Module } from '@nestjs/common';
import { AesGcmEncryptionService, loadKeyringFromEnv } from '@chatmaster/crypto';
import type { EncryptionService } from '@chatmaster/crypto';
import { AuthModule } from '../auth/auth.module.js';
import { loadApiEnvironment } from '../env.js';
import { TELEGRAM_API_CLIENT, TELEGRAM_CONNECTION_SERVICE, TOKEN_ENCRYPTION } from './platforms.tokens.js';
import { HttpTelegramApiClient, type TelegramApiClient } from './telegram/telegram-api.client.js';
import { TelegramConnectionService } from './telegram/telegram-connection.service.js';
import { TelegramController } from './telegram/telegram.controller.js';

@Module({
  imports: [AuthModule],
  controllers: [TelegramController],
  providers: [
    {
      provide: TOKEN_ENCRYPTION,
      useFactory: (): EncryptionService => {
        const env = loadApiEnvironment();
        return new AesGcmEncryptionService(
          loadKeyringFromEnv({
            ENCRYPTION_KEYS: env.ENCRYPTION_KEYS,
            ENCRYPTION_ACTIVE_KEY_VERSION: env.ENCRYPTION_ACTIVE_KEY_VERSION,
          }),
        );
      },
    },
    {
      provide: TELEGRAM_API_CLIENT,
      useFactory: (): TelegramApiClient => {
        const env = loadApiEnvironment();
        return new HttpTelegramApiClient({
          baseUrl: env.TELEGRAM_API_BASE_URL,
          timeoutMs: env.TELEGRAM_API_TIMEOUT_MS,
        });
      },
    },
    {
      provide: TELEGRAM_CONNECTION_SERVICE,
      useFactory: (telegram: TelegramApiClient, encryption: EncryptionService) =>
        new TelegramConnectionService(telegram, encryption, {
          publicApiUrl: loadApiEnvironment().PUBLIC_API_URL,
        }),
      inject: [TELEGRAM_API_CLIENT, TOKEN_ENCRYPTION],
    },
  ],
})
export class PlatformsModule {}
