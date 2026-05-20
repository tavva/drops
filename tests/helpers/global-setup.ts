// ABOUTME: Vitest global-setup hook: names a unique database per run, builds it, drops it on teardown.
// ABOUTME: Sets TEST_DB_NAME before importing db so forked workers inherit the same name and concurrent runs don't collide.
import { randomBytes } from 'node:crypto';

export default async function globalSetup() {
  process.env.TEST_DB_NAME = `drops_test_${process.pid}_${randomBytes(3).toString('hex')}`;
  const { setupTestDatabase, teardownTestDatabase } = await import('./db');
  await setupTestDatabase();
  return async () => {
    await teardownTestDatabase();
  };
}
