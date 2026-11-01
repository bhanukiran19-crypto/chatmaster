import { z } from 'zod';

export const telegramUserSchema = z
  .object({
    id: z.number().int(),
    is_bot: z.boolean(),
    first_name: z.string().min(1),
    last_name: z.string().optional(),
    username: z.string().optional(),
    language_code: z.string().optional(),
  })
  .strict();

export const telegramChatSchema = z
  .object({
    id: z.union([z.number().int(), z.string()]),
    type: z.enum(['private', 'group', 'supergroup', 'channel']),
    title: z.string().optional(),
    username: z.string().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
  })
  .strict();

export const telegramMessageEntitySchema = z
  .object({
    type: z.string(),
    offset: z.number().int(),
    length: z.number().int(),
    url: z.string().optional(),
    user: telegramUserSchema.optional(),
    language: z.string().optional(),
    custom_emoji_id: z.string().optional(),
  })
  .strict();

export const telegramMessageSchema = z
  .object({
    message_id: z.number().int(),
    from: telegramUserSchema.optional(),
    sender_chat: telegramChatSchema.optional(),
    date: z.number().int(),
    chat: telegramChatSchema,
    text: z.string().optional(),
    caption: z.string().optional(),
    entities: z.array(telegramMessageEntitySchema).optional(),
    caption_entities: z.array(telegramMessageEntitySchema).optional(),
  })
  .strict();

export const telegramCallbackQuerySchema = z
  .object({
    id: z.string(),
    from: telegramUserSchema,
    message: telegramMessageSchema.optional(),
    inline_message_id: z.string().optional(),
    chat_instance: z.string().optional(),
    data: z.string().optional(),
    game_short_name: z.string().optional(),
  })
  .strict();

export const telegramUpdateSchema = z
  .object({
    update_id: z.number().int(),
    message: telegramMessageSchema.optional(),
    callback_query: telegramCallbackQuerySchema.optional(),
  })
  .strict();

export type TelegramUser = z.infer<typeof telegramUserSchema>;
export type TelegramChat = z.infer<typeof telegramChatSchema>;
export type TelegramMessage = z.infer<typeof telegramMessageSchema>;
export type TelegramCallbackQuery = z.infer<typeof telegramCallbackQuerySchema>;
export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;
