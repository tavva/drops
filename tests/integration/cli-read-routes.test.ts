// ABOUTME: Integration coverage for the bearer-authenticated CLI read APIs.
// ABOUTME: Pins auth, view permissions, identical refusals, scopes, owners, and file sizes.
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db';
import { cliTokens, drops, users } from '@/db/schema';
import { config } from '@/config';
import { dropOriginFor } from '@/lib/dropHost';
import { putObject } from '@/lib/r2';
import { onAppHost } from '@/middleware/host';
import { registerCsrf } from '@/middleware/csrf';
import { registerRateLimit } from '@/middleware/rateLimit';
import { cliReadRoutes } from '@/routes/cli/read';
import { buildServer } from '@/server';
import { createDropAndVersion } from '@/services/drops';
import { addViewer } from '@/services/dropViewers';
import { setIncludeDomain, setViewMode, type ViewMode } from '@/services/permissions';
import { resetBucket } from '../helpers/r2';

let appInstance: Awaited<ReturnType<typeof buildServer>>;
let ownerId: string;
let rawToken: string;

beforeAll(async () => {
  await resetBucket();
  appInstance = await buildServer();
  await appInstance.register(onAppHost(async (server) => {
    await registerRateLimit(server);
    await registerCsrf(server);
    await server.register(cliReadRoutes);
  }));
});

afterAll(async () => { await appInstance.close(); });

beforeEach(async () => {
  await resetBucket();
  await db.delete(cliTokens);
  await db.delete(drops);
  await db.delete(users);
  const [owner] = await db.insert(users).values({
    email: `${randomUUID()}@example.com`,
    username: 'alice',
  }).returning();
  ownerId = owner!.id;
  rawToken = `drops_cli_${randomUUID().replaceAll('-', '')}`;
  await db.insert(cliTokens).values({
    userId: ownerId,
    tokenHash: createHash('sha256').update(rawToken).digest('hex'),
    label: 'Test token',
  });
});

async function insertBob() {
  const [bob] = await db.insert(users).values({
    email: `${randomUUID()}@elsewhere.test`, username: 'bob',
  }).returning();
  return bob!;
}

async function bobDrop(bobId: string, name: string, viewMode: ViewMode, prefix = `drops/${randomUUID()}/`) {
  const created = await createDropAndVersion(bobId, name, { r2Prefix: prefix, byteSize: 5, fileCount: 1 });
  await setViewMode(created.dropId, viewMode);
  return created;
}

async function aliceEmail() {
  const [alice] = await db.select().from(users).where(eq(users.id, ownerId));
  return alice!.email;
}

function get(url: string, headers: Record<string, string> = {}) {
  return appInstance.inject({
    method: 'GET',
    url,
    headers: { host: 'drops.localtest.me', authorization: `Bearer ${rawToken}`, ...headers },
  });
}

describe('GET /api/v1/drops', () => {
  it('requires a bearer token', async () => {
    const response = await appInstance.inject({
      method: 'GET',
      url: '/api/v1/drops',
      headers: { host: 'drops.localtest.me' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns an empty list when the user owns no drops', async () => {
    const response = await get('/api/v1/drops');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ instance: config.APP_ORIGIN, drops: [] });
  });

  it('lists only the owner drops, newest first, with version metadata', async () => {
    const first = await createDropAndVersion(ownerId, 'older', {
      r2Prefix: `drops/${randomUUID()}/`, byteSize: 10, fileCount: 1,
    });
    await createDropAndVersion(ownerId, 'newer', {
      r2Prefix: `drops/${randomUUID()}/`, byteSize: 20, fileCount: 2,
    });
    const [other] = await db.insert(users).values({
      email: `${randomUUID()}@example.com`, username: 'bob',
    }).returning();
    await createDropAndVersion(other!.id, 'not-mine', {
      r2Prefix: `drops/${randomUUID()}/`, byteSize: 5, fileCount: 1,
    });

    const response = await get('/api/v1/drops');
    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.instance).toBe(config.APP_ORIGIN);
    expect(payload.drops.map((d: { name: string }) => d.name)).toEqual(['newer', 'older']);
    expect(payload.drops[1]).toEqual({
      name: 'older',
      owner: 'alice',
      url: dropOriginFor('alice', 'older'),
      updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      byteSize: 10,
      fileCount: 1,
      entryPath: null,
      versionId: first.versionId,
    });
  });
});

describe('GET /api/v1/drops scopes', () => {
  it('treats scope=mine like the default', async () => {
    await createDropAndVersion(ownerId, 'mine', { r2Prefix: `drops/${randomUUID()}/`, byteSize: 1, fileCount: 1 });
    const bob = await insertBob();
    await bobDrop(bob.id, 'shared', 'public');
    const response = await get('/api/v1/drops?scope=mine');
    expect(response.statusCode).toBe(200);
    expect(response.json().drops.map((d: { name: string }) => d.name)).toEqual(['mine']);
  });

  it('lists every drop the caller can view with scope=all', async () => {
    const own = await createDropAndVersion(ownerId, 'mine', {
      r2Prefix: `drops/${randomUUID()}/`, byteSize: 1, fileCount: 1,
    });
    const bob = await insertBob();
    await bobDrop(bob.id, 'open', 'public');
    await bobDrop(bob.id, 'members', 'authed');
    const listed = await bobDrop(bob.id, 'listed', 'emails');
    await addViewer(listed.dropId, await aliceEmail());
    const domain = await bobDrop(bob.id, 'domain', 'emails');
    await setIncludeDomain(domain.dropId, true);
    await bobDrop(bob.id, 'secret', 'emails');

    const response = await get('/api/v1/drops?scope=all');
    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.instance).toBe(config.APP_ORIGIN);
    const byName = Object.fromEntries(payload.drops.map((d: { name: string }) => [d.name, d]));
    expect(Object.keys(byName).sort()).toEqual(['domain', 'listed', 'members', 'mine', 'open']);
    expect(byName.open).toMatchObject({ owner: 'bob', url: dropOriginFor('bob', 'open'), fileCount: 1 });
    expect(byName.mine).toEqual({
      name: 'mine',
      owner: 'alice',
      url: dropOriginFor('alice', 'mine'),
      updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      byteSize: 1,
      fileCount: 1,
      entryPath: null,
      versionId: own.versionId,
    });
  });

  it('leaves out drops that canView refuses to a member no longer on the allowlist', async () => {
    await db.update(users).set({ email: `${randomUUID()}@outside.test` }).where(eq(users.id, ownerId));
    const bob = await insertBob();
    await bobDrop(bob.id, 'open', 'public');
    await bobDrop(bob.id, 'members', 'authed');
    const listed = await bobDrop(bob.id, 'listed', 'emails');
    await addViewer(listed.dropId, await aliceEmail());
    const domain = await bobDrop(bob.id, 'domain', 'emails');
    await setIncludeDomain(domain.dropId, true);
    const both = await bobDrop(bob.id, 'both', 'emails');
    await setIncludeDomain(both.dropId, true);
    await addViewer(both.dropId, await aliceEmail());
    await createDropAndVersion(ownerId, 'mine', { r2Prefix: `drops/${randomUUID()}/`, byteSize: 1, fileCount: 1 });

    const response = await get('/api/v1/drops?scope=all');
    expect(response.statusCode).toBe(200);
    expect(response.json().drops.map((d: { name: string }) => d.name).sort())
      .toEqual(['both', 'listed', 'mine', 'open']);
  });

  it('rejects an unknown scope', async () => {
    const response = await get('/api/v1/drops?scope=everything');
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_scope');
  });
});

describe('GET /api/v1/drops/:name/files', () => {
  it('requires a bearer token', async () => {
    const response = await appInstance.inject({
      method: 'GET',
      url: '/api/v1/drops/site/files',
      headers: { host: 'drops.localtest.me' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects an invalid slug', async () => {
    const response = await get('/api/v1/drops/NOT%20VALID/files');
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_name');
  });

  it("returns 404 for an unknown drop and for another user's drop", async () => {
    const [other] = await db.insert(users).values({
      email: `${randomUUID()}@example.com`, username: 'bob',
    }).returning();
    await createDropAndVersion(other!.id, 'not-mine', {
      r2Prefix: `drops/${randomUUID()}/`, byteSize: 5, fileCount: 1,
    });
    for (const name of ['missing', 'not-mine']) {
      const response = await get(`/api/v1/drops/${name}/files`);
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('drop_not_found');
    }
  });

  it('lists file paths and sizes for the current version', async () => {
    const prefix = `drops/${randomUUID()}/`;
    await putObject(`${prefix}index.html`, Buffer.from('<h1>hello</h1>'));
    await putObject(`${prefix}assets/app.js`, Buffer.from('console.log(1);\n'));
    await createDropAndVersion(ownerId, 'site', { r2Prefix: prefix, byteSize: 30, fileCount: 2 });

    const response = await get('/api/v1/drops/site/files');
    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.instance).toBe(config.APP_ORIGIN);
    expect(payload.name).toBe('site');
    expect(Object.keys(payload).sort()).toEqual(['files', 'instance', 'name']);
    expect(payload.files).toEqual(expect.arrayContaining([
      { path: 'index.html', size: Buffer.byteLength('<h1>hello</h1>') },
      { path: 'assets/app.js', size: Buffer.byteLength('console.log(1);\n') },
    ]));
    expect(payload.files).toHaveLength(2);
  });
});

async function bobSite(viewMode: ViewMode, name = 'site') {
  const bob = await insertBob();
  const prefix = `drops/${randomUUID()}/`;
  await putObject(`${prefix}index.html`, Buffer.from('<h1>bob</h1>'), 'text/html');
  await putObject(`${prefix}sub/index.html`, Buffer.from('<h1>sub</h1>'), 'text/html');
  await putObject(`${prefix}image.bin`, Buffer.from([0, 1, 2, 255, 254]), 'application/octet-stream');
  const created = await bobDrop(bob.id, name, viewMode, prefix);
  return { bob, ...created };
}

describe('GET /api/v1/drops/:name/files?owner=', () => {
  it('requires a bearer token', async () => {
    const response = await appInstance.inject({
      method: 'GET',
      url: '/api/v1/drops/site/files?owner=bob',
      headers: { host: 'drops.localtest.me' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects an invalid owner or drop name', async () => {
    for (const url of ['/api/v1/drops/site/files?owner=NOT%20VALID', '/api/v1/drops/NOT%20VALID/files?owner=bob']) {
      const response = await get(url);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('invalid_name');
    }
  });

  it('lists a public drop owned by another user with its owner and version', async () => {
    const { versionId } = await bobSite('public');
    const response = await get('/api/v1/drops/site/files?owner=bob');
    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload).toMatchObject({ instance: config.APP_ORIGIN, owner: 'bob', name: 'site', versionId });
    expect(payload.files).toEqual(expect.arrayContaining([
      { path: 'index.html', size: Buffer.byteLength('<h1>bob</h1>') },
      { path: 'sub/index.html', size: Buffer.byteLength('<h1>sub</h1>') },
      { path: 'image.bin', size: 5 },
    ]));
    expect(payload.files).toHaveLength(3);
  });

  it('lists the caller\'s own drop when the owner is named', async () => {
    const prefix = `drops/${randomUUID()}/`;
    await putObject(`${prefix}index.html`, Buffer.from('mine'));
    await createDropAndVersion(ownerId, 'mine', { r2Prefix: prefix, byteSize: 4, fileCount: 1 });
    const response = await get('/api/v1/drops/mine/files?owner=alice');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ owner: 'alice', name: 'mine', files: [{ path: 'index.html', size: 4 }] });
  });

  it('returns a null version and no files for a drop without a current version', async () => {
    const { dropId } = await bobSite('public');
    await db.update(drops).set({ currentVersion: null }).where(eq(drops.id, dropId));
    const response = await get('/api/v1/drops/site/files?owner=bob');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      instance: config.APP_ORIGIN, owner: 'bob', name: 'site', versionId: null, files: [],
    });
  });

  it('gives a refused drop, an unknown owner and an unknown drop the same 404', async () => {
    await bobSite('emails');
    const bodies = [];
    for (const url of ['/api/v1/drops/site/files?owner=bob', '/api/v1/drops/site/files?owner=carol', '/api/v1/drops/missing/files?owner=bob']) {
      const response = await get(url);
      expect(response.statusCode).toBe(404);
      bodies.push(response.body);
    }
    expect(JSON.parse(bodies[0]!).error.code).toBe('drop_not_found');
    expect(new Set(bodies).size).toBe(1);
  });
});
