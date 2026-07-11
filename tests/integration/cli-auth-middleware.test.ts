// ABOUTME: Integration coverage for strict bearer-only CLI authentication middleware.
// ABOUTME: Verifies JSON 401 responses, completed-member enforcement, request context, and secret-safe logging.
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db';
import { cliAuthorizationCodes, cliTokens, sessions, users } from '@/db/schema';
import { APP_SESSION_COOKIE, requireCompletedMember } from '@/middleware/auth';
import { requireCliToken } from '@/middleware/cliAuth';
import { onAppHost } from '@/middleware/host';
import { buildServer } from '@/server';
import { createSession } from '@/services/sessions';
import { signCookie } from '@/lib/cookies';
import { config } from '@/config';

let appInstance: Awaited<ReturnType<typeof buildServer>>;
let logLines: Array<Record<string, unknown>> = [];
const sink = new Writable({
  write(chunk: Buffer, _encoding, callback) {
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      try { logLines.push(JSON.parse(line) as Record<string, unknown>); } catch { /* ignore */ }
    }
    callback();
  },
});

beforeAll(async () => {
  appInstance = await buildServer({ loggerStream: sink });
  await appInstance.register(onAppHost(async (server) => {
    server.get('/api/cli/secure', { preHandler: requireCliToken }, async (request) => {
      request.log.info({ marker: 'cli-secure' });
      return { user: request.user, tokenId: request.cliToken?.id };
    });
    server.get('/app/browser-secure', { preHandler: requireCompletedMember }, async () => ({ ok: true }));
  }));
});

afterAll(async () => { await appInstance.close(); });

beforeEach(async () => {
  logLines = [];
  await db.delete(cliTokens);
  await db.delete(cliAuthorizationCodes);
  await db.delete(sessions);
  await db.delete(users);
});

async function createUser(kind: 'member' | 'viewer' = 'member', username: string | null = 'member') {
  const [user] = await db.insert(users).values({
    email: `${kind}-${username ?? 'none'}-${crypto.randomUUID()}@example.com`,
    kind,
    username,
  }).returning();
  return user!;
}

async function createToken(userId: string, options: { revoked?: boolean; raw?: string } = {}) {
  const raw = options.raw ?? `drops_cli_${crypto.randomUUID().replaceAll('-', '')}`;
  const [row] = await db.insert(cliTokens).values({
    userId,
    tokenHash: createHash('sha256').update(raw).digest('hex'),
    label: 'Test token',
    revokedAt: options.revoked ? new Date() : null,
  }).returning();
  return { raw, id: row!.id };
}

async function request(authorization?: string, cookie?: string) {
  return await appInstance.inject({
    method: 'GET',
    url: '/api/cli/secure',
    headers: {
      host: 'drops.localtest.me',
      ...(authorization === undefined ? {} : { authorization }),
      ...(cookie === undefined ? {} : { cookie }),
    },
  });
}

function expectJson401(response: Awaited<ReturnType<typeof request>>) {
  expect(response.statusCode).toBe(401);
  expect(response.headers.location).toBeUndefined();
  expect(response.headers['content-type']).toContain('application/json');
  expect(response.json()).toMatchObject({ error: { code: 'not_authenticated' } });
}

describe('requireCliToken', () => {
  it.each([
    ['missing', undefined],
    ['wrong scheme', 'Basic abc'],
    ['missing value', 'Bearer'],
    ['extra whitespace/value', 'Bearer abc def'],
    ['comma-joined multiple values', 'Bearer abc, Bearer def'],
  ])('returns JSON 401 for %s authorization', async (_case, authorization) => {
    expectJson401(await request(authorization));
  });

  it('rejects multiple Authorization header values', async () => {
    expectJson401(await request(['Bearer first', 'Bearer second'] as unknown as string));
  });

  it('rejects unknown and revoked tokens', async () => {
    const user = await createUser();
    const revoked = await createToken(user.id, { revoked: true });
    expectJson401(await request('Bearer drops_cli_unknown'));
    expectJson401(await request(`Bearer ${revoked.raw}`));
  });

  it.each(['bearer', 'bEaReR'])('accepts the case-insensitive HTTP auth scheme %s', async (scheme) => {
    const user = await createUser();
    const token = await createToken(user.id);
    const response = await request(`${scheme} ${token.raw}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ tokenId: token.id, user: { id: user.id } });
  });

  it('rejects viewer and incomplete-member owners', async () => {
    const viewer = await createUser('viewer', null);
    const incomplete = await createUser('member', null);
    const viewerToken = await createToken(viewer.id);
    const incompleteToken = await createToken(incomplete.id);
    expectJson401(await request(`Bearer ${viewerToken.raw}`));
    expectJson401(await request(`Bearer ${incompleteToken.raw}`));
  });

  it('does not accept a valid browser cookie without a bearer token', async () => {
    const user = await createUser();
    const sessionId = await createSession(user.id);
    const cookie = `${APP_SESSION_COOKIE}=${signCookie(sessionId, config.SESSION_SECRET)}`;
    expectJson401(await request(undefined, cookie));
  });

  it('populates the completed member and token id and logs ids without credential material', async () => {
    const user = await createUser();
    const token = await createToken(user.id);
    const response = await request(`Bearer ${token.raw}`);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      user: { id: user.id, email: user.email, username: user.username, kind: 'member' },
      tokenId: token.id,
    });
    const entry = logLines.find((line) => line.marker === 'cli-secure');
    expect(entry).toMatchObject({ user_id: user.id, token_id: token.id });
    expect(JSON.stringify(logLines)).not.toContain(token.raw);
    expect(JSON.stringify(logLines)).not.toContain(createHash('sha256').update(token.raw).digest('hex'));
  });
});
