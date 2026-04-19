import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('openid-client', () => ({
  Configuration: class {},
  discovery: vi.fn(async () => ({})),
  buildAuthorizationUrl: vi.fn(() => new URL('https://accounts.google.com/auth')),
  authorizationCodeGrant: vi.fn(),
}));

let appInstance: Awaited<ReturnType<typeof import('@/server').buildServer>>;

beforeAll(async () => {
  const { buildServer } = await import('@/server');
  const { onAppHost } = await import('@/middleware/host');
  const { chooseUsernameRoute } = await import('@/routes/auth/chooseUsername');
  appInstance = await buildServer();
  await appInstance.register(onAppHost(chooseUsernameRoute));
});

afterAll(async () => { await appInstance.close(); });

async function prepare() {
  const { db } = await import('@/db');
  const { users, pendingLogins, sessions } = await import('@/db/schema');
  const { signCookie } = await import('@/lib/cookies');
  const { config } = await import('@/config');
  const { issueCsrfToken, CSRF_COOKIE } = await import('@/lib/csrf');
  const { createPendingLogin } = await import('@/services/pendingLogins');
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(pendingLogins);
  const id = await createPendingLogin({ email: 'new@example.com', name: 'New', avatarUrl: null });
  return {
    pendingId: id,
    pendingCookie: `pending_login=${signCookie(id, config.SESSION_SECRET)}`,
    csrfCookie: (token: string) => `${CSRF_COOKIE}=${token}`,
    token: () => issueCsrfToken(id),
  };
}

beforeEach(async () => { await prepare(); });

describe('GET/POST /auth/choose-username', () => {
  it('GET without pending cookie redirects to login', async () => {
    const res = await appInstance.inject({
      method: 'GET', url: '/auth/choose-username',
      headers: { host: 'drops.localtest.me' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('/auth/login');
  });

  it('GET renders form with suggested slug', async () => {
    const ctx = await prepare();
    const res = await appInstance.inject({
      method: 'GET', url: '/auth/choose-username',
      headers: { host: 'drops.localtest.me', cookie: ctx.pendingCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('value="new"');
    expect(res.body).toContain('_csrf');
  });

  it('POST with reserved slug re-renders with error', async () => {
    const ctx = await prepare();
    const token = ctx.token();
    const res = await appInstance.inject({
      method: 'POST', url: '/auth/choose-username',
      headers: {
        host: 'drops.localtest.me',
        origin: 'http://drops.localtest.me:3000',
        cookie: [ctx.pendingCookie, ctx.csrfCookie(token)].join('; '), 'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `username=admin&_csrf=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('reserved');
  });

  it('POST with taken slug re-renders with error', async () => {
    const ctx = await prepare();
    const { db } = await import('@/db');
    const { users } = await import('@/db/schema');
    await db.insert(users).values({ email: 'other@example.com', username: 'taken' });
    const token = ctx.token();
    const res = await appInstance.inject({
      method: 'POST', url: '/auth/choose-username',
      headers: {
        host: 'drops.localtest.me',
        origin: 'http://drops.localtest.me:3000',
        cookie: [ctx.pendingCookie, ctx.csrfCookie(token)].join('; '), 'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `username=taken&_csrf=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('taken');
  });

  it('POST with valid new slug creates user + session and redirects to bootstrap', async () => {
    const ctx = await prepare();
    const token = ctx.token();
    const res = await appInstance.inject({
      method: 'POST', url: '/auth/choose-username',
      headers: {
        host: 'drops.localtest.me',
        origin: 'http://drops.localtest.me:3000',
        cookie: [ctx.pendingCookie, ctx.csrfCookie(token)].join('; '), 'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `username=alpha&_csrf=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('/auth/bootstrap');
    const setCookies = [res.headers['set-cookie']].flat().filter(Boolean) as string[];
    expect(setCookies.some((c) => c.startsWith('drops_session='))).toBe(true);
    const { db } = await import('@/db');
    const { users } = await import('@/db/schema');
    const rows = await db.select().from(users);
    expect(rows.some((u) => u.username === 'alpha')).toBe(true);
  });

  it('GET with a member app-session and null username renders the form', async () => {
    const { db } = await import('@/db');
    const { users, sessions, pendingLogins } = await import('@/db/schema');
    await db.delete(sessions); await db.delete(users); await db.delete(pendingLogins);
    const [u] = await db.insert(users).values({
      email: 'promoted@example.com', kind: 'member',
    }).returning();
    const { createSession } = await import('@/services/sessions');
    const sid = await createSession(u!.id);
    const { signCookie } = await import('@/lib/cookies');
    const { config } = await import('@/config');
    const cookie = `drops_session=${signCookie(sid, config.SESSION_SECRET)}`;
    const res = await appInstance.inject({
      method: 'GET', url: '/auth/choose-username',
      headers: { host: 'drops.localtest.me', cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('value="promoted"');
    expect(res.body).toContain('id="uname-input"');
  });

  it('POST with app-session updates the existing user\'s username', async () => {
    const { db } = await import('@/db');
    const { users, sessions, pendingLogins } = await import('@/db/schema');
    await db.delete(sessions); await db.delete(users); await db.delete(pendingLogins);
    const [u] = await db.insert(users).values({
      email: 'promoted@example.com', kind: 'member',
    }).returning();
    const { createSession } = await import('@/services/sessions');
    const sid = await createSession(u!.id);
    const { signCookie } = await import('@/lib/cookies');
    const { config } = await import('@/config');
    const { issueCsrfToken } = await import('@/lib/csrf');
    const csrf = issueCsrfToken(sid);
    const cookie = `drops_session=${signCookie(sid, config.SESSION_SECRET)}; drops_csrf=${csrf}`;

    const res = await appInstance.inject({
      method: 'POST', url: '/auth/choose-username',
      headers: {
        host: 'drops.localtest.me',
        origin: 'http://drops.localtest.me:3000',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `username=picked&next=${encodeURIComponent('http://drops.localtest.me:3000/app')}&_csrf=${encodeURIComponent(csrf)}`,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('/auth/bootstrap');

    const { findByEmail } = await import('@/services/users');
    const after = await findByEmail('promoted@example.com');
    expect(after!.username).toBe('picked');
  });

  it('POST with invalid username re-renders 400 and form is resubmittable', async () => {
    const { db } = await import('@/db');
    const { users, sessions, pendingLogins } = await import('@/db/schema');
    await db.delete(sessions); await db.delete(users); await db.delete(pendingLogins);
    const [u] = await db.insert(users).values({
      email: 'promoted@example.com', kind: 'member',
    }).returning();
    const { createSession } = await import('@/services/sessions');
    const sid = await createSession(u!.id);
    const { signCookie } = await import('@/lib/cookies');
    const { config } = await import('@/config');
    const { issueCsrfToken } = await import('@/lib/csrf');
    const csrf = issueCsrfToken(sid);
    const cookie = `drops_session=${signCookie(sid, config.SESSION_SECRET)}; drops_csrf=${csrf}`;

    const bad = await appInstance.inject({
      method: 'POST', url: '/auth/choose-username',
      headers: {
        host: 'drops.localtest.me',
        origin: 'http://drops.localtest.me:3000',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `username=A&next=${encodeURIComponent('http://drops.localtest.me:3000/app')}&_csrf=${encodeURIComponent(csrf)}`,
    });
    expect(bad.statusCode).toBe(400);

    const setCookies = [bad.headers['set-cookie']].flat().filter(Boolean) as string[];
    const refreshed = setCookies.find((c) => c.startsWith('drops_csrf='))!;
    const newCookieVal = refreshed.split(';')[0]!.split('=')[1]!;
    const bodyTokenMatch = bad.body.match(/name="_csrf" value="([^"]+)"/);
    expect(bodyTokenMatch![1]).toBe(newCookieVal);

    const retryCookie = `drops_session=${signCookie(sid, config.SESSION_SECRET)}; drops_csrf=${newCookieVal}`;
    const good = await appInstance.inject({
      method: 'POST', url: '/auth/choose-username',
      headers: {
        host: 'drops.localtest.me',
        origin: 'http://drops.localtest.me:3000',
        cookie: retryCookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `username=picked&next=${encodeURIComponent('http://drops.localtest.me:3000/app')}&_csrf=${encodeURIComponent(newCookieVal)}`,
    });
    expect(good.statusCode).toBe(302);
  });
});
