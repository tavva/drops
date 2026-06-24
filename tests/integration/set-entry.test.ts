// ABOUTME: Integration tests for POST /app/drops/:name/entry — owner sets the version homepage (entry_path).
// ABOUTME: Validates against files in the current version; bad/foreign paths 400, non-owner 404, empty clears to NULL.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { resetBucket } from '../helpers/r2';

let appInstance: Awaited<ReturnType<typeof import('@/server').buildServer>>;

beforeAll(async () => {
  await resetBucket();
  const { buildServer } = await import('@/server');
  const { onAppHost } = await import('@/middleware/host');
  const { registerCsrf } = await import('@/middleware/csrf');
  const { setEntryRoute } = await import('@/routes/app/setEntry');
  appInstance = await buildServer();
  await appInstance.register(onAppHost(async (s) => {
    await registerCsrf(s);
    await s.register(setEntryRoute);
  }));
});
afterAll(async () => { await appInstance.close(); });

let aliceId: string;
let aliceCookie: string;
let aliceCsrf: string;
let bobCookie: string;
let bobCsrf: string;
let prefix: string;

beforeEach(async () => {
  const { db } = await import('@/db');
  const { users, drops, dropVersions, dropViewers, sessions, allowedEmails } = await import('@/db/schema');
  await db.delete(dropViewers); await db.delete(drops);
  await db.delete(sessions); await db.delete(users); await db.delete(allowedEmails);
  const [a] = await db.insert(users).values({
    email: 'alice@example.com', username: 'alice', kind: 'member',
  }).returning();
  const [b] = await db.insert(users).values({
    email: 'bob@example.com', username: 'bob', kind: 'member',
  }).returning();
  aliceId = a!.id; const bobId = b!.id;

  prefix = `drops/site-${Math.random().toString(36).slice(2)}/`;
  const { putObject } = await import('@/lib/r2');
  await putObject(prefix + 'index.html', Buffer.from('<html>index</html>'), 'text/html');
  await putObject(prefix + 'about.html', Buffer.from('<html>about</html>'), 'text/html');
  await putObject(prefix + 'style.css', Buffer.from('body{}'), 'text/css');

  const [drop] = await db.insert(drops).values({ ownerId: aliceId, name: 'site', viewMode: 'authed' }).returning();
  const [ver] = await db.insert(dropVersions).values({
    dropId: drop!.id, r2Prefix: prefix, byteSize: 100, fileCount: 3, entryPath: 'index.html',
  }).returning();
  const { eq } = await import('drizzle-orm');
  await db.update(drops).set({ currentVersion: ver!.id }).where(eq(drops.id, drop!.id));

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

async function setEntry(cookie: string, csrf: string, name: string, entry: string) {
  return appInstance.inject({
    method: 'POST', url: `/app/drops/${name}/entry`,
    headers: {
      host: 'drops.localtest.me',
      origin: 'http://drops.localtest.me:3000',
      cookie,
      'content-type': 'application/x-www-form-urlencoded',
      'x-csrf-token': csrf,
    },
    payload: `_csrf=${encodeURIComponent(csrf)}&entry=${encodeURIComponent(entry)}`,
  });
}

async function readEntryPath(name: string): Promise<string | null> {
  const { findByOwnerAndName } = await import('@/services/drops');
  const drop = await findByOwnerAndName(aliceId, name);
  return drop!.version!.entryPath;
}

describe('POST /app/drops/:name/entry', () => {
  it('owner sets a valid html path present in the version → 302, entry_path updated', async () => {
    const res = await setEntry(aliceCookie, aliceCsrf, 'site', 'about.html');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('/app/drops/site');
    expect(await readEntryPath('site')).toBe('about.html');
  });

  it('path not in the version → 400 bad_entry, entry_path unchanged', async () => {
    const res = await setEntry(aliceCookie, aliceCsrf, 'site', 'missing.html');
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe('bad_entry');
    expect(await readEntryPath('site')).toBe('index.html');
  });

  it('non-html path → 400 bad_entry, entry_path unchanged', async () => {
    const res = await setEntry(aliceCookie, aliceCsrf, 'site', 'style.css');
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe('bad_entry');
    expect(await readEntryPath('site')).toBe('index.html');
  });

  it('empty entry → 302, clears entry_path to NULL', async () => {
    const res = await setEntry(aliceCookie, aliceCsrf, 'site', '');
    expect(res.statusCode).toBe(302);
    expect(await readEntryPath('site')).toBeNull();
  });

  it('non-owner → 404 (no enumeration)', async () => {
    const res = await setEntry(bobCookie, bobCsrf, 'site', 'about.html');
    expect(res.statusCode).toBe(404);
    expect(await readEntryPath('site')).toBe('index.html');
  });

  it('unknown drop name → 404', async () => {
    const res = await setEntry(aliceCookie, aliceCsrf, 'nope', 'about.html');
    expect(res.statusCode).toBe(404);
  });
});
