import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const exchangeCodeMock = vi.fn();

vi.mock('@/lib/oauth', () => ({
  __resetForTests: () => {},
  buildAuthUrl: async () => 'https://accounts.google.com/auth',
  exchangeCode: exchangeCodeMock,
}));

let appInstance: Awaited<ReturnType<typeof import('@/server').buildServer>>;

beforeAll(async () => {
  const { buildServer } = await import('@/server');
  const { onAppHost } = await import('@/middleware/host');
  const { callbackRoute } = await import('@/routes/auth/callback');
  appInstance = await buildServer();
  await appInstance.register(onAppHost(callbackRoute));
});

afterAll(async () => { await appInstance.close(); });

beforeEach(async () => {
  const { db } = await import('@/db');
  const { users, sessions, pendingLogins, allowedEmails } = await import('@/db/schema');
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(pendingLogins);
  await db.delete(allowedEmails);
  await db.insert(allowedEmails).values({ email: 'ben@ben-phillips.net' });
});

async function stateCookie(state: string, nonce: string, next = 'http://drops.localtest.me:3000/app') {
  const payload = JSON.stringify({ state, nonce, next });
  const { signCookie } = await import('@/lib/cookies');
  const { config } = await import('@/config');
  return `oauth_state=${signCookie(payload, config.SESSION_SECRET)}`;
}

describe('GET /auth/callback', () => {
  it('rejects missing state cookie', async () => {
    const res = await appInstance.inject({
      method: 'GET', url: '/auth/callback?code=abc&state=s',
      headers: { host: 'drops.localtest.me' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe('missing_state');
  });

  it('rejects unverified email', async () => {
    exchangeCodeMock.mockResolvedValueOnce({
      email: 'bad@drops.global',
      emailVerified: false,
      name: null, avatarUrl: null,
    });
    const res = await appInstance.inject({
      method: 'GET', url: '/auth/callback?code=abc&state=s',
      headers: { host: 'drops.localtest.me', cookie: await stateCookie('s', 'n') },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toBe('email_unverified');
  });

  it('rejects non-allowlisted email', async () => {
    exchangeCodeMock.mockResolvedValueOnce({
      email: 'nobody@example.com',
      emailVerified: true,
      name: null, avatarUrl: null,
    });
    const res = await appInstance.inject({
      method: 'GET', url: '/auth/callback?code=abc&state=s',
      headers: { host: 'drops.localtest.me', cookie: await stateCookie('s', 'n') },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toBe('not_allowed');
  });

  it('creates session for existing user and redirects to bootstrap', async () => {
    const { db } = await import('@/db');
    const { users } = await import('@/db/schema');
    await db.insert(users).values({ email: 'ben@ben-phillips.net', username: 'ben' });
    exchangeCodeMock.mockResolvedValueOnce({
      email: 'ben@ben-phillips.net',
      emailVerified: true,
      name: 'Ben', avatarUrl: null,
    });
    const res = await appInstance.inject({
      method: 'GET', url: '/auth/callback?code=abc&state=s',
      headers: { host: 'drops.localtest.me', cookie: await stateCookie('s', 'n') },
    });
    expect(res.statusCode).toBe(302);
    const loc = res.headers.location as string;
    expect(loc).toContain('/auth/bootstrap');
    expect(loc).toContain('content.localtest.me');
    expect(loc).toContain('token=');
    const setCookies = [res.headers['set-cookie']].flat().filter(Boolean) as string[];
    expect(setCookies.some((c) => c.startsWith('drops_session='))).toBe(true);
  });

  it('creates pending login for new user and redirects to choose-username', async () => {
    exchangeCodeMock.mockResolvedValueOnce({
      email: 'ben@ben-phillips.net',
      emailVerified: true,
      name: 'Ben', avatarUrl: null,
    });
    const res = await appInstance.inject({
      method: 'GET', url: '/auth/callback?code=abc&state=s',
      headers: { host: 'drops.localtest.me', cookie: await stateCookie('s', 'n') },
    });
    expect(res.statusCode).toBe(302);
    const loc = res.headers.location as string;
    expect(loc).toContain('/auth/choose-username');
    const setCookies = [res.headers['set-cookie']].flat().filter(Boolean) as string[];
    expect(setCookies.some((c) => c.startsWith('pending_login='))).toBe(true);
  });
});
