import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { resetBucket } from '../helpers/r2';

let appInstance: Awaited<ReturnType<typeof import('@/server').buildServer>>;

beforeAll(async () => {
  await resetBucket();
  const { buildServer } = await import('@/server');
  const { onAppHost } = await import('@/middleware/host');
  const { registerCsrf } = await import('@/middleware/csrf');
  const { editDropRoute } = await import('@/routes/app/editDrop');
  const { deleteDropRoute } = await import('@/routes/app/deleteDrop');
  appInstance = await buildServer();
  await appInstance.register(onAppHost(async (s) => {
    await registerCsrf(s);
    await s.register(editDropRoute);
    await s.register(deleteDropRoute);
  }));
});

afterAll(async () => { await appInstance.close(); });

let aliceId: string;
let bobId: string;
let aliceCookie: string;
let bobCookie: string;
let aliceCsrf: string;

beforeEach(async () => {
  const { db } = await import('@/db');
  const { users, drops, sessions } = await import('@/db/schema');
  await db.delete(drops);
  await db.delete(sessions);
  await db.delete(users);
  const [a] = await db.insert(users).values({ email: 'a@b.com', username: 'alice' }).returning();
  const [b] = await db.insert(users).values({ email: 'b@b.com', username: 'bob' }).returning();
  aliceId = a!.id; bobId = b!.id;

  const { createSession } = await import('@/services/sessions');
  const { signCookie } = await import('@/lib/cookies');
  const { config } = await import('@/config');
  const { issueCsrfToken } = await import('@/lib/csrf');
  const aSid = await createSession(aliceId);
  const bSid = await createSession(bobId);
  aliceCsrf = issueCsrfToken(aSid);
  aliceCookie = `drops_session=${signCookie(aSid, config.SESSION_SECRET)}; drops_csrf=${aliceCsrf}`;
  bobCookie = `drops_session=${signCookie(bSid, config.SESSION_SECRET)}`;
});

describe('edit + delete drop', () => {
  it('GET edit page for non-existent drop → 404', async () => {
    const res = await appInstance.inject({
      method: 'GET', url: '/app/drops/missing',
      headers: { host: 'drops.localtest.me', cookie: aliceCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET edit page for owned drop renders metadata', async () => {
    const { createDropAndVersion } = await import('@/services/drops');
    await createDropAndVersion(aliceId, 'site', { r2Prefix: 'drops/v1/', byteSize: 10, fileCount: 2 });
    const res = await appInstance.inject({
      method: 'GET', url: '/app/drops/site',
      headers: { host: 'drops.localtest.me', cookie: aliceCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Drop: site');
    expect(res.body).toContain('2 files');
  });

  it('GET edit page for another user\'s drop → 404', async () => {
    const { createDropAndVersion } = await import('@/services/drops');
    await createDropAndVersion(aliceId, 'site', { r2Prefix: 'drops/v1/', byteSize: 10, fileCount: 2 });
    const res = await appInstance.inject({
      method: 'GET', url: '/app/drops/site',
      headers: { host: 'drops.localtest.me', cookie: bobCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST delete removes DB row and clears R2 prefix', async () => {
    const { createDropAndVersion } = await import('@/services/drops');
    const { putObject, listPrefix } = await import('@/lib/r2');
    const prefix = `drops/delete-me/`;
    await putObject(prefix + 'index.html', Buffer.from('bye'));
    await createDropAndVersion(aliceId, 'gone', { r2Prefix: prefix, byteSize: 3, fileCount: 1 });

    const res = await appInstance.inject({
      method: 'POST', url: '/app/drops/gone/delete',
      headers: {
        host: 'drops.localtest.me',
        origin: 'http://drops.localtest.me:3000',
        cookie: aliceCookie,
        'x-csrf-token': aliceCsrf,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `_csrf=${encodeURIComponent(aliceCsrf)}`,
    });
    expect(res.statusCode).toBe(302);
    const { findByOwnerAndName } = await import('@/services/drops');
    expect(await findByOwnerAndName(aliceId, 'gone')).toBeNull();

    await new Promise((r) => setTimeout(r, 200));
    expect(await listPrefix(prefix)).toEqual([]);
  });

  it('edit page renders viewer list when mode is emails', async () => {
    const { db } = await import('@/db');
    const { drops, dropViewers } = await import('@/db/schema');
    const { eq } = await import('drizzle-orm');
    const { createDropAndVersion } = await import('@/services/drops');
    await createDropAndVersion(aliceId, 'withlist', { r2Prefix: 'drops/wl/', byteSize: 1, fileCount: 1 });
    const [row] = await db.select().from(drops).where(eq(drops.ownerId, aliceId));
    await db.update(drops).set({ viewMode: 'emails' }).where(eq(drops.id, row!.id));
    await db.insert(dropViewers).values([
      { dropId: row!.id, email: 'one@out.test' },
      { dropId: row!.id, email: 'two@out.test' },
    ]);
    const res = await appInstance.inject({
      method: 'GET', url: '/app/drops/withlist',
      headers: { host: 'drops.localtest.me', cookie: aliceCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('one@out.test');
    expect(res.body).toContain('two@out.test');
    expect(res.body).toContain('Who can view');
  });
});
