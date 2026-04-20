// ABOUTME: App-host /auth/drop-bootstrap: mints a host-bound handoff so the browser can establish a
// ABOUTME: cookie on a specific drop subdomain. Requires an app session; refuses unknown / forbidden drops.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

let appInstance: Awaited<ReturnType<typeof import('@/server').buildServer>>;

beforeAll(async () => {
  const { buildServer } = await import('@/server');
  const { onAppHost } = await import('@/middleware/host');
  const { dropBootstrapRoute } = await import('@/routes/auth/dropBootstrap');
  appInstance = await buildServer();
  await appInstance.register(onAppHost(dropBootstrapRoute));
});

afterAll(async () => { await appInstance.close(); });

let ownerId: string;
let otherId: string;
let ownerSid: string;
let otherSid: string;
let dropId: string;

beforeEach(async () => {
  const { db } = await import('@/db');
  const { users, sessions, drops } = await import('@/db/schema');
  const { createSession } = await import('@/services/sessions');
  await db.delete(drops);
  await db.delete(sessions);
  await db.delete(users);
  const [u] = await db.insert(users).values({ email: 'alice@example.com', username: 'alice', kind: 'member' }).returning();
  const [o] = await db.insert(users).values({ email: 'other@example.com', username: 'other', kind: 'member' }).returning();
  ownerId = u!.id;
  otherId = o!.id;
  ownerSid = await createSession(ownerId);
  otherSid = await createSession(otherId);
  const [d] = await db.insert(drops).values({ ownerId, name: 'foo', viewMode: 'authed' }).returning();
  dropId = d!.id;
});

async function injectWithCookie(url: string, cookieValue: string | null) {
  const { signCookie } = await import('@/lib/cookies');
  const { config } = await import('@/config');
  const headers: Record<string, string> = { host: 'drops.localtest.me' };
  if (cookieValue !== null) {
    headers.cookie = `drops_session=${signCookie(cookieValue, config.SESSION_SECRET)}`;
  }
  return appInstance.inject({ method: 'GET', url, headers });
}

describe('GET /auth/drop-bootstrap', () => {
  it('bounces to /auth/login when no app session', async () => {
    const res = await injectWithCookie(
      '/auth/drop-bootstrap?host=alice--foo.content.localtest.me&next=%2F',
      null,
    );
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers.location as string);
    expect(loc.pathname).toBe('/auth/login');
    const next = loc.searchParams.get('next');
    expect(next).toContain('/auth/drop-bootstrap');
    expect(next).toContain('alice--foo.content.localtest.me');
  });

  it('owner: mints a host-bound handoff and redirects to drop-host bootstrap', async () => {
    const res = await injectWithCookie(
      '/auth/drop-bootstrap?host=alice--foo.content.localtest.me&next=%2Fabout.html',
      ownerSid,
    );
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers.location as string);
    expect(loc.origin).toBe('http://alice--foo.content.localtest.me:3000');
    expect(loc.pathname).toBe('/auth/bootstrap');
    const token = loc.searchParams.get('token');
    expect(token).toBeTruthy();
    expect(loc.searchParams.get('next')).toBe('/about.html');

    const { verifyHandoff } = await import('@/lib/handoff');
    const { config } = await import('@/config');
    const v = verifyHandoff(token!, 'alice--foo.content.localtest.me', config.SESSION_SECRET);
    expect(v).toEqual({ ok: true, sessionId: ownerSid });
  });

  it('non-owner on authed drop is allowed (member can view)', async () => {
    const res = await injectWithCookie(
      '/auth/drop-bootstrap?host=alice--foo.content.localtest.me&next=%2F',
      otherSid,
    );
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('alice--foo.content.localtest.me');
  });

  it('rejects viewer who cannot view the drop (emails allowlist)', async () => {
    const { db } = await import('@/db');
    const { drops: dropsTbl, users } = await import('@/db/schema');
    const { eq } = await import('drizzle-orm');
    await db.update(dropsTbl).set({ viewMode: 'emails' }).where(eq(dropsTbl.id, dropId));
    await db.update(users).set({ kind: 'viewer', username: null }).where(eq(users.id, otherId));

    const res = await injectWithCookie(
      '/auth/drop-bootstrap?host=alice--foo.content.localtest.me&next=%2F',
      otherSid,
    );
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://drops.localtest.me:3000/app');
  });

  it('404s on unparseable host', async () => {
    const res = await injectWithCookie(
      '/auth/drop-bootstrap?host=not-a-drop.example.com&next=%2F',
      ownerSid,
    );
    expect(res.statusCode).toBe(404);
  });

  it('404s on host for a nonexistent user', async () => {
    const res = await injectWithCookie(
      '/auth/drop-bootstrap?host=nobody--foo.content.localtest.me&next=%2F',
      ownerSid,
    );
    expect(res.statusCode).toBe(404);
  });

  it('404s on host for a nonexistent drop', async () => {
    const res = await injectWithCookie(
      '/auth/drop-bootstrap?host=alice--nope.content.localtest.me&next=%2F',
      ownerSid,
    );
    expect(res.statusCode).toBe(404);
  });
});
