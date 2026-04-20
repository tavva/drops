import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Set env before importing anything that reads it.
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

test('upload a folder and serve it from the content host', async () => {
  const { setupTestDatabase } = await import('../helpers/db');
  await setupTestDatabase();
  const { resetBucket } = await import('../helpers/r2');
  await resetBucket();

  const { db } = await import('../../src/db');
  const { users, allowedEmails } = await import('../../src/db/schema');
  await db.delete(users);
  await db.delete(allowedEmails);
  await db.insert(allowedEmails).values({ email: 'tester@example.com' });
  const [u] = await db.insert(users).values({ email: 'tester@example.com', username: 'tester' }).returning();

  const { createSession } = await import('../../src/services/sessions');
  const { signCookie, signDropCookie } = await import('../../src/lib/cookies');
  const sid = await createSession(u!.id);
  const appCookie = `drops_session=${signCookie(sid, process.env.SESSION_SECRET!)}`;
  const dropHost = 'tester--demo.content.localtest.me';
  const dropCookie = `drops_drop_session=${signDropCookie(sid, dropHost, process.env.SESSION_SECRET!)}`;

  const { buildServer } = await import('../../src/server');
  const { onAppHost, onDropHost } = await import('../../src/middleware/host');
  const { registerCsrf } = await import('../../src/middleware/csrf');
  const { dashboardRoute } = await import('../../src/routes/app/dashboard');
  const { uploadRoute } = await import('../../src/routes/app/upload');
  const { dropServeRoute } = await import('../../src/routes/content/dropServe');

  const app = await buildServer();
  await app.register(onAppHost(async (s) => {
    await registerCsrf(s);
    await s.register(dashboardRoute);
    await s.register(uploadRoute);
  }));
  await app.register(onDropHost(dropServeRoute));

  const { issueCsrfToken } = await import('../../src/lib/csrf');
  const csrf = issueCsrfToken(sid);
  const cookie = `${appCookie}; drops_csrf=${csrf}`;

  const fixturesDir = resolve(process.cwd(), 'tests/e2e/fixtures/site');
  const indexHtml = readFileSync(resolve(fixturesDir, 'index.html'));
  const styleCss = readFileSync(resolve(fixturesDir, 'style.css'));

  const boundary = '----e2e-drops';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="index.html"\r\nContent-Type: text/html\r\n\r\n`),
    indexHtml, Buffer.from('\r\n'),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="style.css"\r\nContent-Type: text/css\r\n\r\n`),
    styleCss, Buffer.from('\r\n'),
    Buffer.from(`--${boundary}--\r\n`),
  ]);

  const uploadRes = await app.inject({
    method: 'POST', url: '/app/drops/demo/upload?upload_type=folder',
    headers: {
      host: 'drops.localtest.me',
      origin: 'http://drops.localtest.me:3000',
      cookie,
      'x-csrf-token': csrf,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: body,
  });
  expect(uploadRes.statusCode).toBe(302);

  const contentRes = await app.inject({
    method: 'GET', url: '/',
    headers: { host: dropHost, cookie: dropCookie },
  });
  expect(contentRes.statusCode).toBe(200);
  expect(contentRes.body).toContain('Hello from fixture');

  const dashboardRes = await app.inject({
    method: 'GET', url: '/app',
    headers: { host: 'drops.localtest.me', cookie },
  });
  expect(dashboardRes.statusCode).toBe(200);
  expect(dashboardRes.body).toContain('>demo<');

  await app.close();
});
