import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('openid-client', () => {
  const Configuration = class {};
  return {
    Configuration,
    discovery: vi.fn(async () => new Configuration()),
    buildAuthorizationUrl: vi.fn((_cfg: unknown, params: Record<string, string>) => {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      return url;
    }),
    authorizationCodeGrant: vi.fn(),
  };
});

let appInstance: Awaited<ReturnType<typeof import('@/server').buildServer>>;

beforeAll(async () => {
  const { buildServer } = await import('@/server');
  const { onAppHost } = await import('@/middleware/host');
  const { loginRoute } = await import('@/routes/auth/login');
  appInstance = await buildServer();
  await appInstance.register(onAppHost(loginRoute));
});

afterAll(async () => { await appInstance.close(); });

describe('GET /auth/login', () => {
  it('redirects to Google with state and nonce', async () => {
    const res = await appInstance.inject({
      method: 'GET', url: '/auth/login',
      headers: { host: 'drops.localtest.me' },
    });
    expect(res.statusCode).toBe(302);
    const loc = res.headers.location as string;
    expect(loc).toMatch(/accounts\.google\.com/);
    const u = new URL(loc);
    expect(u.searchParams.get('state')).toBeTruthy();
    expect(u.searchParams.get('nonce')).toBeTruthy();
    const setCookies = [res.headers['set-cookie']].flat().filter(Boolean) as string[];
    expect(setCookies.some((c) => c.startsWith('oauth_state='))).toBe(true);
  });

  it('clamps evil next= to the default', async () => {
    const res = await appInstance.inject({
      method: 'GET', url: '/auth/login?next=https://evil.com/harm',
      headers: { host: 'drops.localtest.me' },
    });
    expect(res.statusCode).toBe(302);
    const setCookies = [res.headers['set-cookie']].flat().filter(Boolean) as string[];
    const cookie = setCookies.find((c) => c.startsWith('oauth_state='))!;
    const value = decodeURIComponent(cookie.split(';')[0]!.split('=')[1]!);
    const payload = JSON.parse(value.slice(0, value.lastIndexOf('.')));
    expect(payload.next).not.toContain('evil.com');
  });

  it('short-circuits to drop-host bootstrap when user is signed in and next is a drop URL', async () => {
    const { db } = await import('@/db');
    const { users, sessions, drops } = await import('@/db/schema');
    await db.delete(drops); await db.delete(sessions); await db.delete(users);
    const [u] = await db.insert(users).values({ email: 'a@e.com', username: 'alice', kind: 'member' }).returning();
    await db.insert(drops).values({ ownerId: u!.id, name: 'site', viewMode: 'authed' });
    const { createSession } = await import('@/services/sessions');
    const { signCookie } = await import('@/lib/cookies');
    const { config } = await import('@/config');
    const sid = await createSession(u!.id);
    const res = await appInstance.inject({
      method: 'GET',
      url: `/auth/login?next=${encodeURIComponent('http://alice--site.content.localtest.me:3000/')}`,
      headers: {
        host: 'drops.localtest.me',
        cookie: `drops_session=${signCookie(sid, config.SESSION_SECRET)}`,
      },
    });
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers.location as string);
    expect(loc.origin).toBe('http://alice--site.content.localtest.me:3000');
    expect(loc.pathname).toBe('/auth/bootstrap');
    expect(loc.searchParams.get('token')).toBeTruthy();
  });

  it('does not short-circuit if user cannot view the drop', async () => {
    const { db } = await import('@/db');
    const { users, sessions, drops } = await import('@/db/schema');
    await db.delete(drops); await db.delete(sessions); await db.delete(users);
    // A viewer user whose email is not in the emails allowlist for the drop.
    const [owner] = await db.insert(users).values({ email: 'owner@e.com', username: 'owner', kind: 'member' }).returning();
    await db.insert(drops).values({ ownerId: owner!.id, name: 'site', viewMode: 'emails' });
    const [viewer] = await db.insert(users).values({ email: 'stranger@e.com', username: null, kind: 'viewer' }).returning();
    const { createSession } = await import('@/services/sessions');
    const { signCookie } = await import('@/lib/cookies');
    const { config } = await import('@/config');
    const sid = await createSession(viewer!.id);
    const res = await appInstance.inject({
      method: 'GET',
      url: `/auth/login?next=${encodeURIComponent('http://owner--site.content.localtest.me:3000/')}`,
      headers: {
        host: 'drops.localtest.me',
        cookie: `drops_session=${signCookie(sid, config.SESSION_SECRET)}`,
      },
    });
    expect(res.statusCode).toBe(302);
    // Falls through to OAuth redirect.
    expect(res.headers.location as string).toMatch(/accounts\.google\.com/);
  });
});
