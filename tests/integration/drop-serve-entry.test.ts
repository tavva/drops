// ABOUTME: Drop-host bare-root entry behaviour: serve a root-level entry's bytes or 302-redirect to a nested entry.
// ABOUTME: Covers no-loop, percent-encoding of the redirect target, and the index.html regression at the true root.
import { describe, it, expect, afterAll, beforeAll, beforeEach } from 'vitest';
import { resetBucket } from '../helpers/r2';

let appInstance: Awaited<ReturnType<typeof import('@/server').buildServer>>;

beforeAll(async () => {
  await resetBucket();
  const { buildServer } = await import('@/server');
  const { onDropHost } = await import('@/middleware/host');
  const { dropServeRoute } = await import('@/routes/content/dropServe');
  appInstance = await buildServer();
  await appInstance.register(onDropHost(dropServeRoute));
});

afterAll(async () => { await appInstance.close(); });

function hostFor(user: string, drop: string) { return `${user}--${drop}.content.localtest.me`; }

async function cookieFor(userId: string, host: string) {
  const { createSession } = await import('@/services/sessions');
  const { signDropCookie } = await import('@/lib/cookies');
  const { config } = await import('@/config');
  const sid = await createSession(userId);
  return `drops_drop_session=${signDropCookie(sid, host, config.SESSION_SECRET)}`;
}

async function makeUserAndDrop(
  email: string,
  username: string | null,
  kind: 'member' | 'viewer',
  dropName: string,
  mode: 'authed' | 'public' | 'emails',
  files: Array<{ path: string; body: Buffer; contentType?: string }>,
  entryPath: string | null = null,
): Promise<{ userId: string; ownerUserId: string; dropId: string }> {
  const { db } = await import('@/db');
  const { users, drops: dropsTbl, dropVersions } = await import('@/db/schema');
  const [u] = await db.insert(users).values({ email, username, kind }).returning();
  const prefix = `drops/${dropName}-${Math.random().toString(36).slice(2)}/`;
  const { putObject } = await import('@/lib/r2');
  for (const f of files) await putObject(prefix + f.path, f.body, f.contentType);
  const [drop] = await db.insert(dropsTbl).values({ ownerId: u!.id, name: dropName, viewMode: mode }).returning();
  const [ver] = await db.insert(dropVersions).values({
    dropId: drop!.id,
    r2Prefix: prefix,
    byteSize: files.reduce((s, f) => s + f.body.length, 0),
    fileCount: files.length,
    entryPath,
  }).returning();
  const { eq } = await import('drizzle-orm');
  await db.update(dropsTbl).set({ currentVersion: ver!.id }).where(eq(dropsTbl.id, drop!.id));
  return { userId: u!.id, ownerUserId: u!.id, dropId: drop!.id };
}

beforeEach(async () => {
  const { db } = await import('@/db');
  const { users, sessions, drops, dropViewers, allowedEmails } = await import('@/db/schema');
  await db.delete(drops);
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(dropViewers);
  await db.delete(allowedEmails);
});

describe('drop-host bare-root entry_path serve', () => {
  it('serves a root-level entry\'s bytes at / when there is no index.html', async () => {
    const host = hostFor('alice', 'site');
    const { userId } = await makeUserAndDrop('a@e.com', 'alice', 'member', 'site', 'authed', [
      { path: 'page.html', body: Buffer.from('<html>page body</html>'), contentType: 'text/html' },
    ], 'page.html');
    const cookie = await cookieFor(userId, host);
    const res = await appInstance.inject({ method: 'GET', url: '/', headers: { host, cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('page body');
    expect(res.headers['content-type']).toContain('html');
  });

  it('redirects / to /sub/ for a nested index entry (no index.html in Location)', async () => {
    const host = hostFor('alice', 'site');
    const { userId } = await makeUserAndDrop('a@e.com', 'alice', 'member', 'site', 'authed', [
      { path: 'sub/index.html', body: Buffer.from('nested') },
    ], 'sub/index.html');
    const cookie = await cookieFor(userId, host);
    const res = await appInstance.inject({ method: 'GET', url: '/', headers: { host, cookie } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/sub/');
  });

  it('redirects / to the nested file for a nested non-index entry', async () => {
    const host = hostFor('alice', 'site');
    const { userId } = await makeUserAndDrop('a@e.com', 'alice', 'member', 'site', 'authed', [
      { path: 'sub/home.html', body: Buffer.from('home') },
    ], 'sub/home.html');
    const cookie = await cookieFor(userId, host);
    const res = await appInstance.inject({ method: 'GET', url: '/', headers: { host, cookie } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/sub/home.html');
  });

  it('does not loop: GET /sub/ after the nested-index redirect serves 200 via dir->index fallback', async () => {
    const host = hostFor('alice', 'site');
    const { userId } = await makeUserAndDrop('a@e.com', 'alice', 'member', 'site', 'authed', [
      { path: 'sub/index.html', body: Buffer.from('nested body') },
    ], 'sub/index.html');
    const cookie = await cookieFor(userId, host);
    const res = await appInstance.inject({ method: 'GET', url: '/sub/', headers: { host, cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('nested body');
  });

  it('serves a root-level entry with spaces at / (no encoding needed for bytes)', async () => {
    const host = hostFor('alice', 'site');
    const { userId } = await makeUserAndDrop('a@e.com', 'alice', 'member', 'site', 'authed', [
      { path: 'Proptics Website.html', body: Buffer.from('<html>proptics</html>'), contentType: 'text/html' },
    ], 'Proptics Website.html');
    const cookie = await cookieFor(userId, host);
    const res = await appInstance.inject({ method: 'GET', url: '/', headers: { host, cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('proptics');
  });

  it('percent-encodes the redirect target for a nested index entry with spaces', async () => {
    const host = hostFor('alice', 'site');
    const { userId } = await makeUserAndDrop('a@e.com', 'alice', 'member', 'site', 'authed', [
      { path: 'a b/index.html', body: Buffer.from('spaced') },
    ], 'a b/index.html');
    const cookie = await cookieFor(userId, host);
    const res = await appInstance.inject({ method: 'GET', url: '/', headers: { host, cookie } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/a%20b/');
  });

  it('regression: a drop with a real root index.html and entry_path NULL serves index.html at /', async () => {
    const host = hostFor('alice', 'site');
    const { userId } = await makeUserAndDrop('a@e.com', 'alice', 'member', 'site', 'authed', [
      { path: 'index.html', body: Buffer.from('<html>root index</html>'), contentType: 'text/html' },
    ], null);
    const cookie = await cookieFor(userId, host);
    const res = await appInstance.inject({ method: 'GET', url: '/', headers: { host, cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('root index');
  });
});
