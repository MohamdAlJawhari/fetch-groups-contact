import { z } from 'zod';

// An empty value (`TELEGRAM_API_ID=` in .env) counts as unset.
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(value => value === '' ? undefined : value, schema.optional());

const environmentSchema = z.object({
  DATABASE_URL: z.string().url().refine((value) => {
    try {
      const url = new URL(value);
      return ['postgres:', 'postgresql:'].includes(url.protocol)
        && Boolean(url.hostname) && url.pathname.length > 1;
    } catch {
      return false;
    }
  }, 'Must be a PostgreSQL URL with a hostname and database name'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  COOKIE_SECRET: z.string().min(32),
  CONNECTION_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  ADMIN_EMAIL: z.string().email().optional(),
  TELEGRAM_API_ID: optional(z.coerce.number().int().positive()),
  TELEGRAM_API_HASH: optional(z.string().regex(/^[0-9a-f]{32}$/i, 'Must be the 32-character hex api_hash from my.telegram.org')),
  WHATSAPP_PLATFORM: z.preprocess(value => value === '' ? undefined : value, z.enum(['baileys', 'fake']).default('baileys')),
}).superRefine((value, context) => {
  if (value.WHATSAPP_PLATFORM === 'fake' && value.NODE_ENV === 'production') {
    context.addIssue({ code: 'custom', path: ['WHATSAPP_PLATFORM'], message: 'Must be baileys in production' });
  }
  const hasId = value.TELEGRAM_API_ID !== undefined;
  const hasHash = value.TELEGRAM_API_HASH !== undefined;
  if (hasId !== hasHash) {
    context.addIssue({ code: 'custom', path: [hasId ? 'TELEGRAM_API_HASH' : 'TELEGRAM_API_ID'], message: 'Set both TELEGRAM_API_ID and TELEGRAM_API_HASH, or neither' });
  } else if (!hasId && value.NODE_ENV === 'production') {
    context.addIssue({ code: 'custom', path: ['TELEGRAM_API_ID'], message: 'Required in production (with TELEGRAM_API_HASH)' });
  }
});

export interface TelegramCredentials { apiId: number; apiHash: string }

/** Validates the environment. Error messages name the variables, never their values. */
export function parseEnvironment(environment: NodeJS.ProcessEnv) {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  const data = result.data;
  const telegram: TelegramCredentials | undefined = data.TELEGRAM_API_ID !== undefined && data.TELEGRAM_API_HASH !== undefined
    ? Object.freeze({ apiId: data.TELEGRAM_API_ID, apiHash: data.TELEGRAM_API_HASH }) : undefined;
  return Object.freeze({
    databaseUrl: data.DATABASE_URL,
    nodeEnv: data.NODE_ENV,
    port: data.PORT,
    cookieSecret: data.COOKIE_SECRET,
    connectionIdleTimeoutMs: data.CONNECTION_IDLE_TIMEOUT_MS,
    adminEmail: data.ADMIN_EMAIL,
    telegram,
    whatsappPlatform: data.WHATSAPP_PLATFORM,
  });
}
