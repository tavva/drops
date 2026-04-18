// ABOUTME: Loads and validates environment configuration via zod.
// ABOUTME: Exposes a lazy `config` proxy so tests can swap process.env safely.
import { z } from 'zod';

const Schema = z.object({
  DATABASE_URL: z.string().url(),
  R2_ENDPOINT: z.string().url().optional(),
  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  ALLOWED_DOMAIN: z.string().regex(/^[a-z0-9.-]+$/, 'ALLOWED_DOMAIN must be a bare domain'),
  APP_ORIGIN: z.string().url(),
  CONTENT_ORIGIN: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['silent', 'trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof Schema>;

export function loadConfig(): Config {
  const parsed = Schema.parse(process.env);
  if (parsed.APP_ORIGIN === parsed.CONTENT_ORIGIN) {
    throw new Error('APP_ORIGIN and CONTENT_ORIGIN must differ');
  }
  return parsed;
}

let cached: Config | undefined;
export const config = new Proxy({} as Config, {
  get(_, key) { return (cached ??= loadConfig())[key as keyof Config]; },
});
