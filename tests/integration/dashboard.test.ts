import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

let appInstance: Awaited<ReturnType<typeof import('@/server').buildServer>>;

beforeAll(async () => {
  const { buildServer } = await import('@/server');
  const { onAppHost } = await import('@/middleware/host');
  const { registerCsrf } = await import('@/middleware/csrf');
  const { dashboardRoute } = await import('@/routes/app/dashboard');
  appInstance = await buildServer();
  await appInstance.register(onAppHost(async (s) => {
    await registerCsrf(s);
    await s.register(dashboardRoute);
  }));
});

afterAll(async () => { await appInstance.close(); });

let userId: string;
beforeEach(async () => {
  const { db } = await import('@/db');
  const { users, drops, sessions } = await import('@/db/schema');
  await db.delete(drops);
  await db.delete(sessions);
  await db.delete(users);
  const [u] = await db.insert(users).values({ email: 'a@b.com', username: 'alice' }).returning();
  userId = u!.id;
});

async function authedCookie() {
  const { createSession } = await import('@/services/sessions');
  const { signCookie } = await import('@/lib/cookies');
  const { config } = await import('@/config');
  const sid = await createSession(userId);
  return `drops_session=${signCookie(sid, config.SESSION_SECRET)}`;
}

describe('GET /app', () => {
  it('redirects unauthenticated user to login', async () => {
    const res = await appInstance.inject({ method: 'GET', url: '/app', headers: { host: 'drops.localtest.me' } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('/auth/login');
  });

  it('renders empty state', async () => {
    const res = await appInstance.inject({
      method: 'GET', url: '/app',
      headers: { host: 'drops.localtest.me', cookie: await authedCookie() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('You have no drops yet');
  });

  it('lists user drops after creation', async () => {
    const { createDropAndVersion } = await import('@/services/drops');
    await createDropAndVersion(userId, 'site', { r2Prefix: 'drops/v1/', byteSize: 1, fileCount: 1 });
    const res = await appInstance.inject({
      method: 'GET', url: '/app',
      headers: { host: 'drops.localtest.me', cookie: await authedCookie() },
    });
    expect(res.body).toContain('>site<');
    expect(res.body).toContain('alice--site.content.localtest.me');
  });

  it("\"Everyone's drops\" filters out emails-mode drops the viewer is not listed on, but keeps public ones", async () => {
    const { db } = await import('@/db');
    const { users, drops, dropViewers, allowedEmails, sessions } = await import('@/db/schema');
    await db.delete(drops); await db.delete(sessions); await db.delete(users);
    await db.delete(dropViewers); await db.delete(allowedEmails);
    await db.insert(allowedEmails).values([
      { email: 'alice@allowed.test' }, { email: 'bob@allowed.test' }, { email: 'carol@allowed.test' },
    ]);
    const [alice] = await db.insert(users).values({
      email: 'alice@allowed.test', username: 'alice', kind: 'member',
    }).returning();
    const [bob] = await db.insert(users).values({
      email: 'bob@allowed.test', username: 'bob', kind: 'member',
    }).returning();
    const [carol] = await db.insert(users).values({
      email: 'carol@allowed.test', username: 'carol', kind: 'member',
    }).returning();
    await db.insert(drops).values([
      { ownerId: alice!.id, name: 'own', viewMode: 'authed' },
      { ownerId: bob!.id, name: 'public', viewMode: 'public' },
      { ownerId: carol!.id, name: 'private', viewMode: 'emails' },
    ]);

    const { createSession } = await import('@/services/sessions');
    const { signCookie } = await import('@/lib/cookies');
    const { config } = await import('@/config');
    const sid = await createSession(alice!.id);
    const cookie = `drops_session=${signCookie(sid, config.SESSION_SECRET)}`;

    const res = await appInstance.inject({
      method: 'GET', url: '/app',
      headers: { host: 'drops.localtest.me', cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('>public<');
    expect(res.body).toContain('>own<');
    expect(res.body).not.toContain('>private<');
    expect(res.body).toContain("Everyone's drops");
  });
});
