// ABOUTME: POST /auth/magic/request — emails a sign-in link to an eligible viewer, enumeration-safe.
// ABOUTME: Ineligible/malformed emails produce the same notice but no token row and no send.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

let appInstance: Awaited<ReturnType<typeof import('@/server').buildServer>>;

beforeAll(async () => {
  const { buildServer } = await import('@/server');
  const { onAppHost } = await import('@/middleware/host');
  const { registerCsrf } = await import('@/middleware/csrf');
  const { dropBootstrapRoute } = await import('@/routes/auth/dropBootstrap');
  const { magicRoutes } = await import('@/routes/auth/magic');
  appInstance = await buildServer();
  await appInstance.register(onAppHost(async (s) => {
    await registerCsrf(s);
    await s.register(dropBootstrapRoute);
    await s.register(magicRoutes);
  }));
});

afterAll(async () => { await appInstance.close(); });

const HOST = 'alice--foo.content.localtest.me';

let dropId: string;

beforeEach(async () => {
  const { db } = await import('@/db');
  const { users, drops, dropViewers, magicLinkTokens } = await import('@/db/schema');
  await db.delete(magicLinkTokens);
  await db.delete(dropViewers);
  await db.delete(drops);
  await db.delete(users);
  const [u] = await db.insert(users).values({ email: 'alice@example.com', username: 'alice', kind: 'member' }).returning();
  const [d] = await db.insert(drops).values({ ownerId: u!.id, name: 'foo', viewMode: 'emails' }).returning();
  dropId = d!.id;
  await db.insert(dropViewers).values({ dropId, email: 'guest@outside.test' });

  const { getMailer } = await import('@/lib/mail');
  (getMailer() as { sent: unknown[] }).sent.length = 0;
});

function parseCookies(res: { headers: Record<string, unknown> }): Record<string, string> {
  const set = [res.headers['set-cookie']].flat().filter(Boolean) as string[];
  const out: Record<string, string> = {};
  for (const c of set) {
    const [pair] = c.split(';');
    const i = pair!.indexOf('=');
    out[pair!.slice(0, i)] = pair!.slice(i + 1);
  }
  return out;
}

// GET the interstitial to obtain a bound csrf_anon + drops_csrf pair, then POST the form.
async function requestLink(email: string) {
  const page = await appInstance.inject({
    method: 'GET', url: `/auth/drop-bootstrap?host=${HOST}&next=%2F`,
    headers: { host: 'drops.localtest.me' },
  });
  const cookies = parseCookies(page);
  const csrf = cookies['drops_csrf']!;
  const cookieHeader = `csrf_anon=${cookies['csrf_anon']}; drops_csrf=${csrf}`;
  const params = new URLSearchParams({ host: HOST, next: '/', email, _csrf: csrf });
  return appInstance.inject({
    method: 'POST', url: '/auth/magic/request',
    headers: {
      host: 'drops.localtest.me',
      origin: 'http://drops.localtest.me:3000',
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookieHeader,
    },
    payload: params.toString(),
  });
}

async function tokenCount() {
  const { db } = await import('@/db');
  const { magicLinkTokens } = await import('@/db/schema');
  return (await db.select().from(magicLinkTokens)).length;
}

async function sentCount() {
  const { getMailer } = await import('@/lib/mail');
  return (getMailer() as { sent: unknown[] }).sent.length;
}

describe('POST /auth/magic/request', () => {
  it('allowlisted viewer gets a token and one email', async () => {
    const res = await requestLink('guest@outside.test');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('on its way');
    expect(await tokenCount()).toBe(1);
    expect(await sentCount()).toBe(1);
  });

  it('non-allowlisted email: same notice, no token, no send', async () => {
    const res = await requestLink('stranger@outside.test');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('on its way');
    expect(await tokenCount()).toBe(0);
    expect(await sentCount()).toBe(0);
  });

  it('malformed email: same notice, no token, no send', async () => {
    const res = await requestLink('nope');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('on its way');
    expect(await tokenCount()).toBe(0);
    expect(await sentCount()).toBe(0);
  });

  it('second request for same email/drop with a different next sends only once', async () => {
    await requestLink('guest@outside.test');
    // second request with a different next path
    const page = await appInstance.inject({
      method: 'GET', url: `/auth/drop-bootstrap?host=${HOST}&next=%2Fabout.html`,
      headers: { host: 'drops.localtest.me' },
    });
    const cookies = parseCookies(page);
    const csrf = cookies['drops_csrf']!;
    const params = new URLSearchParams({ host: HOST, next: '/about.html', email: 'guest@outside.test', _csrf: csrf });
    const res = await appInstance.inject({
      method: 'POST', url: '/auth/magic/request',
      headers: {
        host: 'drops.localtest.me',
        origin: 'http://drops.localtest.me:3000',
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `csrf_anon=${cookies['csrf_anon']}; drops_csrf=${csrf}`,
      },
      payload: params.toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(await tokenCount()).toBe(1);
    expect(await sentCount()).toBe(1);
  });
});
