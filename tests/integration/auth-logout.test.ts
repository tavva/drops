// ABOUTME: Logout flow: POST /auth/logout on app host deletes the session, clears app cookie, redirects to goodbye.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

let appInstance: Awaited<ReturnType<typeof import('@/server').buildServer>>;

beforeAll(async () => {
  const { buildServer } = await import('@/server');
  const { onAppHost } = await import('@/middleware/host');
  const { logoutRoute } = await import('@/routes/auth/logout');
  const { registerCsrf } = await import('@/middleware/csrf');
  appInstance = await buildServer();
  await appInstance.register(onAppHost(async (s) => { await registerCsrf(s); await s.register(logoutRoute); }));
});

afterAll(async () => { await appInstance.close(); });

let userId: string;
beforeEach(async () => {
  const { db } = await import('@/db');
  const { users, sessions } = await import('@/db/schema');
  await db.delete(sessions);
  await db.delete(users);
  const [u] = await db.insert(users).values({ email: 'a@b.com', username: 'alice' }).returning();
  userId = u!.id;
});

describe('logout', () => {
  it('POST /auth/logout deletes session, clears cookie, redirects to goodbye', async () => {
    const { createSession, getSessionUser } = await import('@/services/sessions');
    const { signCookie } = await import('@/lib/cookies');
    const { config } = await import('@/config');
    const { issueCsrfToken, CSRF_COOKIE } = await import('@/lib/csrf');
    const sid = await createSession(userId);
    const token = issueCsrfToken(sid);
    const res = await appInstance.inject({
      method: 'POST', url: '/auth/logout',
      headers: {
        host: 'drops.localtest.me',
        origin: 'http://drops.localtest.me:3000',
        cookie: `drops_session=${signCookie(sid, config.SESSION_SECRET)}; ${CSRF_COOKIE}=${token}`,
        'x-csrf-token': token,
      },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://drops.localtest.me:3000/auth/goodbye');
    const setCookies = [res.headers['set-cookie']].flat().filter(Boolean) as string[];
    expect(setCookies.some((c) => c.startsWith('drops_session=;'))).toBe(true);
    expect(await getSessionUser(sid)).toBeNull();
  });

  it('GET /auth/goodbye renders goodbye page', async () => {
    const res = await appInstance.inject({
      method: 'GET', url: '/auth/goodbye',
      headers: { host: 'drops.localtest.me' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Signed out');
  });
});
