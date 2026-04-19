// ABOUTME: Integration tests for POST /app/drops/:name/permissions — owner mode changes, 404 on miss.
// ABOUTME: Shares seed/cookie shape with edit-delete.test.ts; non-owner is expected to receive 404, not 403.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

let appInstance: Awaited<ReturnType<typeof import('@/server').buildServer>>;

beforeAll(async () => {
  const { buildServer } = await import('@/server');
  const { onAppHost } = await import('@/middleware/host');
  const { registerCsrf } = await import('@/middleware/csrf');
  const { setPermissionsRoute } = await import('@/routes/app/setPermissions');
  appInstance = await buildServer();
  await appInstance.register(onAppHost(async (s) => {
    await registerCsrf(s);
    await s.register(setPermissionsRoute);
  }));
});
afterAll(async () => { await appInstance.close(); });

let aliceId: string;
let bobId: string;
let aliceCookie: string;
let aliceCsrf: string;
let bobCookie: string;
let bobCsrf: string;

beforeEach(async () => {
  const { db } = await import('@/db');
  const { users, drops, dropViewers, sessions, allowedEmails } = await import('@/db/schema');
  await db.delete(dropViewers); await db.delete(drops);
  await db.delete(sessions); await db.delete(users); await db.delete(allowedEmails);
  const [a] = await db.insert(users).values({
    email: 'alice@example.com', username: 'alice', kind: 'member',
  }).returning();
  const [b] = await db.insert(users).values({
    email: 'bob@example.com', username: 'bob', kind: 'member',
  }).returning();
  aliceId = a!.id; bobId = b!.id;
  await db.insert(drops).values({ ownerId: aliceId, name: 'site', viewMode: 'authed' });

  const { createSession } = await import('@/services/sessions');
  const { signCookie } = await import('@/lib/cookies');
  const { config } = await import('@/config');
  const { issueCsrfToken } = await import('@/lib/csrf');
  const aSid = await createSession(aliceId);
  const bSid = await createSession(bobId);
  aliceCsrf = issueCsrfToken(aSid);
  bobCsrf = issueCsrfToken(bSid);
  aliceCookie = `drops_session=${signCookie(aSid, config.SESSION_SECRET)}; drops_csrf=${aliceCsrf}`;
  bobCookie = `drops_session=${signCookie(bSid, config.SESSION_SECRET)}; drops_csrf=${bobCsrf}`;
});

async function setMode(cookie: string, csrf: string, name: string, mode: string) {
  return appInstance.inject({
    method: 'POST', url: `/app/drops/${name}/permissions`,
    headers: {
      host: 'drops.localtest.me',
      origin: 'http://drops.localtest.me:3000',
      cookie,
      'content-type': 'application/x-www-form-urlencoded',
      'x-csrf-token': csrf,
    },
    payload: `_csrf=${encodeURIComponent(csrf)}&mode=${encodeURIComponent(mode)}`,
  });
}

describe('POST /app/drops/:name/permissions', () => {
  it('owner flips mode to public', async () => {
    const res = await setMode(aliceCookie, aliceCsrf, 'site','public');
    expect(res.statusCode).toBe(302);
    const { db } = await import('@/db');
    const { drops } = await import('@/db/schema');
    const { eq } = await import('drizzle-orm');
    const [row] = await db.select().from(drops).where(eq(drops.ownerId, aliceId));
    expect(row!.viewMode).toBe('public');
  });

  it('owner flips mode to emails then back to authed', async () => {
    await setMode(aliceCookie, aliceCsrf, 'site','emails');
    const back = await setMode(aliceCookie, aliceCsrf, 'site','authed');
    expect(back.statusCode).toBe(302);
  });

  it('non-owner → 404', async () => {
    const res = await setMode(bobCookie, bobCsrf, 'site', 'public');
    expect(res.statusCode).toBe(404);
  });

  it('invalid mode → 400', async () => {
    const res = await setMode(aliceCookie, aliceCsrf, 'site','nonsense');
    expect(res.statusCode).toBe(400);
  });

  it('missing drop → 404', async () => {
    const res = await setMode(aliceCookie, aliceCsrf, 'nope', 'public');
    expect(res.statusCode).toBe(404);
  });
});
