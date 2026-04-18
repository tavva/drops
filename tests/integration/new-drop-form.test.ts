import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

let appInstance: Awaited<ReturnType<typeof import('@/server').buildServer>>;

beforeAll(async () => {
  const { buildServer } = await import('@/server');
  const { onAppHost } = await import('@/middleware/host');
  const { registerCsrf } = await import('@/middleware/csrf');
  const { newDropRoute } = await import('@/routes/app/newDrop');
  appInstance = await buildServer();
  await appInstance.register(onAppHost(async (s) => { await registerCsrf(s); await s.register(newDropRoute); }));
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

describe('GET /app/drops/new', () => {
  it('renders form with CSRF token', async () => {
    const { createSession } = await import('@/services/sessions');
    const { signCookie } = await import('@/lib/cookies');
    const { config } = await import('@/config');
    const sid = await createSession(userId);
    const res = await appInstance.inject({
      method: 'GET', url: '/app/drops/new',
      headers: { host: 'drops.localtest.me', cookie: `drops_session=${signCookie(sid, config.SESSION_SECRET)}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/data-csrf="[A-Za-z0-9_.-]+"/);
  });

  it('redirects unauthenticated user to login', async () => {
    const res = await appInstance.inject({ method: 'GET', url: '/app/drops/new', headers: { host: 'drops.localtest.me' } });
    expect(res.statusCode).toBe(302);
  });
});
