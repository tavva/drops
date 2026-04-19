// ABOUTME: End-to-end (app.inject-based, not Playwright-browser) coverage of the drop-permissions flow.
// ABOUTME: Seeds owner and viewer users directly, drives the real HTTP routes, asserts content serving + revocation.
import { test, expect } from '@playwright/test';

process.env.DATABASE_URL ??= 'postgres://drops:drops@localhost:55432/drops_test';
process.env.R2_ENDPOINT ??= 'http://localhost:9000';
process.env.R2_ACCOUNT_ID ??= 'minio';
process.env.R2_ACCESS_KEY_ID ??= 'minioadmin';
process.env.R2_SECRET_ACCESS_KEY ??= 'minioadmin';
process.env.R2_BUCKET ??= 'drops-test';
process.env.GOOGLE_CLIENT_ID ??= 'test';
process.env.GOOGLE_CLIENT_SECRET ??= 'test';
process.env.SESSION_SECRET ??= 's'.repeat(64);
process.env.ALLOWED_DOMAIN ??= 'example.com';
process.env.APP_ORIGIN ??= 'http://drops.localtest.me:3000';
process.env.CONTENT_ORIGIN ??= 'http://content.localtest.me:3000';
process.env.PORT ??= '3000';
process.env.LOG_LEVEL ??= 'silent';

test('drop permissions: flip to emails, add viewer, serve, remove, 404', async () => {
  const { setupTestDatabase } = await import('../helpers/db');
  await setupTestDatabase();
  const { resetBucket } = await import('../helpers/r2');
  await resetBucket();

  const { db } = await import('../../src/db');
  const { users, drops, dropViewers, allowedEmails, sessions } = await import('../../src/db/schema');
  await db.delete(dropViewers); await db.delete(drops);
  await db.delete(sessions); await db.delete(users); await db.delete(allowedEmails);
  await db.insert(allowedEmails).values({ email: 'alice@example.com' });
  const [alice] = await db.insert(users).values({
    email: 'alice@example.com', username: 'alice', kind: 'member',
  }).returning();
  const [visitor] = await db.insert(users).values({
    email: 'visitor@outside.test', kind: 'viewer',
  }).returning();

  const { putObject } = await import('../../src/lib/r2');
  const prefix = 'drops/perm-e2e/';
  await putObject(prefix + 'index.html', Buffer.from('<p>Hello permissions</p>'));
  const { createDropAndVersion } = await import('../../src/services/drops');
  await createDropAndVersion(alice!.id, 'perm', { r2Prefix: prefix, byteSize: 24, fileCount: 1 });

  const { createSession } = await import('../../src/services/sessions');
  const { signCookie } = await import('../../src/lib/cookies');
  const { issueCsrfToken } = await import('../../src/lib/csrf');
  const aliceSid = await createSession(alice!.id);
  const aliceCsrf = issueCsrfToken(aliceSid);
  const aliceCookie = `drops_session=${signCookie(aliceSid, process.env.SESSION_SECRET!)}; drops_csrf=${aliceCsrf}`;

  const visitorSid = await createSession(visitor!.id);
  const visitorContentCookie = `drops_content_session=${signCookie(visitorSid, process.env.SESSION_SECRET!)}`;

  const { buildServer } = await import('../../src/server');
  const { onAppHost, onContentHost } = await import('../../src/middleware/host');
  const { registerCsrf } = await import('../../src/middleware/csrf');
  const { setPermissionsRoute } = await import('../../src/routes/app/setPermissions');
  const { viewerRoutes } = await import('../../src/routes/app/viewers');
  const { editDropRoute } = await import('../../src/routes/app/editDrop');
  const { contentServeRoute } = await import('../../src/routes/content/serve');

  const app = await buildServer();
  await app.register(onAppHost(async (s) => {
    await registerCsrf(s);
    await s.register(setPermissionsRoute);
    await s.register(viewerRoutes);
    await s.register(editDropRoute);
  }));
  await app.register(onContentHost(contentServeRoute));

  const flip = await app.inject({
    method: 'POST', url: '/app/drops/perm/permissions',
    headers: {
      host: 'drops.localtest.me', origin: 'http://drops.localtest.me:3000',
      cookie: aliceCookie, 'x-csrf-token': aliceCsrf,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: `_csrf=${encodeURIComponent(aliceCsrf)}&mode=emails`,
  });
  expect(flip.statusCode).toBe(302);

  const add = await app.inject({
    method: 'POST', url: '/app/drops/perm/viewers',
    headers: {
      host: 'drops.localtest.me', origin: 'http://drops.localtest.me:3000',
      cookie: aliceCookie, 'x-csrf-token': aliceCsrf,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: `_csrf=${encodeURIComponent(aliceCsrf)}&email=${encodeURIComponent('visitor@outside.test')}`,
  });
  expect(add.statusCode).toBe(302);

  const servedOk = await app.inject({
    method: 'GET', url: '/alice/perm/',
    headers: { host: 'content.localtest.me', cookie: visitorContentCookie },
  });
  expect(servedOk.statusCode).toBe(200);
  expect(servedOk.body).toContain('Hello permissions');

  const remove = await app.inject({
    method: 'POST', url: `/app/drops/perm/viewers/${encodeURIComponent('visitor@outside.test')}/delete`,
    headers: {
      host: 'drops.localtest.me', origin: 'http://drops.localtest.me:3000',
      cookie: aliceCookie, 'x-csrf-token': aliceCsrf,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: `_csrf=${encodeURIComponent(aliceCsrf)}`,
  });
  expect(remove.statusCode).toBe(302);

  const servedDenied = await app.inject({
    method: 'GET', url: '/alice/perm/',
    headers: { host: 'content.localtest.me', cookie: visitorContentCookie },
  });
  expect(servedDenied.statusCode).toBe(404);

  await app.close();
});
