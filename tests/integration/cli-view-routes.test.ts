// ABOUTME: Exercises CLI content reads and browser handoffs against real Postgres and object storage.
// ABOUTME: Pins permissions, path safety, host isolation, entry resolution, and token revocation.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { config } from '@/config';
import { db } from '@/db';
import { cliTokens, drops, users } from '@/db/schema';
import { signHandoff } from '@/lib/handoff';
import { putObject } from '@/lib/r2';
import { onAppHost, onDropHost } from '@/middleware/host';
import { registerCsrf } from '@/middleware/csrf';
import { cliViewRoutes } from '@/routes/cli/view';
import { cliApiAuthRoutes } from '@/routes/cli/apiAuth';
import { bootstrapRoute } from '@/routes/auth/bootstrap';
import { dropServeRoute } from '@/routes/content/dropServe';
import { buildServer } from '@/server';
import { createDropAndVersion, setEntryPath } from '@/services/drops';
import { resetBucket } from '../helpers/r2';

let app: Awaited<ReturnType<typeof buildServer>>;
let ownerId: string;
let tokenId: string;
let dropId: string;
let token: string;
const appHost = 'drops.localtest.me';
const dropHost = 'alice--site.content.localtest.me';

beforeAll(async () => {
  app = await buildServer();
  await app.register(onAppHost(async (server) => {
    await registerCsrf(server);
    await server.register(cliViewRoutes);
    await server.register(cliApiAuthRoutes);
  }));
  await app.register(onDropHost(async (server) => {
    await server.register(bootstrapRoute);
    await server.register(dropServeRoute);
  }));
});
afterAll(async () => { await app.close(); });
beforeEach(async () => {
  await resetBucket();
  await db.delete(drops);
  await db.delete(users);
  const [owner] = await db.insert(users).values({ email: 'alice@example.com', username: 'alice' }).returning();
  ownerId = owner!.id;
  token = `drops_cli_${randomUUID()}`;
  const [created] = await db.insert(cliTokens).values({ userId: ownerId,
    tokenHash: createHash('sha256').update(token).digest('hex'), label: 'Test' }).returning();
  tokenId = created!.id;
  const prefix = `drops/${randomUUID()}/`;
  await putObject(prefix + 'docs/index.html', Buffer.from('<h1>Private content</h1>'), 'text/html');
  await putObject(prefix + 'docs/a b.txt', Buffer.from('asset'), 'text/plain');
  const createdDrop = await createDropAndVersion(ownerId, 'site', {
    r2Prefix: prefix, byteSize: 30, fileCount: 2,
  });
  dropId = createdDrop.dropId;
  await setEntryPath(createdDrop.versionId, 'docs/index.html');
  await db.update(drops).set({ viewMode: 'emails', includeDomain: false }).where(eq(drops.id, dropId));
});

function api(action: 'content' | 'open', query = '', credential = token) {
  return app.inject({ method: action === 'open' ? 'POST' : 'GET',
    url: `/api/v1/drops/site/${action}${query}`, headers: { host: appHost, authorization: `Bearer ${credential}` } });
}
async function bootstrap(openUrl: string, host = dropHost) {
  const url = new URL(openUrl);
  return app.inject({ method: 'GET', url: url.pathname + url.search, headers: { host } });
}

describe('CLI content reads', () => {
  it('reads the nested entry point without redirects and keeps HTML inert on the app origin', async () => {
    const response = await api('content');
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('<h1>Private content</h1>');
    expect(response.headers['x-drops-path']).toBe('docs/index.html');
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['content-disposition']).toBe('attachment');
    expect(response.headers['content-security-policy']).toContain('sandbox');
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it('resolves directories and encoded filenames', async () => {
    expect((await api('content', '?path=docs/')).body).toContain('Private content');
    expect((await api('content', '?path=docs')).body).toContain('Private content');
    expect((await api('content', '?path=docs%2Fa%20b.txt')).body).toBe('asset');
  });
  it.each(['../secret', '/etc/passwd', '.env', 'docs/../index.html', 'docs//index.html', 'a\x00b'])('rejects unsafe path %s', async (path) => {
    const response = await api('content', `?path=${encodeURIComponent(path)}`);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_path');
  });
  it('returns a file error for a missing file', async () => {
    const response = await api('content', '?path=missing.txt');
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('file_not_found');
  });
  it.each(['content', 'open'] as const)('requires a live bearer token for %s', async (action) => {
    expect((await api(action, '', 'invalid')).statusCode).toBe(401);
    await db.update(cliTokens).set({ revokedAt: new Date() }).where(eq(cliTokens.id, tokenId));
    expect((await api(action)).statusCode).toBe(401);
  });
  it.each(['content', 'open'] as const)('applies viewing permissions to another owner’s drop for %s', async (action) => {
    const [other] = await db.insert(users).values({ email: 'bob@example.com', username: 'bob' }).returning();
    const otherToken = `drops_cli_${randomUUID()}`;
    await db.insert(cliTokens).values({ userId: other!.id,
      tokenHash: createHash('sha256').update(otherToken).digest('hex'), label: 'Other' });
    expect((await api(action, '?owner=alice', otherToken)).statusCode).toBe(404);
    await db.update(drops).set({ viewMode: 'authed' }).where(eq(drops.id, dropId));
    expect((await api(action, '?owner=alice', otherToken)).statusCode).toBe(200);
    expect((await api(action, '?owner=missing', otherToken)).statusCode).toBe(404);
  });
  it('keeps CLI content routes off drop hosts', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/drops/site/content',
      headers: { host: dropHost, authorization: `Bearer ${token}` } });
    expect(response.statusCode).not.toBe(200);
    expect(response.body).not.toContain('Private content');
  });
});

describe('CLI browser handoff', () => {
  it('opens a private drop with no pre-existing browser login and loads its assets', async () => {
    const response = await api('open', '?path=docs%2Fa%20b.txt');
    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.expiresIn).toBe(60);
    expect(payload.openUrl).not.toContain(token);
    const boot = await bootstrap(payload.openUrl);
    expect(boot.statusCode).toBe(302);
    expect(boot.headers.location).toBe('/docs/a%20b.txt');
    expect(boot.headers['referrer-policy']).toBe('no-referrer');
    const cookie = boot.cookies.find((c) => c.name === 'drops_drop_session')!;
    expect(cookie.domain).toBe(dropHost);
    expect(cookie.httpOnly).toBe(true);
    expect(boot.cookies.some((c) => c.name === 'drops_session')).toBe(false);
    const read = await app.inject({ method: 'GET', url: '/docs/a%20b.txt',
      headers: { host: dropHost }, cookies: { drops_drop_session: cookie.value } });
    expect(read.statusCode).toBe(200);
    expect(read.body).toBe('asset');
    const root = await app.inject({ method: 'GET', url: '/', headers: { host: dropHost },
      cookies: { drops_drop_session: cookie.value } });
    expect(root.statusCode).toBe(302);
    expect(root.headers.location).toBe('/docs/');
    const head = await app.inject({ method: 'HEAD', url: '/docs/', headers: { host: dropHost },
      cookies: { drops_drop_session: cookie.value } });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
  });
  it('rejects handoffs and cookies replayed to a sibling host', async () => {
    const response = await api('open');
    const boot = await bootstrap(response.json().openUrl);
    expect((await bootstrap(response.json().openUrl, 'alice--other.content.localtest.me')).statusCode).toBe(400);
    const cookie = boot.cookies.find((c) => c.name === 'drops_drop_session')!;
    const sibling = await app.inject({ method: 'GET', url: '/docs/',
      headers: { host: 'alice--other.content.localtest.me' }, cookies: { drops_drop_session: cookie.value } });
    expect(sibling.statusCode).toBe(302);
    expect(sibling.headers.location).toContain('/auth/drop-bootstrap');
    const identity = await app.inject({ method: 'GET', url: '/api/v1/whoami',
      headers: { host: appHost, authorization: `Bearer ${tokenId}` } });
    expect(identity.statusCode).toBe(401);
  });
  it('revokes existing cookies and unconsumed handoffs with the CLI token', async () => {
    const response = await api('open');
    const boot = await bootstrap(response.json().openUrl);
    const cookie = boot.cookies.find((c) => c.name === 'drops_drop_session')!;
    await db.update(cliTokens).set({ revokedAt: new Date() }).where(eq(cliTokens.id, tokenId));
    expect((await bootstrap(response.json().openUrl)).statusCode).toBe(400);
    const read = await app.inject({ method: 'GET', url: '/docs/', headers: { host: dropHost },
      cookies: { drops_drop_session: cookie.value } });
    expect(read.statusCode).toBe(302);
    expect(read.headers.location).toContain('/auth/drop-bootstrap');
    expect(read.body).not.toContain('Private content');
  });
  it.each(['//evil.example', '/\\evil.example', '/\nevil.example'])('keeps the browser on the drop host for unsafe next %s', async (next) => {
    const response = await api('open');
    const url = new URL(response.json().openUrl);
    url.searchParams.set('next', next);
    const boot = await bootstrap(url.href);
    expect(boot.statusCode).toBe(302);
    expect(boot.headers.location).toBe('/');
  });
  it('rejects expired browser handoffs', async () => {
    const expired = signHandoff(`cli:${tokenId}`, dropHost, config.SESSION_SECRET, -5);
    const response = await bootstrap(`http://${dropHost}/auth/bootstrap?token=${expired}`);
    expect(response.statusCode).toBe(400);
    expect(response.body).toBe('bad_token:expired');
  });
  it('checks permission changes again at bootstrap and on each content request', async () => {
    await db.update(drops).set({ ownerId: (await db.insert(users).values({
      email: 'bob@example.com', username: 'bob',
    }).returning())[0]!.id, viewMode: 'authed' }).where(eq(drops.id, dropId));
    const response = await api('open', '?owner=bob');
    const bobHost = 'bob--site.content.localtest.me';
    const boot = await bootstrap(response.json().openUrl, bobHost);
    const cookie = boot.cookies.find((c) => c.name === 'drops_drop_session')!;
    await db.update(drops).set({ viewMode: 'emails' }).where(eq(drops.id, dropId));
    expect((await bootstrap(response.json().openUrl, bobHost)).statusCode).toBe(403);
    const read = await app.inject({ method: 'GET', url: '/docs/', headers: { host: bobHost },
      cookies: { drops_drop_session: cookie.value } });
    expect(read.statusCode).toBe(404);
  });
});
