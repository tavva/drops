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
  const { users, sessions, pendingLogins, allowedEmails, drops, dropViewers } = await import('@/db/schema');
  await db.delete(dropViewers);
  await db.delete(drops);
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
  // @fastify/cookie percent-decodes cookie values on the way in. Mirror that by percent-encoding
  // here, or values with `%` sequences in them (e.g. an encoded `next` URL) corrupt the HMAC.
  return `oauth_state=${encodeURIComponent(signCookie(payload, config.SESSION_SECRET))}`;
}

describe('GET /auth/callback', () => {
  it('restarts login when state cookie is missing and state query is unsigned', async () => {
    // Missing cookie + unsigned state = dead-end restart with no known next URL.
    const res = await appInstance.inject({
      method: 'GET', url: '/auth/callback?code=abc&state=s',
      headers: { host: 'drops.localtest.me' },
    });
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers.location as string);
    expect(loc.origin).toBe('http://drops.localtest.me:3000');
    expect(loc.pathname).toBe('/auth/login');
    expect(loc.searchParams.get('next')).toBeNull();
  });

  it('recovers next from the signed state query param when cookie is missing', async () => {
    // Regression: a viewer who hit /auth/callback once (which clears the state cookie) but then
    // re-opens a stale callback URL used to hit a dead-end `missing_state` 400. The signed
    // `state` param echoed back by Google carries the original `next` so we can restart.
    const { config } = await import('@/config');
    const { signCookie } = await import('@/lib/cookies');
    const next = 'http://drops.localtest.me:3000/auth/drop-bootstrap'
      + '?host=own--site.content.localtest.me&next=%2F';
    const stateToken = signCookie(JSON.stringify({ r: 'seed', next }), config.SESSION_SECRET);
    const res = await appInstance.inject({
      method: 'GET',
      url: `/auth/callback?code=abc&state=${encodeURIComponent(stateToken)}`,
      headers: { host: 'drops.localtest.me' },
    });
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers.location as string);
    expect(loc.origin).toBe('http://drops.localtest.me:3000');
    expect(loc.pathname).toBe('/auth/login');
    expect(loc.searchParams.get('next')).toBe(next);
  });

  it('restarts login when state cookie signature is invalid', async () => {
    // Cookie present but HMAC broken — same recovery path as missing cookie.
    const res = await appInstance.inject({
      method: 'GET', url: '/auth/callback?code=abc&state=s',
      headers: { host: 'drops.localtest.me', cookie: 'oauth_state=tampered.value' },
    });
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers.location as string);
    expect(loc.pathname).toBe('/auth/login');
  });

  it('rejects unverified email', async () => {
    exchangeCodeMock.mockResolvedValueOnce({
      email: 'bad@example.com',
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

  it('renders a helpful page showing the signed-in email when not allowed', async () => {
    exchangeCodeMock.mockResolvedValueOnce({
      email: 'nobody@some-other-domain.test',
      emailVerified: true,
      name: null, avatarUrl: null,
    });
    const next = 'http://ben--site.content.localtest.me:3000/';
    const res = await appInstance.inject({
      method: 'GET', url: '/auth/callback?code=abc&state=s',
      headers: { host: 'drops.localtest.me', cookie: await stateCookie('s', 'n', next) },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.body).toContain('nobody@some-other-domain.test');
    // Retry CTA preserves the intended destination.
    expect(res.body).toContain(`/auth/login?next=${encodeURIComponent(next)}`);
  });

  it('creates session for existing user and redirects to app next', async () => {
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
    expect(res.headers.location).toBe('http://drops.localtest.me:3000/app');
    const setCookies = [res.headers['set-cookie']].flat().filter(Boolean) as string[];
    expect(setCookies.some((c) => c.startsWith('drops_session='))).toBe(true);
  });

  it('creates session for existing user and hops through drop-host bootstrap when next is a drop URL', async () => {
    const { db } = await import('@/db');
    const { users, drops } = await import('@/db/schema');
    const [u] = await db.insert(users).values({ email: 'ben@ben-phillips.net', username: 'ben' }).returning();
    await db.insert(drops).values({ ownerId: u!.id, name: 'site', viewMode: 'authed' });
    exchangeCodeMock.mockResolvedValueOnce({
      email: 'ben@ben-phillips.net',
      emailVerified: true,
      name: 'Ben', avatarUrl: null,
    });
    const res = await appInstance.inject({
      method: 'GET', url: '/auth/callback?code=abc&state=s',
      headers: {
        host: 'drops.localtest.me',
        cookie: await stateCookie('s', 'n', 'http://ben--site.content.localtest.me:3000/'),
      },
    });
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers.location as string);
    expect(loc.origin).toBe('http://ben--site.content.localtest.me:3000');
    expect(loc.pathname).toBe('/auth/bootstrap');
    expect(loc.searchParams.get('token')).toBeTruthy();
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

  it('admits brand-new viewer (on email list) with no username, no app cookie', async () => {
    const { db } = await import('@/db');
    const { users, drops, dropViewers } = await import('@/db/schema');
    await db.delete(drops); await db.delete(users); await db.delete(dropViewers);
    const [owner] = await db.insert(users).values({
      email: 'own@example.com', username: 'own', kind: 'member',
    }).returning();
    const [d] = await db.insert(drops).values({
      ownerId: owner!.id, name: 'site', viewMode: 'emails',
    }).returning();
    await db.insert(dropViewers).values({ dropId: d!.id, email: 'visitor@outside.test' });
    exchangeCodeMock.mockResolvedValueOnce({
      email: 'visitor@outside.test', emailVerified: true, name: null, avatarUrl: null,
    });
    const res = await appInstance.inject({
      method: 'GET', url: '/auth/callback?code=abc&state=s',
      headers: { host: 'drops.localtest.me', cookie: await stateCookie('s', 'n',
        'http://own--site.content.localtest.me:3000/') },
    });
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers.location as string);
    expect(loc.origin).toBe('http://own--site.content.localtest.me:3000');
    expect(loc.pathname).toBe('/auth/bootstrap');
    const set = [res.headers['set-cookie']].flat().filter(Boolean) as string[];
    expect(set.some((c) => /^drops_session=[^;]+\./.test(c))).toBe(false);
    const { findByEmail } = await import('@/services/users');
    const u = await findByEmail('visitor@outside.test');
    expect(u!.kind).toBe('viewer');
    expect(u!.username).toBeNull();
  });

  it('promotes existing viewer to member when newly allowlisted, redirects to choose-username', async () => {
    const { db } = await import('@/db');
    const { users, allowedEmails } = await import('@/db/schema');
    await db.delete(users); await db.delete(allowedEmails);
    await db.insert(allowedEmails).values({ email: 'climber@elsewhere.test' });
    await db.insert(users).values({
      email: 'climber@elsewhere.test', kind: 'viewer',
    });
    exchangeCodeMock.mockResolvedValueOnce({
      email: 'climber@elsewhere.test', emailVerified: true, name: null, avatarUrl: null,
    });
    const res = await appInstance.inject({
      method: 'GET', url: '/auth/callback?code=abc&state=s',
      headers: { host: 'drops.localtest.me', cookie: await stateCookie('s', 'n') },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('/auth/choose-username');
    const { findByEmail } = await import('@/services/users');
    const u = await findByEmail('climber@elsewhere.test');
    expect(u!.kind).toBe('member');
    expect(u!.username).toBeNull();
  });

  it('demotes existing member to viewer when no longer allowlisted but still viewer-eligible, clears app cookie', async () => {
    const { db } = await import('@/db');
    const { users, drops, dropViewers, allowedEmails } = await import('@/db/schema');
    await db.delete(drops); await db.delete(users);
    await db.delete(dropViewers); await db.delete(allowedEmails);
    const [existing] = await db.insert(users).values({
      email: 'ex@other.test', username: 'ex', kind: 'member',
    }).returning();
    const [d] = await db.insert(drops).values({
      ownerId: existing!.id, name: 's', viewMode: 'emails',
    }).returning();
    await db.insert(dropViewers).values({ dropId: d!.id, email: 'ex@other.test' });
    exchangeCodeMock.mockResolvedValueOnce({
      email: 'ex@other.test', emailVerified: true, name: null, avatarUrl: null,
    });
    const res = await appInstance.inject({
      method: 'GET', url: '/auth/callback?code=abc&state=s',
      headers: { host: 'drops.localtest.me', cookie: await stateCookie('s', 'n') },
    });
    expect(res.statusCode).toBe(302);
    const set = [res.headers['set-cookie']].flat().filter(Boolean) as string[];
    const hasClear = set.some((c) => /^drops_session=;/.test(c));
    const hasFreshSigned = set.some((c) => /^drops_session=[^;]+\./.test(c));
    expect(hasClear).toBe(true);
    expect(hasFreshSigned).toBe(false);
    const { findByEmail } = await import('@/services/users');
    expect((await findByEmail('ex@other.test'))!.kind).toBe('viewer');
  });

  it('cold-browser viewer opening a shared drop link completes via the drop-bootstrap wrapper', async () => {
    // Regression: without unwrapping the app-host /auth/drop-bootstrap next URL, viewers (who never
    // hold an app-session cookie) were stranded on /auth/goodbye after OAuth. completeLogin must
    // extract the drop host from the wrapped URL and issue a host-bound handoff directly.
    const { db } = await import('@/db');
    const { users, drops, dropViewers } = await import('@/db/schema');
    await db.delete(drops); await db.delete(users); await db.delete(dropViewers);
    const [owner] = await db.insert(users).values({
      email: 'own@example.com', username: 'own', kind: 'member',
    }).returning();
    const [d] = await db.insert(drops).values({
      ownerId: owner!.id, name: 'site', viewMode: 'emails',
    }).returning();
    await db.insert(dropViewers).values({ dropId: d!.id, email: 'visitor@outside.test' });
    exchangeCodeMock.mockResolvedValueOnce({
      email: 'visitor@outside.test', emailVerified: true, name: null, avatarUrl: null,
    });

    const wrapped = 'http://drops.localtest.me:3000/auth/drop-bootstrap'
      + '?host=own--site.content.localtest.me&next=%2F';
    const res = await appInstance.inject({
      method: 'GET', url: '/auth/callback?code=abc&state=s',
      headers: { host: 'drops.localtest.me', cookie: await stateCookie('s', 'n', wrapped) },
    });
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers.location as string);
    expect(loc.origin).toBe('http://own--site.content.localtest.me:3000');
    expect(loc.pathname).toBe('/auth/bootstrap');
    expect(loc.searchParams.get('token')).toBeTruthy();
    // No app session for a viewer.
    const set = [res.headers['set-cookie']].flat().filter(Boolean) as string[];
    expect(set.some((c) => /^drops_session=[^;]+\./.test(c))).toBe(false);
  });

  it('sends a viewer whose next is not a drop URL to /auth/goodbye (no app dashboard for viewers)', async () => {
    const { db } = await import('@/db');
    const { users, drops, dropViewers, allowedEmails } = await import('@/db/schema');
    await db.delete(drops); await db.delete(users);
    await db.delete(dropViewers); await db.delete(allowedEmails);
    const [owner] = await db.insert(users).values({
      email: 'own@example.com', username: 'own', kind: 'member',
    }).returning();
    await db.insert(drops).values({ ownerId: owner!.id, name: 'pub', viewMode: 'public' });

    exchangeCodeMock.mockResolvedValueOnce({
      email: 'drifter@elsewhere.test', emailVerified: true, name: null, avatarUrl: null,
    });
    const res = await appInstance.inject({
      method: 'GET', url: '/auth/callback?code=abc&state=s',
      headers: {
        host: 'drops.localtest.me',
        cookie: await stateCookie('s', 'n', 'http://drops.localtest.me:3000/app'),
      },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://drops.localtest.me:3000/auth/goodbye');
  });
});
