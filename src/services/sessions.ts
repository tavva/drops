// ABOUTME: Session storage for app-host authentication. 30-day TTL with sliding rolls when >24h has passed.
// ABOUTME: Session ids are 256-bit random values, base64url-encoded, stored verbatim in the DB.
import { randomBytes } from 'node:crypto';
import { eq, and, gt } from 'drizzle-orm';
import { db } from '@/db';
import { sessions, users } from '@/db/schema';

export const SESSION_TTL_SECONDS = 30 * 24 * 3600;
const ROLL_WHEN_REMAINING_BELOW_SECONDS = 29 * 24 * 3600;

export async function createSession(userId: string, ttlOverrideSeconds?: number): Promise<string> {
  const id = randomBytes(32).toString('base64url');
  const ttl = ttlOverrideSeconds ?? SESSION_TTL_SECONDS;
  await db.insert(sessions).values({
    id, userId, expiresAt: new Date(Date.now() + ttl * 1000),
  });
  return id;
}

export async function getSessionUser(id: string) {
  const rows = await db.select({ s: sessions, u: users })
    .from(sessions).innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())));
  const r = rows[0];
  return r ? { session: r.s, user: r.u } : null;
}

export async function rollIfStale(id: string): Promise<void> {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
  if (!row) return;
  const remainingSec = (row.expiresAt.getTime() - Date.now()) / 1000;
  if (remainingSec < ROLL_WHEN_REMAINING_BELOW_SECONDS) {
    await db.update(sessions)
      .set({ expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000) })
      .where(eq(sessions.id, id));
  }
}

export async function deleteSession(id: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, id));
}
