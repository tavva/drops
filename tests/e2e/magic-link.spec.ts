// ABOUTME: End-to-end magic-link viewer flow over app.inject: request → confirm → verify → serve.
import { test, expect } from '@playwright/test';

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

const HOST = 'alice--foo.content.localtest.me';

function parseCookies(setCookie: unknown): Record<string, string> {
  const arr = [setCookie].flat().filter(Boolean) as string[];
  const out: Record<string, string> = {};
  for (const c of arr) {
    const [pair] = c.split(';');
    const i = pair!.indexOf('=');
    out[pair!.slice(0, i)] = pair!.slice(i + 1);
  }
  return out;
}

test('non-member views a drop via an emailed magic link', async () => {
  const { setupTestDatabase } = await import('../helpers/db');
  await setupTestDatabase();
  const { resetBucket } = await import('../helpers/r2');
  await resetBucket();

  const { db } = await import('../../src/db');
  const { users, drops, dropViewers, magicLinkTokens, sessions } = await import('../../src/db/schema');
  await db.delete(magicLinkTokens);
  await db.delete(sessions);
  await db.delete(dropViewers);
  await db.delete(drops);
  await db.delete(users);

  // owner + drop seeded directly (no upload route / owner session needed).
  const [owner] = await db.insert(users).values({ email: 'alice@example.com', username: 'alice', kind: 'member' }).returning();
  const r2Prefix = 'drops/e2e-magic/';
  const body = Buffer.from('<h1>Hello from fixture</h1>');
  const { putObject } = await import('../../src/lib/r2');
  await putObject(`${r2Prefix}index.html`, body, 'text/html');
  const { createDropAndVersion } = await import('../../src/services/drops');
  const { dropId } = await createDropAndVersion(owner!.id, 'foo', { r2Prefix, byteSize: body.length, fileCount: 1 });
  const { setViewMode } = await import('../../src/services/permissions');
  await setViewMode(dropId, 'emails');
  const { addViewer } = await import('../../src/services/dropViewers');
  await addViewer(dropId, 'guest@outside.test');

  // clear the in-process mailer capture
  const { getMailer } = await import('../../src/lib/mail');
  (getMailer() as unknown as { sent: { text: string }[] }).sent.length = 0;

  // build server with the routes this flow touches
  const { buildServer } = await import('../../src/server');
  const { onAppHost, onDropHost } = await import('../../src/middleware/host');
  const { registerCsrf } = await import('../../src/middleware/csrf');
  const { dropBootstrapRoute } = await import('../../src/routes/auth/dropBootstrap');
  const { magicRoutes } = await import('../../src/routes/auth/magic');
  const { bootstrapRoute } = await import('../../src/routes/auth/bootstrap');
  const { dropServeRoute } = await import('../../src/routes/content/dropServe');

  const app = await buildServer();
  await app.register(onAppHost(async (s) => {
    await registerCsrf(s);
    await s.register(dropBootstrapRoute);
    await s.register(magicRoutes);
  }));
  await app.register(onDropHost(async (s) => {
    await s.register(bootstrapRoute);
    await s.register(dropServeRoute);
  }));

  // 1) GET the interstitial to obtain csrf cookies
  const page = await app.inject({
    method: 'GET', url: `/auth/drop-bootstrap?host=${HOST}&next=%2F`,
    headers: { host: 'drops.localtest.me' },
  });
  expect(page.statusCode).toBe(200);
  const cookies = parseCookies(page.headers['set-cookie']);
  const csrf = cookies['drops_csrf']!;
  const appCookie = `csrf_anon=${cookies['csrf_anon']}; drops_csrf=${csrf}`;

  // 2) POST request a link (urlencoded form, with origin + csrf)
  const reqRes = await app.inject({
    method: 'POST', url: '/auth/magic/request',
    headers: {
      host: 'drops.localtest.me',
      origin: 'http://drops.localtest.me:3000',
      'content-type': 'application/x-www-form-urlencoded',
      cookie: appCookie,
    },
    payload: new URLSearchParams({ host: HOST, next: '/', email: 'guest@outside.test', _csrf: csrf }).toString(),
  });
  expect(reqRes.statusCode).toBe(200);

  // 3) read the link from the in-process mailer
  const sent = (getMailer() as unknown as { sent: { text: string }[] }).sent;
  expect(sent).toHaveLength(1);
  const token = new URL(sent.at(-1)!.text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;

  // 4) GET confirm (non-consuming)
  const confirm = await app.inject({
    method: 'GET', url: `/auth/magic/verify?token=${token}`,
    headers: { host: 'drops.localtest.me' },
  });
  expect(confirm.statusCode).toBe(200);

  // 5) POST verify → 302 to drop-host bootstrap
  const verify = await app.inject({
    method: 'POST', url: '/auth/magic/verify',
    headers: {
      host: 'drops.localtest.me',
      origin: 'http://drops.localtest.me:3000',
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: new URLSearchParams({ token }).toString(),
  });
  expect(verify.statusCode).toBe(302);
  const bootUrl = new URL(verify.headers.location as string);
  expect(bootUrl.pathname).toBe('/auth/bootstrap');

  // 6) follow the handoff to the drop-host bootstrap (sets drops_drop_session)
  const boot = await app.inject({
    method: 'GET', url: bootUrl.pathname + bootUrl.search,
    headers: { host: bootUrl.hostname },
  });
  expect(boot.statusCode).toBe(302);
  const dropCookies = parseCookies(boot.headers['set-cookie']);
  const dropCookie = `drops_drop_session=${dropCookies['drops_drop_session']}`;

  // 7) serve content with the drop-session cookie
  const content = await app.inject({
    method: 'GET', url: '/',
    headers: { host: HOST, cookie: dropCookie },
  });
  expect(content.statusCode).toBe(200);
  expect(content.body).toContain('Hello from fixture');

  await app.close();
});
