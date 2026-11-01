import { z } from 'zod';

/** Telegram bot tokens look like `123456789:AAH...` (numeric bot id, colon, 35-char secret). */
export const botTokenSchema = z
  .string()
  .trim()
  .regex(/^\d{6,12}:[A-Za-z0-9_-]{30,64}$/, 'Not a Telegram bot token');

export const connectTelegramSchema = z.object({ botToken: botTokenSchema }).strict();

export const connectionIdSchema = z.string().uuid();
