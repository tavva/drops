// ABOUTME: Integration coverage for the bearer-authenticated CLI list APIs.
// ABOUTME: Pins auth, owner scoping, ordering, unknown drops, and file sizes.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db';
import { cliTokens, drops, users } from '@/db/schema';
import { config } from '@/config';
import { dropOriginFor } from '@/lib/dropHost';
import { putObject } from '@/lib/r2';
import { onAppHost } from '@/middleware/host';
import { registerCsrf } from '@/middleware/csrf';
import { registerRateLimit } from '@/middleware/rateLimit';
import { cliListRoutes } from '@/routes/cli/list';
import { buildServer } from '@/server';
import { createDropAndVersion } from '@/services/drops';
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
    await server.register(cliListRoutes);
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
      url: dropOriginFor('alice', 'older'),
      updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      byteSize: 10,
      fileCount: 1,
      entryPath: null,
      versionId: first.versionId,
    });
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
    expect(payload.files).toEqual(expect.arrayContaining([
      { path: 'index.html', size: Buffer.byteLength('<h1>hello</h1>') },
      { path: 'assets/app.js', size: Buffer.byteLength('console.log(1);\n') },
    ]));
    expect(payload.files).toHaveLength(2);
  });
});
