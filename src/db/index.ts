// ABOUTME: Postgres connection and Drizzle ORM instance, keyed off DATABASE_URL.
// ABOUTME: `prepare: false` keeps postgres.js compatible with pg_bouncer-style poolers.
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { config } from '@/config';
import * as schema from './schema';

export const sql = postgres(config.DATABASE_URL, { prepare: false });
export const db = drizzle(sql, { schema });
export type DB = typeof db;
