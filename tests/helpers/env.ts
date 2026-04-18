// ABOUTME: Populates process.env with deterministic test values.
// ABOUTME: Imported via vitest setupFiles so every worker gets the same environment.
export const TEST_ENV = {
  DATABASE_URL: 'postgres://drops:drops@localhost:55432/drops_test',
  R2_ENDPOINT: 'http://localhost:9000',
  R2_ACCOUNT_ID: 'minio',
  R2_ACCESS_KEY_ID: 'minioadmin',
  R2_SECRET_ACCESS_KEY: 'minioadmin',
  R2_BUCKET: 'drops-test',
  GOOGLE_CLIENT_ID: 'test-client-id',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  SESSION_SECRET: 's'.repeat(64),
  ALLOWED_DOMAIN: 'drops.global',
  APP_ORIGIN: 'http://drops.localtest.me:3000',
  CONTENT_ORIGIN: 'http://content.localtest.me:3000',
  PORT: '3000',
  LOG_LEVEL: 'silent',
};

for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v;
