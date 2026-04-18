// ABOUTME: User CRUD with email-normalisation and typed conflict errors for duplicate username/email.
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { users } from '@/db/schema';

export class UserConflictError extends Error {
  constructor(public readonly field: 'email' | 'username') {
    super(`${field} is already taken`);
    this.name = 'UserConflictError';
  }
}

export interface NewUser {
  email: string;
  username: string;
  name: string | null;
  avatarUrl: string | null;
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findByEmail(email: string) {
  const rows = await db.select().from(users).where(eq(users.email, normaliseEmail(email)));
  return rows[0] ?? null;
}

export async function findByUsername(username: string) {
  const rows = await db.select().from(users).where(eq(users.username, username));
  return rows[0] ?? null;
}

export async function isUsernameTaken(username: string): Promise<boolean> {
  const rows = await db.select({ one: sql<number>`1` }).from(users).where(eq(users.username, username)).limit(1);
  return rows.length > 0;
}

export async function createUser(input: NewUser) {
  try {
    const [row] = await db.insert(users).values({
      email: normaliseEmail(input.email),
      username: input.username,
      name: input.name,
      avatarUrl: input.avatarUrl,
    }).returning();
    return row!;
  } catch (e: unknown) {
    const pg = pgErrorFrom(e);
    if (pg?.code === '23505') {
      const c = pg.constraint_name ?? pg.constraint ?? '';
      if (c.includes('username')) throw new UserConflictError('username');
      if (c.includes('email')) throw new UserConflictError('email');
      throw new UserConflictError('username');
    }
    throw e;
  }
}

function pgErrorFrom(e: unknown): { code?: string; constraint_name?: string; constraint?: string } | null {
  const visited = new Set<unknown>();
  let cur: unknown = e;
  while (cur && typeof cur === 'object' && !visited.has(cur)) {
    visited.add(cur);
    const obj = cur as { code?: string; cause?: unknown };
    if (obj.code) return obj as never;
    cur = obj.cause;
  }
  return null;
}
