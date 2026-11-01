import { describe, expect, it, vi } from 'vitest';
import {
  HttpTelegramApiClient,
  TelegramApiError,
  TelegramUnavailableError,
} from '../src/platforms/telegram/telegram-api.client.js';

const TOKEN = '123456789:AAHfakeTokenValueForTests_0123456789abc';
const BASE = 'https://telegram.test';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function clientWith(fetchImpl: typeof fetch, timeoutMs = 1_000): HttpTelegramApiClient {
  return new HttpTelegramApiClient({ baseUrl: BASE, timeoutMs, fetchImpl });
}

describe('HttpTelegramApiClient', () => {
  it('calls getMe with the token in the path and maps the bot identity', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        ok: true,
        result: { id: 123456789, is_bot: true, username: 'my_bot', first_name: 'My Bot' },
      }),
    );

    const identity = await clientWith(fetchMock).getMe(TOKEN);

    expect(identity).toEqual({ id: 123456789, isBot: true, username: 'my_bot', firstName: 'My Bot' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/bot${TOKEN}/getMe`);
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends setWebhook with secret token, allowed updates and drop flag', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true, result: true }));

    await clientWith(fetchMock).setWebhook(TOKEN, {
      url: 'https://api.example.com/webhooks/telegram/abc',
      secretToken: 'secret-token',
      allowedUpdates: ['message', 'callback_query'],
      dropPendingUpdates: true,
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      url: 'https://api.example.com/webhooks/telegram/abc',
      secret_token: 'secret-token',
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
    });
  });

  it('throws TelegramApiError with a sanitised description on ok:false', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        { ok: false, error_code: 401, description: 'Unauthorized\u0007\n\u001b[31m' },
        { status: 401 },
      ),
    );

    const error = await clientWith(fetchMock).getMe(TOKEN).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TelegramApiError);
    const apiError = error as TelegramApiError;
    expect(apiError.errorCode).toBe(401);
    expect(apiError.description).toBe('Unauthorized[31m');
    expect(apiError.message).not.toContain(TOKEN);
  });

  it('surfaces retry_after on 429', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } },
        { status: 429 },
      ),
    );

    await expect(clientWith(fetchMock).deleteWebhook(TOKEN)).rejects.toMatchObject({
      errorCode: 429,
      retryAfterSeconds: 7,
    });
  });

  it('classifies a timeout distinctly from other network failures', async () => {
    const slowFetch: typeof fetch = (_url, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });

    const error = await clientWith(slowFetch, 50).getMe(TOKEN).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TelegramUnavailableError);
    expect((error as TelegramUnavailableError).reason).toBe('timeout');
  });

  it('never leaks the token through network error messages', async () => {
    const failingFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError(`fetch failed: ${BASE}/bot${TOKEN}/getMe`));

    const error = await clientWith(failingFetch).getMe(TOKEN).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TelegramUnavailableError);
    expect((error as Error).message).not.toContain(TOKEN);
    expect((error as TelegramUnavailableError).reason).toBe('network');
  });

  it.each([
    ['non-JSON body', new Response('<html>502</html>', { status: 502 })],
    ['JSON without envelope', jsonResponse({ hello: 'world' })],
    ['getMe result with wrong shape', jsonResponse({ ok: true, result: { id: 'x' } })],
  ])('treats %s as invalid_response', async (_label, response) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(clientWith(fetchMock).getMe(TOKEN)).rejects.toMatchObject({
      name: 'TelegramUnavailableError',
      reason: 'invalid_response',
    });
  });

  it('rejects oversized responses without buffering them', async () => {
    const huge = 'x'.repeat(70 * 1024);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(huge, { status: 200 }));

    await expect(clientWith(fetchMock).getMe(TOKEN)).rejects.toMatchObject({
      reason: 'invalid_response',
    });
  });

  it('refuses to build a URL from a non token-shaped string', async () => {
    const fetchMock = vi.fn<typeof fetch>();

    await expect(clientWith(fetchMock).getMe('../../admin')).rejects.toBeInstanceOf(TelegramApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
