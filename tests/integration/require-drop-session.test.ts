// ABOUTME: requireDropSession accepts host-bound drop cookies and bounces to app-host drop-bootstrap on miss.
import { describe, it, expect, afterAll, beforeEach } from 'vitest';

const HOST = 'alice--foo.content.localtest.me';

const { buildServer } = await import('@/server');
const { onDropHost } = await import('@/middleware/host');
const { requireDropSession } = await import('@/middleware/auth');

const app = await buildServer();
await app.register(onDropHost(async (s) => {
  s.get('/whoami', { preHandler: requireDropSession }, async (req) => ({
    userId: req.user!.id,
    sessionId: req.session!.id,
  }));
}));

afterAll(async () => { await app.close(); });

let userId: string;
let sid: string;

beforeEach(async () => {
  const { db } = await import('@/db');
  const { users, sessions } = await import('@/db/schema');
  const { createSession } = await import('@/services/sessions');
  await db.delete(sessions);
  await db.delete(users);
  const [u] = await db.insert(users).values({ email: 'a@e.com', username: 'alice', kind: 'member' }).returning();
  userId = u!.id;
  sid = await createSession(userId);
});

describe('requireDropSession', () => {
  it('accepts a valid host-bound cookie', async () => {
    const { signDropCookie } = await import('@/lib/cookies');
    const { config } = await import('@/config');
    const cookie = signDropCookie(sid, HOST, config.SESSION_SECRET);
    const res = await app.inject({
      method: 'GET', url: '/whoami',
      headers: { host: HOST, cookie: `drops_drop_session=${cookie}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId, sessionId: sid });
  });

  it('bounces to /auth/drop-bootstrap on missing cookie', async () => {
    const res = await app.inject({
      method: 'GET', url: '/whoami?q=1',
      headers: { host: HOST },
    });
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers.location as string);
    expect(loc.pathname).toBe('/auth/drop-bootstrap');
    expect(loc.searchParams.get('host')).toBe(HOST);
    expect(loc.searchParams.get('next')).toBe('/whoami?q=1');
  });

  it('rejects a cookie minted for a different drop host', async () => {
    const { signDropCookie } = await import('@/lib/cookies');
    const { config } = await import('@/config');
    const cookie = signDropCookie(sid, 'bob--bar.content.localtest.me', config.SESSION_SECRET);
    const res = await app.inject({
      method: 'GET', url: '/whoami',
      headers: { host: HOST, cookie: `drops_drop_session=${cookie}` },
    });
    expect(res.statusCode).toBe(302);
    expect(new URL(res.headers.location as string).pathname).toBe('/auth/drop-bootstrap');
  });

  it('bounces when session row is gone (stale cookie)', async () => {
    const { signDropCookie } = await import('@/lib/cookies');
    const { config } = await import('@/config');
    const { db } = await import('@/db');
    const { sessions } = await import('@/db/schema');
    const cookie = signDropCookie(sid, HOST, config.SESSION_SECRET);
    await db.delete(sessions);
    const res = await app.inject({
      method: 'GET', url: '/whoami',
      headers: { host: HOST, cookie: `drops_drop_session=${cookie}` },
    });
    expect(res.statusCode).toBe(302);
    expect(new URL(res.headers.location as string).pathname).toBe('/auth/drop-bootstrap');
  });
});
