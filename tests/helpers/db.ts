// ABOUTME: Integration-test fixtures: (re)create the per-run test database and apply migrations.
// ABOUTME: setupTestDatabase/teardownTestDatabase run once per vitest run via the global-setup file.
import './env';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import * as schema from '@/db/schema';
import { TEST_DB_NAME } from './testDbName';

const ROOT_URL = 'postgres://drops:drops@localhost:55432/postgres';

export async function setupTestDatabase() {
  const rootSql = postgres(ROOT_URL, { prepare: false });
  try {
    await rootSql.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}" WITH (FORCE)`);
    await rootSql.unsafe(`CREATE DATABASE "${TEST_DB_NAME}"`);
  } finally {
    await rootSql.end();
  }
  const conn = postgres(process.env.DATABASE_URL!, { prepare: false });
  const db = drizzle(conn, { schema });
  await migrate(db, { migrationsFolder: 'src/db/migrations' });
  await conn.end();
}

export async function teardownTestDatabase() {
  const rootSql = postgres(ROOT_URL, { prepare: false });
  try {
    await rootSql.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}" WITH (FORCE)`);
  } finally {
    await rootSql.end();
  }
}
