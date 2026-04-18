// ABOUTME: Integration-test fixtures: (re)creates drops_test database and applies migrations.
// ABOUTME: setupTestDatabase is called once per vitest run via the global-setup file.
import './env';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import * as schema from '@/db/schema';

const ROOT_URL = 'postgres://drops:drops@localhost:55432/postgres';

export async function setupTestDatabase() {
  const rootSql = postgres(ROOT_URL, { prepare: false });
  try {
    await rootSql`DROP DATABASE IF EXISTS drops_test WITH (FORCE)`;
    await rootSql`CREATE DATABASE drops_test`;
  } finally {
    await rootSql.end();
  }
  const conn = postgres(process.env.DATABASE_URL!, { prepare: false });
  const db = drizzle(conn, { schema });
  await migrate(db, { migrationsFolder: 'src/db/migrations' });
  await conn.end();
}
