// ABOUTME: CLI entry point that applies Drizzle migrations and exits.
// ABOUTME: Run via `pnpm db:migrate` locally and as part of the Docker CMD in production.
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, sql } from './index';

async function main() {
  await migrate(db, { migrationsFolder: 'src/db/migrations' });
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
