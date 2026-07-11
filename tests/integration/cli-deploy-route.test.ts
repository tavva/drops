// ABOUTME: End-to-end integration coverage for the bearer-authenticated raw ZIP deployment API.
// ABOUTME: Pins host, CSRF, length, archive, atomic replacement, JSON, URL, and serving behaviour.
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import yazl from 'yazl';
import { db } from '@/db';
import { cliAuthorizationCodes, cliTokens, drops, sessions, users } from '@/db/schema';
import { config } from '@/config';
import { dropOriginFor } from '@/lib/dropHost';
import { signCookie, signDropCookie } from '@/lib/cookies';
import { APP_SESSION_COOKIE } from '@/middleware/auth';
import { onAppHost, onDropHost } from '@/middleware/host';
import { registerCsrf } from '@/middleware/csrf';
import { registerRateLimit } from '@/middleware/rateLimit';
import { cliDeployRoute } from '@/routes/cli/deploy';
import { dropServeRoute } from '@/routes/content/dropServe';
import { buildServer } from '@/server';
import { createSession } from '@/services/sessions';
import { findByOwnerAndName } from '@/services/drops';
import { commitDeployment } from '@/services/deployments';
import { listPrefix } from '@/lib/r2';
import { resetBucket } from '../helpers/r2';

let appInstance: Awaited<ReturnType<typeof buildServer>>;
let ownerId: string;
let rawToken: string;

async function makeZip(entries: Array<{ name: string; body: string | Buffer }>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const entry of entries) zip.addBuffer(Buffer.from(entry.body), entry.name);
  zip.end();
  const chunks: Buffer[] = [];
  return await new Promise((resolve, reject) => {
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
}

beforeAll(async () => {
  await resetBucket();
  appInstance = await buildServer();
  await appInstance.register(onAppHost(async (server) => {
    await registerRateLimit(server);
    await registerCsrf(server);
    await server.register(cliDeployRoute);
    server.post('/api/v1/unrelated-json', { config: { skipCsrf: true } }, async (request) => request.body);
  }));
  await appInstance.register(onDropHost(dropServeRoute));
});

afterAll(async () => { await appInstance.close(); });

beforeEach(async () => {
  await resetBucket();
  await db.delete(cliTokens);
  await db.delete(cliAuthorizationCodes);
  await db.delete(drops);
  await db.delete(sessions);
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

function deploy(
  name: string,
  body: Buffer | Readable,
  headers: Record<string, string> = {},
  host = 'drops.localtest.me',
) {
  const length = Buffer.isBuffer(body) ? String(body.length) : undefined;
  return appInstance.inject({
    method: 'POST',
    url: `/api/v1/drops/${name}/deployments`,
    headers: {
      host,
      authorization: `Bearer ${rawToken}`,
      'content-type': 'application/zip',
      ...(length ? { 'content-length': length } : {}),
      ...headers,
    },
    payload: body,
  });
}

describe('POST /api/v1/drops/:name/deployments', () => {
  it('deploys a real ZIP, returns the exact API shape, and serves the detected entry', async () => {
    const zip = await makeZip([
      { name: 'page.html', body: '<html>deployed page</html>' },
      { name: 'asset.txt', body: 'asset' },
    ]);
    const response = await deploy('site', zip);

    expect(response.statusCode).toBe(201);
    const payload = response.json();
    expect(payload).toEqual({
      instance: config.APP_ORIGIN,
      name: 'site',
      url: dropOriginFor('alice', 'site'),
      versionId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      fileCount: 2,
      byteSize: Buffer.byteLength('<html>deployed page</html>') + Buffer.byteLength('asset'),
      entryPath: 'page.html',
    });

    const host = new URL(payload.url).hostname;
    const sessionId = await createSession(ownerId);
    const cookie = `drops_drop_session=${signDropCookie(sessionId, host, config.SESSION_SECRET)}`;
    const served = await appInstance.inject({ method: 'GET', url: '/', headers: { host, cookie } });
    expect(served.statusCode).toBe(200);
    expect(served.body).toContain('deployed page');
  });

  it('uses the bearer-token user as owner and supports atomic replacement', async () => {
    const first = await deploy('site', await makeZip([{ name: 'index.html', body: 'first' }]));
    expect(first.statusCode).toBe(201);
    const firstVersionId = first.json().versionId as string;
    const second = await deploy('site', await makeZip([{ name: 'index.html', body: 'second' }]));
    expect(second.statusCode).toBe(201);

    const drop = await findByOwnerAndName(ownerId, 'site');
    expect(drop).toMatchObject({ ownerId, currentVersion: second.json().versionId });
    expect(drop!.currentVersion).not.toBe(firstVersionId);
  });

  it('rejects invalid names with stable JSON', async () => {
    const response = await deploy('BAD_NAME', await makeZip([{ name: 'index.html', body: 'x' }]));
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: 'invalid_name', message: expect.any(String), details: null },
    });
  });

  it('requires application/zip without changing unrelated JSON parsing', async () => {
    const zip = await makeZip([{ name: 'index.html', body: 'x' }]);
    const rejected = await deploy('site', zip, { 'content-type': 'application/octet-stream' });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toEqual({
      error: { code: 'invalid_content_type', message: expect.any(String), details: null },
    });

    const unrelated = await appInstance.inject({
      method: 'POST',
      url: '/api/v1/unrelated-json',
      headers: { host: 'drops.localtest.me', 'content-type': 'application/json' },
      payload: { still: 'parsed' },
    });
    expect(unrelated.statusCode).toBe(200);
    expect(unrelated.json()).toEqual({ still: 'parsed' });
  });

  it('requires an exact integer Content-Length and enforces the compressed limit', async () => {
    const zip = await makeZip([{ name: 'index.html', body: 'x' }]);
    const missing = await deploy('site', Readable.from(zip));
    expect(missing.statusCode).toBe(411);
    expect(missing.json()).toMatchObject({ error: { code: 'length_required', details: null } });

    const invalid = await deploy('site', zip, { 'content-length': '12.5' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: 'invalid_content_length', details: null } });

    const tooLarge = await deploy('site', Buffer.from('x'), {
      'content-length': String(100 * 1024 * 1024 + 1),
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json()).toMatchObject({ error: { code: 'payload_too_large', details: null } });
  });

  it('rejects a mismatched Content-Length', async () => {
    const zip = await makeZip([{ name: 'index.html', body: 'x' }]);
    const response = await deploy('site', zip, { 'content-length': String(zip.length - 1) });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'content_length_mismatch', details: null } });
  });

  it('maps invalid archives to stable JSON and preserves the current version', async () => {
    const first = await deploy('site', await makeZip([{ name: 'index.html', body: 'first' }]));
    expect(first.statusCode).toBe(201);
    const firstVersionId = first.json().versionId as string;

    const invalid = Buffer.from('not a zip');
    const response = await deploy('site', invalid);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: 'invalid_zip', message: expect.any(String), details: null },
    });
    expect((await findByOwnerAndName(ownerId, 'site'))!.currentVersion).toBe(firstVersionId);
  });

  it('returns a generic commit error, preserves current, and removes the failed prefix', async () => {
    const first = await deploy('site', await makeZip([{ name: 'index.html', body: 'first' }]));
    expect(first.statusCode).toBe(201);
    const firstVersionId = first.json().versionId as string;
    const oldKeys = await listPrefix('drops/');

    const failingApp = await buildServer();
    await failingApp.register(onAppHost(async (server) => {
      await registerRateLimit(server);
      await registerCsrf(server);
      await server.register(cliDeployRoute, {
        commit: (input, dependencies) => commitDeployment({ ...input, versionId: 'forced-db-failure' }, dependencies),
      });
    }));
    try {
      const zip = await makeZip([{ name: 'index.html', body: 'never current' }]);
      const response = await failingApp.inject({
        method: 'POST',
        url: '/api/v1/drops/site/deployments',
        headers: {
          host: 'drops.localtest.me',
          authorization: `Bearer ${rawToken}`,
          'content-type': 'application/zip',
          'content-length': String(zip.length),
        },
        payload: zip,
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: { code: 'commit_failed', message: 'The deployment could not be committed', details: null },
      });
      expect(response.body).not.toContain('forced-db-failure');
      expect((await findByOwnerAndName(ownerId, 'site'))!.currentVersion).toBe(firstVersionId);
      expect(await listPrefix('drops/')).toEqual(oldKeys);
    } finally {
      await failingApp.close();
    }
  });

  it('is CSRF-exempt but bearer-only', async () => {
    const zip = await makeZip([{ name: 'index.html', body: 'x' }]);
    const bearer = await deploy('site', zip);
    expect(bearer.statusCode).toBe(201);

    const sid = await createSession(ownerId);
    const browserOnly = await appInstance.inject({
      method: 'POST',
      url: '/api/v1/drops/browser-only/deployments',
      headers: {
        host: 'drops.localtest.me',
        cookie: `${APP_SESSION_COOKIE}=${signCookie(sid, config.SESSION_SECRET)}`,
        'content-type': 'application/zip',
        'content-length': String(zip.length),
      },
      payload: zip,
    });
    expect(browserOnly.statusCode).toBe(401);
    expect(browserOnly.json()).toMatchObject({ error: { code: 'not_authenticated', details: null } });
  });

  it('returns 404 on non-app hosts', async () => {
    const zip = await makeZip([{ name: 'index.html', body: 'x' }]);
    const response = await deploy('site', zip, {}, 'content.localtest.me');
    expect(response.statusCode).toBe(404);
  });

  it('returns a stable JSON error when the upload rate limit is exceeded', async () => {
    const limitedApp = await buildServer();
    await limitedApp.register(onAppHost(async (server) => {
      await registerRateLimit(server);
      await registerCsrf(server);
      await server.register(cliDeployRoute);
    }));
    try {
      const zip = await makeZip([{ name: 'index.html', body: 'x' }]);
      let response: Awaited<ReturnType<typeof limitedApp.inject>> | undefined;
      for (let index = 0; index < 11; index++) {
        response = await limitedApp.inject({
          method: 'POST',
          url: '/api/v1/drops/BAD_NAME/deployments',
          headers: {
            host: 'drops.localtest.me',
            authorization: `Bearer ${rawToken}`,
            'content-type': 'application/zip',
            'content-length': String(zip.length),
            'x-forwarded-for': '192.0.2.10',
          },
          payload: zip,
        });
      }
      expect(response!.statusCode).toBe(429);
      expect(response!.json()).toEqual({
        error: { code: 'rate_limited', message: expect.any(String), details: null },
      });
    } finally {
      await limitedApp.close();
    }
  });

  it('authenticates and rejects content metadata before a recognised body parser reads bytes', async () => {
    let parserCalls = 0;
    const lifecycleApp = await buildServer();
    await lifecycleApp.register(onAppHost(async (server) => {
      await registerRateLimit(server);
      server.removeContentTypeParser('application/json');
      server.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, _body, done) => {
        parserCalls += 1;
        done(new Error('JSON parser must not run'));
      });
      await registerCsrf(server);
      await server.register(cliDeployRoute);
    }));
    try {
      const body = Buffer.from(`{"unfinished":"${'x'.repeat(1024 * 1024)}`);
      const response = await lifecycleApp.inject({
        method: 'POST',
        url: '/api/v1/drops/site/deployments',
        headers: {
          host: 'drops.localtest.me',
          'content-type': 'application/json',
          'content-length': String(body.length),
          'x-forwarded-for': '192.0.2.20',
        },
        payload: body,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'not_authenticated' } });
      expect(parserCalls).toBe(0);
      expect(await findByOwnerAndName(ownerId, 'site')).toBeNull();
      expect(await listPrefix('drops/')).toEqual([]);

      const wrongType = await lifecycleApp.inject({
        method: 'POST',
        url: '/api/v1/drops/site/deployments',
        headers: {
          host: 'drops.localtest.me',
          authorization: `Bearer ${rawToken}`,
          'content-type': 'application/json',
          'content-length': String(body.length),
          'x-forwarded-for': '192.0.2.21',
        },
        payload: body,
      });
      expect(wrongType.statusCode).toBe(400);
      expect(wrongType.json()).toMatchObject({ error: { code: 'invalid_content_type', details: null } });
      expect(parserCalls).toBe(0);

      const invalidName = await lifecycleApp.inject({
        method: 'POST',
        url: '/api/v1/drops/BAD_NAME/deployments',
        headers: {
          host: 'drops.localtest.me',
          authorization: `Bearer ${rawToken}`,
          'content-type': 'application/json',
          'content-length': String(body.length),
          'x-forwarded-for': '192.0.2.22',
        },
        payload: body,
      });
      expect(invalidName.statusCode).toBe(400);
      expect(invalidName.json()).toMatchObject({ error: { code: 'invalid_name', details: null } });
      expect(parserCalls).toBe(0);
    } finally {
      await lifecycleApp.close();
    }
  });

  it('rate-limits a validated token even when drops_session cookies vary', async () => {
    const limitedApp = await buildServer();
    await limitedApp.register(onAppHost(async (server) => {
      await registerRateLimit(server);
      await registerCsrf(server);
      await server.register(cliDeployRoute);
    }));
    try {
      const invalidZip = Buffer.from('not a zip');
      let response: Awaited<ReturnType<typeof limitedApp.inject>> | undefined;
      for (let index = 0; index < 11; index++) {
        response = await limitedApp.inject({
          method: 'POST',
          url: '/api/v1/drops/site/deployments',
          headers: {
            host: 'drops.localtest.me',
            authorization: `Bearer ${rawToken}`,
            cookie: `drops_session=rotating-${index}`,
            'content-type': 'application/zip',
            'content-length': String(invalidZip.length),
            'x-forwarded-for': '192.0.2.30',
          },
          payload: invalidZip,
        });
      }
      expect(response!.statusCode).toBe(429);
      expect(response!.json()).toMatchObject({ error: { code: 'rate_limited', details: null } });
    } finally {
      await limitedApp.close();
    }
  });

  it('rate-limits invalid credentials by IP without using bearer or cookie material as keys', async () => {
    const limitedApp = await buildServer();
    await limitedApp.register(onAppHost(async (server) => {
      await registerRateLimit(server);
      await registerCsrf(server);
      await server.register(cliDeployRoute);
    }));
    try {
      const invalidZip = Buffer.from('not a zip');
      let response: Awaited<ReturnType<typeof limitedApp.inject>> | undefined;
      for (let index = 0; index < 61; index++) {
        response = await limitedApp.inject({
          method: 'POST',
          url: '/api/v1/drops/site/deployments',
          headers: {
            host: 'drops.localtest.me',
            authorization: `Bearer invalid-${index}`,
            cookie: `drops_session=rotating-${index}`,
            'content-type': 'application/zip',
            'content-length': String(invalidZip.length),
            'x-forwarded-for': '192.0.2.40',
          },
          payload: invalidZip,
        });
      }
      expect(response!.statusCode).toBe(429);
      expect(response!.json()).toMatchObject({ error: { code: 'rate_limited', details: null } });
    } finally {
      await limitedApp.close();
    }
  });
});
