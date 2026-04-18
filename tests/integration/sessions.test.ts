import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { users, sessions } from '@/db/schema';
import { createSession, getSessionUser, deleteSession, rollIfStale, SESSION_TTL_SECONDS } from '@/services/sessions';

let userId: string;

beforeAll(async () => {
  await db.delete(sessions);
  await db.delete(users);
  const [u] = await db.insert(users).values({ email: 'a@b.com', username: 'abc' }).returning();
  userId = u!.id;
});

describe('sessions', () => {
  it('creates and reads a session', async () => {
    const sid = await createSession(userId);
    const s = await getSessionUser(sid);
    expect(s?.user.id).toBe(userId);
  });
  it('rolls expiry when stale', async () => {
    const sid = await createSession(userId);
    await db.update(sessions)
      .set({ expiresAt: new Date(Date.now() + 2 * 3600_000) })
      .where(eq(sessions.id, sid));
    await rollIfStale(sid);
    const s = await getSessionUser(sid);
    expect(s!.user.id).toBe(userId);
    expect(s!.session.expiresAt.getTime()).toBeGreaterThan(Date.now() + SESSION_TTL_SECONDS * 1000 - 10_000);
  });
  it('returns null for expired', async () => {
    const sid = await createSession(userId, -10);
    expect(await getSessionUser(sid)).toBeNull();
  });
  it('deletes', async () => {
    const sid = await createSession(userId);
    await deleteSession(sid);
    expect(await getSessionUser(sid)).toBeNull();
  });
});
