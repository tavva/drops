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

test('create a folder, file a drop into it, delete the folder, drop bubbles up', async () => {
  const { setupTestDatabase } = await import('../helpers/db');
  await setupTestDatabase();

  const { db } = await import('../../src/db');
  const { users, drops, folders, allowedEmails } = await import('../../src/db/schema');
  await db.delete(drops);
  await db.delete(folders);
  await db.delete(users);
  await db.delete(allowedEmails);
  await db.insert(allowedEmails).values({ email: 'tester@example.com' });
  const [u] = await db.insert(users).values({ email: 'tester@example.com', username: 'tester' }).returning();

  // Seed a drop directly (skip upload machinery).
  const [d] = await db.insert(drops).values({ ownerId: u!.id, name: 'site', viewMode: 'public' }).returning();

  const { createSession } = await import('../../src/services/sessions');
  const { signCookie } = await import('../../src/lib/cookies');
  const sid = await createSession(u!.id);
  const appCookie = `drops_session=${signCookie(sid, process.env.SESSION_SECRET!)}`;

  const { buildServer } = await import('../../src/server');
  const { onAppHost } = await import('../../src/middleware/host');
  const { registerCsrf } = await import('../../src/middleware/csrf');
  const { dashboardRoute } = await import('../../src/routes/app/dashboard');
  const { folderRoutes } = await import('../../src/routes/app/folders');

  const app = await buildServer();
  await app.register(onAppHost(async (s) => {
    await registerCsrf(s);
    await s.register(dashboardRoute);
    await s.register(folderRoutes);
  }));

  const { issueCsrfToken, CSRF_COOKIE } = await import('../../src/lib/csrf');
  const csrf = issueCsrfToken(sid);
  const cookie = `${appCookie}; ${CSRF_COOKIE}=${csrf}`;

  // Create a folder
  const createRes = await app.inject({
    method: 'POST', url: '/app/folders',
    headers: {
      host: 'drops.localtest.me',
      origin: 'http://drops.localtest.me:3000',
      cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: `name=work&_csrf=${csrf}`,
  });
  expect(createRes.statusCode).toBe(303);
  const [folder] = await db.select().from(folders);

  // File the drop into the folder
  const fileRes = await app.inject({
    method: 'POST', url: `/app/drops/${d!.id}/folder`,
    headers: {
      host: 'drops.localtest.me',
      origin: 'http://drops.localtest.me:3000',
      cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: `folderId=${folder!.id}&_csrf=${csrf}`,
  });
  expect(fileRes.statusCode).toBe(303);

  // Verify the drop renders inside the folder
  const before = await app.inject({
    method: 'GET', url: '/app',
    headers: { host: 'drops.localtest.me', cookie },
  });
  expect(before.statusCode).toBe(200);
  const folderStart = before.body.indexOf(`data-folder-id="${folder!.id}"`);
  expect(folderStart).toBeGreaterThan(-1);
  const afterFolder = before.body.slice(folderStart);
  expect(afterFolder).toContain('site');

  // Delete the folder
  const deleteRes = await app.inject({
    method: 'POST', url: `/app/folders/${folder!.id}/delete`,
    headers: {
      host: 'drops.localtest.me',
      origin: 'http://drops.localtest.me:3000',
      cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: `_csrf=${csrf}`,
  });
  expect(deleteRes.statusCode).toBe(303);

  // Drop should now be at root (folderId null)
  const [dropAfter] = await db.select().from(drops);
  expect(dropAfter!.folderId).toBeNull();

  await app.close();
});
