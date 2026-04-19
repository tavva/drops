// ABOUTME: Integration tests for the owner add/remove POST routes on drop_viewers.
// ABOUTME: Covers idempotent add, bad-email re-render with fresh CSRF, and non-owner 404s.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

let appInstance: Awaited<ReturnType<typeof import('@/server').buildServer>>;

beforeAll(async () => {
  const { buildServer } = await import('@/server');
  const { onAppHost } = await import('@/middleware/host');
  const { registerCsrf } = await import('@/middleware/csrf');
  const { viewerRoutes } = await import('@/routes/app/viewers');
  const { editDropRoute } = await import('@/routes/app/editDrop');
  appInstance = await buildServer();
  await appInstance.register(onAppHost(async (s) => {
    await registerCsrf(s);
    await s.register(viewerRoutes);
    await s.register(editDropRoute);
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
  await db.insert(drops).values({ ownerId: aliceId, name: 'site', viewMode: 'emails' });

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

async function addViewer(cookie: string, csrf: string, name: string, email: string) {
  return appInstance.inject({
    method: 'POST', url: `/app/drops/${name}/viewers`,
    headers: {
      host: 'drops.localtest.me',
      origin: 'http://drops.localtest.me:3000',
      cookie,
      'content-type': 'application/x-www-form-urlencoded',
      'x-csrf-token': csrf,
    },
    payload: `_csrf=${encodeURIComponent(csrf)}&email=${encodeURIComponent(email)}`,
  });
}

async function removeViewer(cookie: string, csrf: string, name: string, email: string) {
  return appInstance.inject({
    method: 'POST', url: `/app/drops/${name}/viewers/${encodeURIComponent(email)}/delete`,
    headers: {
      host: 'drops.localtest.me',
      origin: 'http://drops.localtest.me:3000',
      cookie,
      'content-type': 'application/x-www-form-urlencoded',
      'x-csrf-token': csrf,
    },
    payload: `_csrf=${encodeURIComponent(csrf)}`,
  });
}

describe('POST /app/drops/:name/viewers', () => {
  it('adds a valid email and redirects', async () => {
    const res = await addViewer(aliceCookie, aliceCsrf, 'site', 'Visitor@Out.TEST');
    expect(res.statusCode).toBe(302);
    const { db } = await import('@/db');
    const { dropViewers } = await import('@/db/schema');
    const rows = await db.select().from(dropViewers);
    expect(rows.map(r => r.email)).toEqual(['visitor@out.test']);
  });

  it('idempotent on duplicate add', async () => {
    await addViewer(aliceCookie, aliceCsrf, 'site', 'dup@out.test');
    await addViewer(aliceCookie, aliceCsrf, 'site', 'DUP@out.test');
    const { db } = await import('@/db');
    const { dropViewers } = await import('@/db/schema');
    expect((await db.select().from(dropViewers)).length).toBe(1);
  });

  it('malformed email re-renders 400 with fresh CSRF cookie + token', async () => {
    const res = await addViewer(aliceCookie, aliceCsrf, 'site', 'not-an-email');
    expect(res.statusCode).toBe(400);
    const setCookies = [res.headers['set-cookie']].flat().filter(Boolean) as string[];
    const refreshed = setCookies.find((c) => c.startsWith('drops_csrf='))!;
    const newCookieVal = refreshed.split(';')[0]!.split('=')[1]!;
    const bodyTokenMatch = res.body.match(/name="_csrf" value="([^"]+)"/);
    expect(bodyTokenMatch![1]).toBe(newCookieVal);
  });

  it('non-owner → 404', async () => {
    const res = await addViewer(bobCookie, bobCsrf, 'site', 'x@y.z');
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /app/drops/:name/viewers/:email/delete', () => {
  it('removes listed viewer', async () => {
    await addViewer(aliceCookie, aliceCsrf, 'site', 'gone@out.test');
    const res = await removeViewer(aliceCookie, aliceCsrf, 'site', 'gone@out.test');
    expect(res.statusCode).toBe(302);
    const { db } = await import('@/db');
    const { dropViewers } = await import('@/db/schema');
    expect((await db.select().from(dropViewers)).length).toBe(0);
  });

  it('delete of a non-listed viewer still redirects (idempotent UX)', async () => {
    const res = await removeViewer(aliceCookie, aliceCsrf, 'site', 'nobody@out.test');
    expect(res.statusCode).toBe(302);
  });

  it('non-owner → 404', async () => {
    await addViewer(aliceCookie, aliceCsrf, 'site', 'x@y.z');
    const res = await removeViewer(bobCookie, bobCsrf, 'site', 'x@y.z');
    expect(res.statusCode).toBe(404);
  });
});
