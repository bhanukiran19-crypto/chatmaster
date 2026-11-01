import { Injectable, Logger } from '@nestjs/common';
import type { EmailProvider, SmsProvider } from './auth.contracts.js';

@Injectable()
export class ConsoleSmsProvider implements SmsProvider {
  private readonly logger = new Logger(ConsoleSmsProvider.name);

  async sendOtp(_phoneE164: string, _otp: string): Promise<void> {
    if (process.env['NODE_ENV'] === 'production')
      throw new Error('Console SMS provider is disabled in production');
    this.logger.log('Development SMS delivery requested; message content redacted');
  }
}

@Injectable()
export class ConsoleEmailProvider implements EmailProvider {
  private readonly logger = new Logger(ConsoleEmailProvider.name);

  async sendVerificationLink(_email: string, _link: string): Promise<void> {
    this.assertDevelopment();
    this.logger.log('Development verification email delivery requested; message content redacted');
  }

  async sendPasswordResetLink(_email: string, _link: string): Promise<void> {
    this.assertDevelopment();
    this.logger.log(
      'Development password reset email delivery requested; message content redacted',
    );
  }

  private assertDevelopment(): void {
    if (process.env['NODE_ENV'] === 'production')
      throw new Error('Console email provider is disabled in production');
  }
}
