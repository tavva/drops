import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { resetBucket } from '../helpers/r2';

let appInstance: Awaited<ReturnType<typeof import('@/server').buildServer>>;

beforeAll(async () => {
  await resetBucket();
  const { buildServer } = await import('@/server');
  const { onContentHost } = await import('@/middleware/host');
  const { contentServeRoute } = await import('@/routes/content/serve');
  appInstance = await buildServer();
  await appInstance.register(onContentHost(contentServeRoute));
});

afterAll(async () => { await appInstance.close(); });

let userId: string;
let cookie: string;
beforeEach(async () => {
  const { db } = await import('@/db');
  const { users, drops, sessions } = await import('@/db/schema');
  await db.delete(drops);
  await db.delete(sessions);
  await db.delete(users);
  const [u] = await db.insert(users).values({ email: 'a@b.com', username: 'alice' }).returning();
  userId = u!.id;
  const { createSession } = await import('@/services/sessions');
  const { signCookie } = await import('@/lib/cookies');
  const { config } = await import('@/config');
  const sid = await createSession(userId);
  cookie = `drops_content_session=${signCookie(sid, config.SESSION_SECRET)}`;
});

async function makeDrop(name: string, files: Array<{ path: string; body: Buffer; contentType?: string }>) {
  const { putObject } = await import('@/lib/r2');
  const { createDropAndVersion } = await import('@/services/drops');
  const prefix = `drops/${name}-v/`;
  for (const f of files) await putObject(prefix + f.path, f.body, f.contentType);
  await createDropAndVersion(userId, name, {
    r2Prefix: prefix, byteSize: files.reduce((s, f) => s + f.body.length, 0), fileCount: files.length,
  });
}

describe('content serve', () => {
  it('redirects missing trailing slash to trailing slash', async () => {
    await makeDrop('site', [{ path: 'index.html', body: Buffer.from('<html>hi</html>'), contentType: 'text/html' }]);
    const res = await appInstance.inject({
      method: 'GET', url: '/alice/site',
      headers: { host: 'content.localtest.me', cookie },
    });
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe('http://content.localtest.me:3000/alice/site/');
  });

  it('serves index.html for /', async () => {
    await makeDrop('site', [{ path: 'index.html', body: Buffer.from('<html>hi</html>'), contentType: 'text/html' }]);
    const res = await appInstance.inject({
      method: 'GET', url: '/alice/site/',
      headers: { host: 'content.localtest.me', cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('hi');
    expect(res.headers['content-type']).toContain('html');
  });

  it('falls back to directory index.html for path without extension', async () => {
    await makeDrop('site', [
      { path: 'index.html', body: Buffer.from('root') },
      { path: 'about/index.html', body: Buffer.from('about') },
    ]);
    const res = await appInstance.inject({
      method: 'GET', url: '/alice/site/about',
      headers: { host: 'content.localtest.me', cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('about');
  });

  it('unauthenticated request redirects to login', async () => {
    const res = await appInstance.inject({
      method: 'GET', url: '/alice/site/',
      headers: { host: 'content.localtest.me' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('/auth/login');
  });

  it('returns 404 for unknown username', async () => {
    const res = await appInstance.inject({
      method: 'GET', url: '/nobody/site/',
      headers: { host: 'content.localtest.me', cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for unknown drop', async () => {
    const res = await appInstance.inject({
      method: 'GET', url: '/alice/missing/',
      headers: { host: 'content.localtest.me', cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('serves the sole file in a drop when / is requested and there is no index.html', async () => {
    await makeDrop('notes', [{ path: 'note.md', body: Buffer.from('# hi\n'), contentType: 'text/markdown; charset=utf-8' }]);
    const res = await appInstance.inject({
      method: 'GET', url: '/alice/notes/',
      headers: { host: 'content.localtest.me', cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('# hi');
    expect(res.headers['content-type']).toContain('markdown');
  });

  it('does NOT fall back to the sole file when the drop has multiple files', async () => {
    await makeDrop('multi', [
      { path: 'a.md', body: Buffer.from('a') },
      { path: 'b.md', body: Buffer.from('b') },
    ]);
    const res = await appInstance.inject({
      method: 'GET', url: '/alice/multi/',
      headers: { host: 'content.localtest.me', cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 304 when If-None-Match matches', async () => {
    await makeDrop('site', [{ path: 'index.html', body: Buffer.from('hi') }]);
    const first = await appInstance.inject({
      method: 'GET', url: '/alice/site/',
      headers: { host: 'content.localtest.me', cookie },
    });
    const etag = first.headers.etag as string | undefined;
    expect(etag).toBeTruthy();
    const second = await appInstance.inject({
      method: 'GET', url: '/alice/site/',
      headers: { host: 'content.localtest.me', cookie, 'if-none-match': etag! },
    });
    expect(second.statusCode).toBe(304);
  });
});
