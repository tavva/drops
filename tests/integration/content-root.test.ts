// ABOUTME: Integration tests for the minimal content-origin GET / landing route.
// ABOUTME: Unauthenticated visitors redirect to login; signed-in viewers see the one-line page.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

let appInstance: Awaited<ReturnType<typeof import('@/server').buildServer>>;

beforeAll(async () => {
  const { buildServer } = await import('@/server');
  const { rootRoute } = await import('@/routes/app/root');
  appInstance = await buildServer();
  await appInstance.register(rootRoute);
});
afterAll(async () => { await appInstance.close(); });

beforeEach(async () => {
  const { db } = await import('@/db');
  const { users, sessions } = await import('@/db/schema');
  await db.delete(sessions); await db.delete(users);
});

describe('GET / on content origin', () => {
  it('redirects unauthenticated visitors to login', async () => {
    const res = await appInstance.inject({
      method: 'GET', url: '/',
      headers: { host: 'content.localtest.me' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('/auth/login');
  });

  it('exposes a working sign-out link', async () => {
    const { db } = await import('@/db');
    const { users } = await import('@/db/schema');
    const [u] = await db.insert(users).values({
      email: 'v@out.test', kind: 'viewer',
    }).returning();
    const { createSession } = await import('@/services/sessions');
    const sid = await createSession(u!.id);
    const { signCookie } = await import('@/lib/cookies');
    const { config } = await import('@/config');
    const cookie = `drops_content_session=${signCookie(sid, config.SESSION_SECRET)}`;
    const res = await appInstance.inject({
      method: 'GET', url: '/',
      headers: { host: 'content.localtest.me', cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/href="\/auth\/logout"/);
  });

  it('renders signed-in page for a viewer', async () => {
    const { db } = await import('@/db');
    const { users } = await import('@/db/schema');
    const [u] = await db.insert(users).values({
      email: 'v@out.test', kind: 'viewer',
    }).returning();
    const { createSession } = await import('@/services/sessions');
    const sid = await createSession(u!.id);
    const { signCookie } = await import('@/lib/cookies');
    const { config } = await import('@/config');
    const cookie = `drops_content_session=${signCookie(sid, config.SESSION_SECRET)}`;
    const res = await appInstance.inject({
      method: 'GET', url: '/',
      headers: { host: 'content.localtest.me', cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('v@out.test');
  });
});
