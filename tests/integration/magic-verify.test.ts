// ABOUTME: /auth/magic/verify — GET confirms (non-consuming), POST consumes and completes a viewer login.
// ABOUTME: Prefetch-safe: a GET never burns the token; replay after a POST renders the expired page.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

let appInstance: Awaited<ReturnType<typeof import('@/server').buildServer>>;

beforeAll(async () => {
  const { buildServer } = await import('@/server');
  const { onAppHost } = await import('@/middleware/host');
  const { magicRoutes } = await import('@/routes/auth/magic');
  appInstance = await buildServer();
  await appInstance.register(onAppHost(magicRoutes));
});

afterAll(async () => { await appInstance.close(); });

const HOST = 'alice--foo.content.localtest.me';
let dropId: string;

async function wrappedNext() {
  const w = new URL('/auth/drop-bootstrap', 'http://drops.localtest.me:3000');
  w.searchParams.set('host', HOST); w.searchParams.set('next', '/');
  return w.toString();
}

beforeEach(async () => {
  const { db } = await import('@/db');
  const { users, drops, dropViewers, magicLinkTokens, sessions } = await import('@/db/schema');
  await db.delete(magicLinkTokens);
  await db.delete(sessions);
  await db.delete(dropViewers);
  await db.delete(drops);
  await db.delete(users);
  const [u] = await db.insert(users).values({ email: 'alice@example.com', username: 'alice', kind: 'member' }).returning();
  const [d] = await db.insert(drops).values({ ownerId: u!.id, name: 'foo', viewMode: 'emails' }).returning();
  dropId = d!.id;
  await db.insert(dropViewers).values({ dropId, email: 'guest@outside.test' });
});

async function issue(email: string) {
  const { issueMagicToken } = await import('@/services/magicLinkTokens');
  const { token } = await issueMagicToken(email, dropId, await wrappedNext());
  return token;
}

function post(token: string) {
  return appInstance.inject({
    method: 'POST', url: '/auth/magic/verify',
    headers: {
      host: 'drops.localtest.me',
      origin: 'http://drops.localtest.me:3000',
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: new URLSearchParams({ token }).toString(),
  });
}

describe('GET /auth/magic/verify', () => {
  it('malformed token renders the expired page (400)', async () => {
    const res = await appInstance.inject({
      method: 'GET', url: '/auth/magic/verify?token=short',
      headers: { host: 'drops.localtest.me' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('renders a confirm page without consuming the token', async () => {
    const token = await issue('guest@outside.test');
    const res = await appInstance.inject({
      method: 'GET', url: `/auth/magic/verify?token=${token}`,
      headers: { host: 'drops.localtest.me' },
    });
    expect(res.statusCode).toBe(200);
    const { db } = await import('@/db');
    const { magicLinkTokens } = await import('@/db/schema');
    const { eq } = await import('drizzle-orm');
    const [row] = await db.select().from(magicLinkTokens).where(eq(magicLinkTokens.id, token));
    expect(row!.consumedAt).toBeNull();
  });
});

describe('POST /auth/magic/verify', () => {
  it('creates a viewer user and redirects to the drop-host bootstrap', async () => {
    const token = await issue('guest@outside.test');
    const res = await post(token);
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers.location as string);
    expect(loc.origin).toBe('http://alice--foo.content.localtest.me:3000');
    expect(loc.pathname).toBe('/auth/bootstrap');

    const { verifyHandoff } = await import('@/lib/handoff');
    const { config } = await import('@/config');
    const v = verifyHandoff(loc.searchParams.get('token')!, HOST, config.SESSION_SECRET);
    expect(v.ok).toBe(true);

    const { findByEmail } = await import('@/services/users');
    const user = await findByEmail('guest@outside.test');
    expect(user?.kind).toBe('viewer');
  });

  it('replay of a consumed token renders the expired page', async () => {
    const token = await issue('guest@outside.test');
    await post(token);
    const { db } = await import('@/db');
    const { sessions } = await import('@/db/schema');
    const before = (await db.select().from(sessions)).length;
    const res = await post(token);
    expect(res.statusCode).toBe(400);
    const after = (await db.select().from(sessions)).length;
    expect(after).toBe(before);
  });

  it('a member email keeps its kind and gets a content session (no app cookie)', async () => {
    const { db } = await import('@/db');
    const { users } = await import('@/db/schema');
    await db.insert(users).values({ email: 'bob@example.com', username: 'bob', kind: 'member' });
    // bob is a member (ALLOWED_DOMAIN), eligible to view an authed... here drop is 'emails',
    // so add him as a viewer to make him eligible.
    const { addViewer } = await import('@/services/dropViewers');
    await addViewer(dropId, 'bob@example.com');
    const token = await issue('bob@example.com');
    const res = await post(token);
    expect(res.statusCode).toBe(302);
    const setCookie = [res.headers['set-cookie']].flat().filter(Boolean) as string[];
    expect(setCookie.some((c) => c.startsWith('drops_session='))).toBe(false);
    const { findByEmail } = await import('@/services/users');
    expect((await findByEmail('bob@example.com'))?.kind).toBe('member');
  });
});
