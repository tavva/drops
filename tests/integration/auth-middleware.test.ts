import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildServer } from '@/server';
import { onAppHost } from '@/middleware/host';
import { requireAppSession, APP_SESSION_COOKIE } from '@/middleware/auth';
import { signCookie } from '@/lib/cookies';
import { db } from '@/db';
import { users, sessions } from '@/db/schema';
import { createSession, SESSION_TTL_SECONDS } from '@/services/sessions';
import { config } from '@/config';

let appInstance: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  appInstance = await buildServer();
  await appInstance.register(onAppHost(async (s) => {
    s.get('/app/secure', { preHandler: requireAppSession }, async (req) => ({
      id: req.user?.id ?? null,
    }));
  }));
});

afterAll(async () => { await appInstance.close(); });

let userId: string;
beforeEach(async () => {
  await db.delete(sessions);
  await db.delete(users);
  const [u] = await db.insert(users).values({ email: 'a@b.com', username: 'alice' }).returning();
  userId = u!.id;
});

function cookieHeader(name: string, value: string) {
  return `${name}=${value}`;
}

describe('requireAppSession', () => {
  it('redirects to login when no cookie', async () => {
    const res = await appInstance.inject({
      method: 'GET', url: '/app/secure',
      headers: { host: 'drops.localtest.me' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/auth\/login\?next=/);
  });

  it('clears cookie and redirects when session is expired', async () => {
    const sid = await createSession(userId, -10);
    const signed = signCookie(sid, config.SESSION_SECRET);
    const res = await appInstance.inject({
      method: 'GET', url: '/app/secure',
      headers: { host: 'drops.localtest.me', cookie: cookieHeader(APP_SESSION_COOKIE, signed) },
    });
    expect(res.statusCode).toBe(302);
    const setCookie = res.headers['set-cookie'];
    const setCookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    expect(setCookies.some((c) => c.startsWith(`${APP_SESSION_COOKIE}=;`))).toBe(true);
  });

  it('lets valid session through and populates req.user', async () => {
    const sid = await createSession(userId);
    const signed = signCookie(sid, config.SESSION_SECRET);
    const res = await appInstance.inject({
      method: 'GET', url: '/app/secure',
      headers: { host: 'drops.localtest.me', cookie: cookieHeader(APP_SESSION_COOKIE, signed) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: userId });
  });

  it('bumps expires_at when session is stale', async () => {
    const sid = await createSession(userId);
    await db.update(sessions).set({ expiresAt: new Date(Date.now() + 2 * 3600_000) }).where(eq(sessions.id, sid));
    const signed = signCookie(sid, config.SESSION_SECRET);
    await appInstance.inject({
      method: 'GET', url: '/app/secure',
      headers: { host: 'drops.localtest.me', cookie: cookieHeader(APP_SESSION_COOKIE, signed) },
    });
    const [row] = await db.select().from(sessions).where(eq(sessions.id, sid));
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now() + SESSION_TTL_SECONDS * 1000 - 10_000);
  });

  it('rejects viewer sessions, clears app cookie, and redirects to login', async () => {
    const [v] = await db.insert(users).values({
      email: 'v@out.test', kind: 'viewer',
    }).returning();
    const sid = await createSession(v!.id);
    const signed = signCookie(sid, config.SESSION_SECRET);
    const res = await appInstance.inject({
      method: 'GET', url: '/app/secure',
      headers: { host: 'drops.localtest.me', cookie: cookieHeader(APP_SESSION_COOKIE, signed) },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('/auth/login');
    const setCookie = res.headers['set-cookie'];
    const setCookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    expect(setCookies.some((c) => c.startsWith(`${APP_SESSION_COOKIE}=;`))).toBe(true);
  });
});
