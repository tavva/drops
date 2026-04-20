// ABOUTME: Drop-host content serving: lookup drop by hostname, canView gate, R2 stream, ETag, fallbacks.
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

describe('drop-host content serve', () => {
  it('serves index.html at /', async () => {
    const host = hostFor('alice', 'site');
    const { userId } = await makeUserAndDrop('a@e.com', 'alice', 'member', 'site', 'authed', [
      { path: 'index.html', body: Buffer.from('<html>hi</html>'), contentType: 'text/html' },
    ]);
    const cookie = await cookieFor(userId, host);
    const res = await appInstance.inject({ method: 'GET', url: '/', headers: { host, cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('hi');
    expect(res.headers['content-type']).toContain('html');
  });

  it('falls back to /about/index.html for /about', async () => {
    const host = hostFor('alice', 'site');
    const { userId } = await makeUserAndDrop('a@e.com', 'alice', 'member', 'site', 'authed', [
      { path: 'index.html', body: Buffer.from('root') },
      { path: 'about/index.html', body: Buffer.from('about') },
    ]);
    const cookie = await cookieFor(userId, host);
    const res = await appInstance.inject({ method: 'GET', url: '/about', headers: { host, cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('about');
  });

  it('serves the sole file when no index.html exists', async () => {
    const host = hostFor('alice', 'notes');
    const { userId } = await makeUserAndDrop('a@e.com', 'alice', 'member', 'notes', 'authed', [
      { path: 'note.md', body: Buffer.from('# hi\n'), contentType: 'text/markdown; charset=utf-8' },
    ]);
    const cookie = await cookieFor(userId, host);
    const res = await appInstance.inject({ method: 'GET', url: '/', headers: { host, cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('# hi');
  });

  it('does NOT fall back to a sole file when the drop has multiple files', async () => {
    const host = hostFor('alice', 'multi');
    const { userId } = await makeUserAndDrop('a@e.com', 'alice', 'member', 'multi', 'authed', [
      { path: 'a.md', body: Buffer.from('a') },
      { path: 'b.md', body: Buffer.from('b') },
    ]);
    const cookie = await cookieFor(userId, host);
    const res = await appInstance.inject({ method: 'GET', url: '/', headers: { host, cookie } });
    expect(res.statusCode).toBe(404);
  });

  it('returns 304 when If-None-Match matches', async () => {
    const host = hostFor('alice', 'site');
    const { userId } = await makeUserAndDrop('a@e.com', 'alice', 'member', 'site', 'authed', [
      { path: 'index.html', body: Buffer.from('hi') },
    ]);
    const cookie = await cookieFor(userId, host);
    const first = await appInstance.inject({ method: 'GET', url: '/', headers: { host, cookie } });
    const etag = first.headers.etag as string | undefined;
    expect(etag).toBeTruthy();
    const second = await appInstance.inject({ method: 'GET', url: '/', headers: { host, cookie, 'if-none-match': etag! } });
    expect(second.statusCode).toBe(304);
  });

  it('bounces to drop-bootstrap without cookie', async () => {
    const host = hostFor('alice', 'site');
    await makeUserAndDrop('a@e.com', 'alice', 'member', 'site', 'authed', [
      { path: 'index.html', body: Buffer.from('hi') },
    ]);
    const res = await appInstance.inject({ method: 'GET', url: '/', headers: { host } });
    expect(res.statusCode).toBe(302);
    expect((res.headers.location as string)).toContain('/auth/drop-bootstrap');
  });

  it('404s when host does not resolve to a drop (owner missing)', async () => {
    const host = hostFor('nobody', 'nope');
    // Create a session for some *other* real user so the cookie itself is valid.
    const { db } = await import('@/db');
    const { users } = await import('@/db/schema');
    const [u] = await db.insert(users).values({ email: 'x@e.com', username: 'bob', kind: 'member' }).returning();
    const cookie = await cookieFor(u!.id, host);
    const res = await appInstance.inject({ method: 'GET', url: '/', headers: { host, cookie } });
    expect(res.statusCode).toBe(404);
  });

  describe('canView matrix', () => {
    it('authed mode: member gets 200, viewer gets 404', async () => {
      const host = hostFor('owner', 'site');
      const { db } = await import('@/db');
      const { allowedEmails } = await import('@/db/schema');
      await db.insert(allowedEmails).values({ email: 'member@allowed.test' });
      await makeUserAndDrop('owner@example.com', 'owner', 'member', 'site', 'authed', [
        { path: 'index.html', body: Buffer.from('ok') },
      ]);
      const { users } = await import('@/db/schema');
      const [member] = await db.insert(users).values({ email: 'member@allowed.test', username: 'member', kind: 'member' }).returning();
      const [viewer] = await db.insert(users).values({ email: 'out@out.test', username: null, kind: 'viewer' }).returning();
      const memCookie = await cookieFor(member!.id, host);
      const vwrCookie = await cookieFor(viewer!.id, host);
      const ok = await appInstance.inject({ method: 'GET', url: '/', headers: { host, cookie: memCookie } });
      expect(ok.statusCode).toBe(200);
      const ko = await appInstance.inject({ method: 'GET', url: '/', headers: { host, cookie: vwrCookie } });
      expect(ko.statusCode).toBe(404);
    });

    it('public mode: viewer gets 200', async () => {
      const host = hostFor('owner', 'site');
      await makeUserAndDrop('owner@example.com', 'owner', 'member', 'site', 'public', [
        { path: 'index.html', body: Buffer.from('ok') },
      ]);
      const { db } = await import('@/db');
      const { users } = await import('@/db/schema');
      const [v] = await db.insert(users).values({ email: 'any@any.test', username: null, kind: 'viewer' }).returning();
      const cookie = await cookieFor(v!.id, host);
      const res = await appInstance.inject({ method: 'GET', url: '/', headers: { host, cookie } });
      expect(res.statusCode).toBe(200);
    });

    it('emails mode: listed viewer 200, stranger 404', async () => {
      const host = hostFor('owner', 'site');
      const { dropId } = await makeUserAndDrop('owner@example.com', 'owner', 'member', 'site', 'emails', [
        { path: 'index.html', body: Buffer.from('ok') },
      ]);
      const { addViewer } = await import('@/services/dropViewers');
      await addViewer(dropId, 'listed@out.test');
      const { db } = await import('@/db');
      const { users } = await import('@/db/schema');
      const [listed] = await db.insert(users).values({ email: 'listed@out.test', username: null, kind: 'viewer' }).returning();
      const [stranger] = await db.insert(users).values({ email: 'stranger@out.test', username: null, kind: 'viewer' }).returning();
      const listedCookie = await cookieFor(listed!.id, host);
      const strangerCookie = await cookieFor(stranger!.id, host);
      const ok = await appInstance.inject({ method: 'GET', url: '/', headers: { host, cookie: listedCookie } });
      expect(ok.statusCode).toBe(200);
      const ko = await appInstance.inject({ method: 'GET', url: '/', headers: { host, cookie: strangerCookie } });
      expect(ko.statusCode).toBe(404);
    });

    it('owner sees their own emails-mode drop', async () => {
      const host = hostFor('owner', 'site');
      const { ownerUserId } = await makeUserAndDrop('owner@example.com', 'owner', 'member', 'site', 'emails', [
        { path: 'index.html', body: Buffer.from('ok') },
      ]);
      const cookie = await cookieFor(ownerUserId, host);
      const res = await appInstance.inject({ method: 'GET', url: '/', headers: { host, cookie } });
      expect(res.statusCode).toBe(200);
    });
  });
});
