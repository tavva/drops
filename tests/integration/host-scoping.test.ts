// ABOUTME: Regression: when content-apex and drop-host routes are both registered, nested drop-host
// ABOUTME: paths must be served by the drop handler, not hijacked by the more-specific apex route.
import { describe, it, expect, afterAll, beforeAll, beforeEach } from 'vitest';
import { resetBucket } from '../helpers/r2';

let appInstance: Awaited<ReturnType<typeof import('@/server').buildServer>>;

beforeAll(async () => {
  await resetBucket();
  const { buildServer } = await import('@/server');
  const { onContentHost, onDropHost } = await import('@/middleware/host');
  const { contentServeRoute } = await import('@/routes/content/serve');
  const { dropServeRoute } = await import('@/routes/content/dropServe');
  appInstance = await buildServer();
  await appInstance.register(onContentHost(contentServeRoute));
  await appInstance.register(onDropHost(dropServeRoute));
});

afterAll(async () => { await appInstance.close(); });

beforeEach(async () => {
  const { db } = await import('@/db');
  const { users, sessions, drops, dropViewers, allowedEmails } = await import('@/db/schema');
  await db.delete(drops);
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(dropViewers);
  await db.delete(allowedEmails);
});

async function makeDrop(files: Array<{ path: string; body: Buffer; contentType?: string }>) {
  const { db } = await import('@/db');
  const { users, drops, dropVersions } = await import('@/db/schema');
  const { putObject } = await import('@/lib/r2');
  const { createSession } = await import('@/services/sessions');
  const { signDropCookie } = await import('@/lib/cookies');
  const { config } = await import('@/config');
  const [u] = await db.insert(users).values({ email: 'a@example.com', username: 'alice', kind: 'member' }).returning();
  const prefix = `drops/${Math.random().toString(36).slice(2)}/`;
  for (const f of files) await putObject(prefix + f.path, f.body, f.contentType);
  const [drop] = await db.insert(drops).values({ ownerId: u!.id, name: 'site', viewMode: 'authed' }).returning();
  const [ver] = await db.insert(dropVersions).values({
    dropId: drop!.id, r2Prefix: prefix,
    byteSize: files.reduce((s, f) => s + f.body.length, 0),
    fileCount: files.length,
  }).returning();
  const { eq } = await import('drizzle-orm');
  await db.update(drops).set({ currentVersion: ver!.id }).where(eq(drops.id, drop!.id));
  const host = `alice--site.content.localtest.me`;
  const sid = await createSession(u!.id);
  const cookie = `drops_drop_session=${signDropCookie(sid, host, config.SESSION_SECRET)}`;
  return { host, cookie };
}

describe('host-scoped routing under multiple registered plugins', () => {
  it('serves a nested path on a drop host even though /:a/:b would be more specific globally', async () => {
    const { host, cookie } = await makeDrop([
      { path: 'index.html', body: Buffer.from('<html>hi</html>'), contentType: 'text/html' },
      { path: 'components/shared.jsx', body: Buffer.from('export const x = 1;'), contentType: 'application/javascript' },
    ]);
    const res = await appInstance.inject({
      method: 'GET', url: '/components/shared.jsx',
      headers: { host, cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('export const x = 1;');
  });

  it('serves a three-segment path on a drop host', async () => {
    const { host, cookie } = await makeDrop([
      { path: 'index.html', body: Buffer.from('root') },
      { path: 'a/b/c.css', body: Buffer.from('body{}'), contentType: 'text/css' },
    ]);
    const res = await appInstance.inject({
      method: 'GET', url: '/a/b/c.css',
      headers: { host, cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('body{}');
  });

  it('still 301-redirects /<user>/<drop> on the content apex', async () => {
    await makeDrop([{ path: 'index.html', body: Buffer.from('root') }]);
    const res = await appInstance.inject({
      method: 'GET', url: '/alice/site',
      headers: { host: 'content.localtest.me' },
    });
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe('http://alice--site.content.localtest.me:3000/');
  });
});
