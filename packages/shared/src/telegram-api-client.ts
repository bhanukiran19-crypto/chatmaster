import { z } from 'zod';

export interface TelegramBotIdentity {
  readonly id: number;
  readonly isBot: boolean;
  readonly username: string;
  readonly firstName: string;
}

export interface SetWebhookInput {
  readonly url: string;
  readonly secretToken: string;
  readonly allowedUpdates: readonly string[];
  readonly dropPendingUpdates?: boolean | undefined;
}

export interface InlineKeyboardButton {
  readonly text: string;
  readonly url?: string | undefined;
  readonly callback_data?: string | undefined;
}

export interface SendMessageInput {
  readonly chatId: string | number;
  readonly text: string;
  readonly parseMode?: 'HTML' | 'MarkdownV2' | 'Markdown' | undefined;
  readonly replyToMessageId?: number | undefined;
  readonly replyMarkup?:
    | {
        readonly inline_keyboard?: ReadonlyArray<ReadonlyArray<InlineKeyboardButton>> | undefined;
      }
    | undefined;
}

export interface SendMessageResult {
  readonly messageId: number;
}

export interface AnswerCallbackQueryInput {
  readonly callbackQueryId: string;
  /** Optional toast shown to the user (Telegram allows 0-200 characters). */
  readonly text?: string | undefined;
}

export interface TelegramApiClient {
  getMe(botToken: string): Promise<TelegramBotIdentity>;
  setWebhook(botToken: string, input: SetWebhookInput): Promise<void>;
  deleteWebhook(botToken: string): Promise<void>;
  sendMessage(botToken: string, input: SendMessageInput): Promise<SendMessageResult>;
  answerCallbackQuery(botToken: string, input: AnswerCallbackQueryInput): Promise<void>;
}

const MAX_CALLBACK_ANSWER_LENGTH = 200;

/** Telegram responded with `ok: false`. `description` is sanitised and token-free. */
export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly errorCode: number,
    readonly description: string,
    readonly retryAfterSeconds?: number | undefined,
  ) {
    super(`Telegram ${method} failed with ${String(errorCode)}`);
    this.name = 'TelegramApiError';
  }
}

export type TelegramUnavailableReason = 'timeout' | 'network' | 'invalid_response';

/** Telegram could not be reached or returned something that is not a Bot API envelope. */
export class TelegramUnavailableError extends Error {
  constructor(
    readonly method: string,
    readonly reason: TelegramUnavailableReason,
  ) {
    super(`Telegram ${method} unavailable (${reason})`);
    this.name = 'TelegramUnavailableError';
  }
}

export interface HttpTelegramApiClientOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch | undefined;
}

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_DESCRIPTION_LENGTH = 256;
const BOT_TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,64}$/;

const envelopeSchema = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error_code: z.number().int(),
    description: z.string().optional(),
    parameters: z.object({ retry_after: z.number().int().optional() }).partial().optional(),
  }),
]);

const getMeResultSchema = z.object({
  id: z.number().int().positive(),
  is_bot: z.boolean(),
  username: z.string().min(1).max(64),
  first_name: z.string().max(256).default(''),
});

const sendMessageResultSchema = z.object({
  message_id: z.number().int(),
});

/** Keeps only printable ASCII so stored/logged descriptions cannot carry control characters. */
function sanitizeDescription(raw: string | undefined): string {
  if (!raw) return 'Unknown error';
  const cleaned = raw.replace(/[^\x20-\x7e]/g, '').trim();
  return cleaned.slice(0, MAX_DESCRIPTION_LENGTH) || 'Unknown error';
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

async function readBounded(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > limit) throw new Error('response too large');
  if (!response.body) return response.text();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error('response too large');
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

export class HttpTelegramApiClient implements TelegramApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpTelegramApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async getMe(botToken: string): Promise<TelegramBotIdentity> {
    const result = await this.call('getMe', botToken, {});
    const parsed = getMeResultSchema.safeParse(result);
    if (!parsed.success) throw new TelegramUnavailableError('getMe', 'invalid_response');
    return {
      id: parsed.data.id,
      isBot: parsed.data.is_bot,
      username: parsed.data.username,
      firstName: parsed.data.first_name,
    };
  }

  async setWebhook(botToken: string, input: SetWebhookInput): Promise<void> {
    await this.call('setWebhook', botToken, {
      url: input.url,
      secret_token: input.secretToken,
      allowed_updates: [...input.allowedUpdates],
      drop_pending_updates: input.dropPendingUpdates ?? false,
    });
  }

  async deleteWebhook(botToken: string): Promise<void> {
    await this.call('deleteWebhook', botToken, { drop_pending_updates: false });
  }

  async sendMessage(botToken: string, input: SendMessageInput): Promise<SendMessageResult> {
    const body: Record<string, unknown> = {
      chat_id: input.chatId,
      text: input.text,
    };
    if (input.parseMode) {
      body['parse_mode'] = input.parseMode;
    }
    if (input.replyToMessageId) {
      body['reply_to_message_id'] = input.replyToMessageId;
    }
    if (input.replyMarkup) {
      body['reply_markup'] = input.replyMarkup;
    }

    const result = await this.call('sendMessage', botToken, body);
    const parsed = sendMessageResultSchema.safeParse(result);
    if (!parsed.success) throw new TelegramUnavailableError('sendMessage', 'invalid_response');
    return {
      messageId: parsed.data.message_id,
    };
  }

  async answerCallbackQuery(botToken: string, input: AnswerCallbackQueryInput): Promise<void> {
    const body: Record<string, unknown> = { callback_query_id: input.callbackQueryId };
    if (input.text) body['text'] = input.text.slice(0, MAX_CALLBACK_ANSWER_LENGTH);
    await this.call('answerCallbackQuery', botToken, body);
  }

  private async call(
    method: string,
    botToken: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    if (!BOT_TOKEN_RE.test(botToken)) {
      // Refuse to build a URL from anything that is not token-shaped.
      throw new TelegramApiError(method, 401, 'Unauthorized');
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/bot${botToken}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      throw new TelegramUnavailableError(method, isTimeout(error) ? 'timeout' : 'network');
    }

    let text: string;
    try {
      text = await readBounded(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      throw new TelegramUnavailableError(method, isTimeout(error) ? 'timeout' : 'invalid_response');
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new TelegramUnavailableError(method, 'invalid_response');
    }
    const envelope = envelopeSchema.safeParse(json);
    if (!envelope.success) throw new TelegramUnavailableError(method, 'invalid_response');

    if (!envelope.data.ok) {
      throw new TelegramApiError(
        method,
        envelope.data.error_code,
        sanitizeDescription(envelope.data.description),
        envelope.data.parameters?.retry_after,
      );
    }
    return envelope.data.result;
  }
}
