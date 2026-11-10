import 'dotenv/config';
import { z } from 'zod';

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
});

const result = environmentSchema.safeParse(process.env);
if (!result.success) {
  const details = result.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${details}`);
}

export const config = Object.freeze({
  databaseUrl: result.data.DATABASE_URL,
  nodeEnv: result.data.NODE_ENV,
  port: result.data.PORT,
  cookieSecret: result.data.COOKIE_SECRET,
  connectionIdleTimeoutMs: result.data.CONNECTION_IDLE_TIMEOUT_MS,
  adminEmail: result.data.ADMIN_EMAIL,
});
