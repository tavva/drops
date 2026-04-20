// ABOUTME: Drop-host GET /auth/bootstrap: consumes a host-bound handoff token, sets the drop cookie,
// ABOUTME: re-checks canView, and redirects to a same-host path.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

let appInstance: Awaited<ReturnType<typeof import('@/server').buildServer>>;

beforeAll(async () => {
  const { buildServer } = await import('@/server');
  const { onDropHost } = await import('@/middleware/host');
  const { bootstrapRoute } = await import('@/routes/auth/bootstrap');
  appInstance = await buildServer();
  await appInstance.register(onDropHost(bootstrapRoute));
});

afterAll(async () => { await appInstance.close(); });

const HOST = 'alice--foo.content.localtest.me';
let ownerId: string;
let ownerSid: string;

beforeEach(async () => {
  const { db } = await import('@/db');
  const { users, sessions, drops } = await import('@/db/schema');
  const { createSession } = await import('@/services/sessions');
  await db.delete(drops);
  await db.delete(sessions);
  await db.delete(users);
  const [u] = await db.insert(users).values({ email: 'alice@example.com', username: 'alice', kind: 'member' }).returning();
  ownerId = u!.id;
  ownerSid = await createSession(ownerId);
  await db.insert(drops).values({ ownerId, name: 'foo', viewMode: 'authed' });
});

describe('GET /auth/bootstrap (drop host)', () => {
  it('sets a host-scoped cookie and redirects on valid host-bound token', async () => {
    const { signHandoff } = await import('@/lib/handoff');
    const { config } = await import('@/config');
    const token = signHandoff(ownerSid, HOST, config.SESSION_SECRET, 60);
    const res = await appInstance.inject({
      method: 'GET',
      url: `/auth/bootstrap?token=${encodeURIComponent(token)}&next=%2Fabout.html`,
      headers: { host: HOST },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/about.html');
    const setCookies = [res.headers['set-cookie']].flat().filter(Boolean) as string[];
    const cookie = setCookies.find((c) => c.startsWith('drops_drop_session='));
    expect(cookie).toBeDefined();
    expect(cookie!.toLowerCase()).toContain(`domain=${HOST}`);
  });

  it('rejects a token minted for a different host', async () => {
    const { signHandoff } = await import('@/lib/handoff');
    const { config } = await import('@/config');
    const token = signHandoff(ownerSid, 'bob--bar.content.localtest.me', config.SESSION_SECRET, 60);
    const res = await appInstance.inject({
      method: 'GET',
      url: `/auth/bootstrap?token=${encodeURIComponent(token)}`,
      headers: { host: HOST },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an expired token', async () => {
    const { signHandoff } = await import('@/lib/handoff');
    const { config } = await import('@/config');
    const token = signHandoff(ownerSid, HOST, config.SESSION_SECRET, -1);
    const res = await appInstance.inject({
      method: 'GET',
      url: `/auth/bootstrap?token=${encodeURIComponent(token)}`,
      headers: { host: HOST },
    });
    expect(res.statusCode).toBe(400);
  });

  it('403s if caller can no longer view the drop', async () => {
    const { db } = await import('@/db');
    const { drops: dropsTbl, users } = await import('@/db/schema');
    const { eq } = await import('drizzle-orm');
    // Create a second user whose session is valid but who cannot view the private-emails drop.
    const [other] = await db.insert(users).values({ email: 'o@e.com', username: null, kind: 'viewer' }).returning();
    const { createSession } = await import('@/services/sessions');
    const otherSid = await createSession(other!.id);
    await db.update(dropsTbl).set({ viewMode: 'emails' }).where(eq(dropsTbl.name, 'foo'));

    const { signHandoff } = await import('@/lib/handoff');
    const { config } = await import('@/config');
    const token = signHandoff(otherSid, HOST, config.SESSION_SECRET, 60);
    const res = await appInstance.inject({
      method: 'GET',
      url: `/auth/bootstrap?token=${encodeURIComponent(token)}`,
      headers: { host: HOST },
    });
    expect(res.statusCode).toBe(403);
  });

  it('404s on unknown drop (host does not resolve to a drop)', async () => {
    const UNKNOWN = 'nobody--nope.content.localtest.me';
    const { signHandoff } = await import('@/lib/handoff');
    const { config } = await import('@/config');
    const token = signHandoff(ownerSid, UNKNOWN, config.SESSION_SECRET, 60);
    const res = await appInstance.inject({
      method: 'GET',
      url: `/auth/bootstrap?token=${encodeURIComponent(token)}`,
      headers: { host: UNKNOWN },
    });
    expect(res.statusCode).toBe(404);
  });

  it('clamps cross-host next= to /', async () => {
    const { signHandoff } = await import('@/lib/handoff');
    const { config } = await import('@/config');
    const token = signHandoff(ownerSid, HOST, config.SESSION_SECRET, 60);
    const res = await appInstance.inject({
      method: 'GET',
      url: `/auth/bootstrap?token=${encodeURIComponent(token)}&next=https%3A%2F%2Fevil.com%2F`,
      headers: { host: HOST },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  it('clamps next without a leading slash to /', async () => {
    const { signHandoff } = await import('@/lib/handoff');
    const { config } = await import('@/config');
    const token = signHandoff(ownerSid, HOST, config.SESSION_SECRET, 60);
    const res = await appInstance.inject({
      method: 'GET',
      url: `/auth/bootstrap?token=${encodeURIComponent(token)}&next=about.html`,
      headers: { host: HOST },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
  });
});
