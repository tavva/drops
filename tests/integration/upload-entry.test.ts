// ABOUTME: Verifies the upload route stores the detected entry page as drop_versions.entry_path.
// ABOUTME: Covers nested index, single root html, root index (null), and ambiguous (null) cases.
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

async function doUpload(name: string, parts: Parameters<typeof buildMultipart>[0]) {
  const mp = buildMultipart(parts);
  return appInstance.inject({
    method: 'POST', url: `/app/drops/${name}/upload?upload_type=folder`,
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

async function entryPathFor(name: string) {
  const { findByOwnerAndName } = await import('@/services/drops');
  const drop = await findByOwnerAndName(userId, name);
  return drop?.version?.entryPath;
}

describe('upload route stores entry_path', () => {
  it('stores the sole nested index.html as the entry path', async () => {
    const res = await doUpload('site', [
      { name: 'files', filename: 'sub/index.html', body: '<html>', contentType: 'text/html' },
      { name: 'files', filename: 'assets/x.css', body: 'body{}', contentType: 'text/css' },
    ]);
    expect(res.statusCode).toBe(302);
    expect(await entryPathFor('site')).toBe('sub/index.html');
  });

  it('stores a single root non-index html as the entry path', async () => {
    const res = await doUpload('site', [
      { name: 'files', filename: 'page.html', body: '<html>', contentType: 'text/html' },
      { name: 'files', filename: 'assets/x.css', body: 'body{}', contentType: 'text/css' },
    ]);
    expect(res.statusCode).toBe(302);
    expect(await entryPathFor('site')).toBe('page.html');
  });

  it('stores null when a root index.html is present', async () => {
    const res = await doUpload('site', [
      { name: 'files', filename: 'index.html', body: '<html>', contentType: 'text/html' },
      { name: 'files', filename: 'about.html', body: '<html>', contentType: 'text/html' },
    ]);
    expect(res.statusCode).toBe(302);
    expect(await entryPathFor('site')).toBeNull();
  });

  it('stores null when there are multiple root htmls (ambiguous)', async () => {
    const res = await doUpload('site', [
      { name: 'files', filename: 'Home.html', body: '<html>', contentType: 'text/html' },
      { name: 'files', filename: 'About.html', body: '<html>', contentType: 'text/html' },
    ]);
    expect(res.statusCode).toBe(302);
    expect(await entryPathFor('site')).toBeNull();
  });
});
