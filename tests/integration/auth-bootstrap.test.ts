import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

let appInstance: Awaited<ReturnType<typeof import('@/server').buildServer>>;

beforeAll(async () => {
  const { buildServer } = await import('@/server');
  const { onContentHost } = await import('@/middleware/host');
  const { bootstrapRoute } = await import('@/routes/auth/bootstrap');
  appInstance = await buildServer();
  await appInstance.register(onContentHost(bootstrapRoute));
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

describe('GET /auth/bootstrap', () => {
  it('sets cookie and redirects on valid token', async () => {
    const { createSession } = await import('@/services/sessions');
    const { signHandoff } = await import('@/lib/handoff');
    const { config } = await import('@/config');
    const sid = await createSession(userId);
    const token = signHandoff(sid, 'content.localtest.me', config.SESSION_SECRET, 60);
    const next = 'http://drops.localtest.me:3000/app';
    const res = await appInstance.inject({
      method: 'GET', url: `/auth/bootstrap?token=${encodeURIComponent(token)}&next=${encodeURIComponent(next)}`,
      headers: { host: 'content.localtest.me' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(next);
    const setCookies = [res.headers['set-cookie']].flat().filter(Boolean) as string[];
    expect(setCookies.some((c) => c.startsWith('drops_content_session='))).toBe(true);
  });

  it('rejects expired token', async () => {
    const { signHandoff } = await import('@/lib/handoff');
    const { config } = await import('@/config');
    const token = signHandoff('whatever', 'content.localtest.me', config.SESSION_SECRET, -1);
    const res = await appInstance.inject({
      method: 'GET', url: `/auth/bootstrap?token=${encodeURIComponent(token)}`,
      headers: { host: 'content.localtest.me' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('clamps evil next= to the default', async () => {
    const { createSession } = await import('@/services/sessions');
    const { signHandoff } = await import('@/lib/handoff');
    const { config } = await import('@/config');
    const sid = await createSession(userId);
    const token = signHandoff(sid, 'content.localtest.me', config.SESSION_SECRET, 60);
    const res = await appInstance.inject({
      method: 'GET', url: `/auth/bootstrap?token=${encodeURIComponent(token)}&next=https://evil.com`,
      headers: { host: 'content.localtest.me' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).not.toContain('evil.com');
  });
});
