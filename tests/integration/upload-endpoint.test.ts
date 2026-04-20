import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildMultipart } from '../helpers/formdata';
import { resetBucket } from '../helpers/r2';

let appInstance: Awaited<ReturnType<typeof import('@/server').buildServer>>;

beforeAll(async () => {
  await resetBucket();
  const { buildServer } = await import('@/server');
  const { onAppHost } = await import('@/middleware/host');
  const { registerCsrf } = await import('@/middleware/csrf');
  const { uploadRoute } = await import('@/routes/app/upload');
  appInstance = await buildServer();
  await appInstance.register(onAppHost(async (s) => {
    await registerCsrf(s);
    await s.register(uploadRoute);
  }));
});

afterAll(async () => { await appInstance.close(); });

let userId: string;
let sid: string;
let csrfToken: string;
beforeEach(async () => {
  const { db } = await import('@/db');
  const { users, drops, sessions } = await import('@/db/schema');
  await db.delete(drops);
  await db.delete(sessions);
  await db.delete(users);
  const [u] = await db.insert(users).values({ email: 'a@b.com', username: 'alice' }).returning();
  userId = u!.id;
  const { createSession } = await import('@/services/sessions');
  const { issueCsrfToken } = await import('@/lib/csrf');
  sid = await createSession(userId);
  csrfToken = issueCsrfToken(sid);
});

async function cookies() {
  const { signCookie } = await import('@/lib/cookies');
  const { config } = await import('@/config');
  return `drops_session=${signCookie(sid, config.SESSION_SECRET)}; drops_csrf=${csrfToken}`;
}

async function doUpload(name: string, uploadType: 'folder' | 'zip', parts: Parameters<typeof buildMultipart>[0]) {
  const mp = buildMultipart(parts);
  return appInstance.inject({
    method: 'POST', url: `/app/drops/${name}/upload?upload_type=${uploadType}`,
    headers: {
      host: 'drops.localtest.me',
      origin: 'http://drops.localtest.me:3000',
      cookie: await cookies(),
      'x-csrf-token': csrfToken,
      'content-type': mp.contentType,
    },
    payload: mp.body,
  });
}

describe('POST /app/drops/:name/upload', () => {
  it('creates a new drop from folder upload', async () => {
    const res = await doUpload('site', 'folder', [
      { name: 'files', filename: 'index.html', body: '<html>', contentType: 'text/html' },
      { name: 'files', filename: 'css/style.css', body: 'body{}', contentType: 'text/css' },
    ]);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('/app/drops/site');

    const { findByOwnerAndName } = await import('@/services/drops');
    const drop = await findByOwnerAndName(userId, 'site');
    expect(drop?.version?.fileCount).toBe(2);

    const { listPrefix } = await import('@/lib/r2');
    const keys = await listPrefix(drop!.version!.r2Prefix);
    expect(keys.length).toBe(2);
  });

  it('updates an existing drop (second upload replaces current version and GCs the old)', async () => {
    const first = await doUpload('site', 'folder', [
      { name: 'files', filename: 'index.html', body: 'v1', contentType: 'text/html' },
    ]);
    expect(first.statusCode).toBe(302);

    const { findByOwnerAndName } = await import('@/services/drops');
    const afterFirst = await findByOwnerAndName(userId, 'site');
    const v1Prefix = afterFirst!.version!.r2Prefix;

    const second = await doUpload('site', 'folder', [
      { name: 'files', filename: 'index.html', body: 'v2', contentType: 'text/html' },
    ]);
    expect(second.statusCode).toBe(302);

    const afterSecond = await findByOwnerAndName(userId, 'site');
    expect(afterSecond!.version!.r2Prefix).not.toBe(v1Prefix);

    await new Promise((r) => setTimeout(r, 100));
    const { listPrefix } = await import('@/lib/r2');
    expect(await listPrefix(v1Prefix)).toEqual([]);
  });

  it('rejects a parent-segment path and does not create a drop', async () => {
    const res = await doUpload('bad', 'folder', [
      { name: 'files', filename: '../evil.html', body: 'no', contentType: 'text/html' },
    ]);
    expect(res.statusCode).toBe(400);
    const { findByOwnerAndName } = await import('@/services/drops');
    expect(await findByOwnerAndName(userId, 'bad')).toBeNull();
  });

  it('rejects a dotfile path and does not create a drop', async () => {
    const res = await doUpload('bad', 'folder', [
      { name: 'files', filename: '.git/config', body: 'no', contentType: 'text/plain' },
    ]);
    expect(res.statusCode).toBe(400);
  });

  it('rejects invalid drop name', async () => {
    const res = await doUpload('BAD_NAME', 'folder', [
      { name: 'files', filename: 'x.txt', body: 'x' },
    ]);
    expect(res.statusCode).toBe(400);
  });

  it('rejects invalid upload_type', async () => {
    const mp = buildMultipart([{ name: 'files', filename: 'x.txt', body: 'x' }]);
    const res = await appInstance.inject({
      method: 'POST', url: '/app/drops/site/upload?upload_type=weird',
      headers: {
        host: 'drops.localtest.me',
        origin: 'http://drops.localtest.me:3000',
        cookie: await cookies(),
        'x-csrf-token': csrfToken,
        'content-type': mp.contentType,
      },
      payload: mp.body,
    });
    expect(res.statusCode).toBe(400);
  });

  it('lets two different users use the same drop name', async () => {
    const { db } = await import('@/db');
    const { users } = await import('@/db/schema');
    const [bob] = await db.insert(users).values({ email: 'b@b.com', username: 'bob' }).returning();
    const { createSession } = await import('@/services/sessions');
    const { signCookie } = await import('@/lib/cookies');
    const { config } = await import('@/config');
    const { issueCsrfToken } = await import('@/lib/csrf');
    const bobSid = await createSession(bob!.id);
    const bobCsrf = issueCsrfToken(bobSid);

    // alice creates 'site'
    const a = await doUpload('site', 'folder', [
      { name: 'files', filename: 'a.html', body: 'a', contentType: 'text/html' },
    ]);
    expect(a.statusCode).toBe(302);

    // bob creates 'site' too
    const mp = buildMultipart([{ name: 'files', filename: 'b.html', body: 'b', contentType: 'text/html' }]);
    const b = await appInstance.inject({
      method: 'POST', url: '/app/drops/site/upload?upload_type=folder',
      headers: {
        host: 'drops.localtest.me',
        origin: 'http://drops.localtest.me:3000',
        cookie: `drops_session=${signCookie(bobSid, config.SESSION_SECRET)}; drops_csrf=${bobCsrf}`,
        'x-csrf-token': bobCsrf,
        'content-type': mp.contentType,
      },
      payload: mp.body,
    });
    expect(b.statusCode).toBe(302);

    const { findByOwnerAndName } = await import('@/services/drops');
    expect((await findByOwnerAndName(userId, 'site'))?.ownerId).toBe(userId);
    expect((await findByOwnerAndName(bob!.id, 'site'))?.ownerId).toBe(bob!.id);
  });
});
