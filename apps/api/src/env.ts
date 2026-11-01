import { z } from 'zod';

const optionalUrl = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().url().optional(),
);
const optionalString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    DATABASE_URL: z.string().url(),
    AUTH_JWT_SECRET: z
      .string()
      .refine((value) => Buffer.byteLength(value, 'utf8') >= 32, 'Must contain at least 32 bytes'),
    AUTH_TOKEN_ISSUER: z.string().min(1).default('chatmaster-api'),
    AUTH_TOKEN_AUDIENCE: z.string().min(1).default('chatmaster-web'),
    WEB_APP_URL: z.string().url().default('http://localhost:3000'),
    KV_REST_API_URL: optionalUrl,
    KV_REST_API_TOKEN: optionalString,
    UPSTASH_REDIS_REST_URL: optionalUrl,
    UPSTASH_REDIS_REST_TOKEN: optionalString,
    REDIS_URL: optionalUrl,
    /** `"1:<base64 32-byte key>,2:<...>"`; parsed by @chatmaster/crypto loadKeyringFromEnv. */
    ENCRYPTION_KEYS: z.string().min(1),
    ENCRYPTION_ACTIVE_KEY_VERSION: optionalString,
    /** Public HTTPS origin Telegram can reach to deliver webhooks. */
    PUBLIC_API_URL: z.string().url(),
    TELEGRAM_API_BASE_URL: z.string().url().default('https://api.telegram.org'),
    TELEGRAM_API_TIMEOUT_MS: z.coerce.number().int().min(500).max(20_000).default(5_000),
  })
  .superRefine((env, context) => {
    const publicUrl = new URL(env.PUBLIC_API_URL);
    if (publicUrl.protocol !== 'https:' && env.NODE_ENV === 'production') {
      context.addIssue({
        code: 'custom',
        message: 'PUBLIC_API_URL must use HTTPS in production (Telegram requires HTTPS webhooks)',
        path: ['PUBLIC_API_URL'],
      });
    }
    if (publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password) {
      context.addIssue({
        code: 'custom',
        message: 'PUBLIC_API_URL must be a bare origin (optionally with a base path)',
        path: ['PUBLIC_API_URL'],
      });
    }
    if (!env.TELEGRAM_API_BASE_URL.startsWith('https://')) {
      context.addIssue({
        code: 'custom',
        message: 'TELEGRAM_API_BASE_URL must use HTTPS',
        path: ['TELEGRAM_API_BASE_URL'],
      });
    }
    const hasRestUrl = Boolean(env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL);
    const hasRestToken = Boolean(env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN);
    if (hasRestUrl !== hasRestToken) {
      context.addIssue({
        code: 'custom',
        message: 'Set both KV_REST_API_URL and KV_REST_API_TOKEN',
        path: ['KV_REST_API_URL'],
      });
    }
    const webProtocol = new URL(env.WEB_APP_URL).protocol;
    if (!['http:', 'https:'].includes(webProtocol)) {
      context.addIssue({
        code: 'custom',
        message: 'WEB_APP_URL must use HTTP or HTTPS',
        path: ['WEB_APP_URL'],
      });
    }
    if (env.NODE_ENV === 'production' && webProtocol !== 'https:') {
      context.addIssue({
        code: 'custom',
        message: 'WEB_APP_URL must use HTTPS in production',
        path: ['WEB_APP_URL'],
      });
    }
    if (
      !env.DATABASE_URL.startsWith('postgresql://') &&
      !env.DATABASE_URL.startsWith('postgres://')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'DATABASE_URL must be a PostgreSQL URL',
        path: ['DATABASE_URL'],
      });
    }
    const restUrl = env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL;
    if (restUrl && !restUrl.startsWith('https://')) {
      context.addIssue({
        code: 'custom',
        message: 'Upstash REST URL must use HTTPS',
        path: ['KV_REST_API_URL'],
      });
    }
    if (
      env.NODE_ENV === 'production' &&
      !hasRestUrl &&
      env.REDIS_URL &&
      !env.REDIS_URL.startsWith('rediss://')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'REDIS_URL must use TLS in production',
        path: ['REDIS_URL'],
      });
    }
    if (!hasRestUrl && !env.REDIS_URL) {
      context.addIssue({
        code: 'custom',
        message: 'Configure Upstash REST credentials or REDIS_URL',
        path: ['REDIS_URL'],
      });
    }
  });

export type ApiEnvironment = z.infer<typeof envSchema>;

export function loadApiEnvironment(): ApiEnvironment {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid API environment configuration:\n${issues.join('\n')}`);
  }
  return result.data;
}
