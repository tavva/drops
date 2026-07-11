// ABOUTME: Integration coverage for CLI discovery, browser approval, token exchange, identity, and revocation.
// ABOUTME: Verifies app-host isolation, browser CSRF boundaries, PKCE failures, and bearer-only API access.
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { cliAuthorizationCodes, cliTokens, sessions, users } from '@/db/schema';
import { buildServer } from '@/server';
import { onAppHost } from '@/middleware/host';
import { registerCsrf } from '@/middleware/csrf';
import { registerRateLimit } from '@/middleware/rateLimit';
import { registerAppSecurity } from '@/middleware/security';
import { cliDiscoveryRoute } from '@/routes/cli/discovery';
import { cliAuthorizeRoutes } from '@/routes/cli/authorize';
import { cliApiAuthErrorHandler, cliApiAuthRoutes } from '@/routes/cli/apiAuth';
import { loginRoute } from '@/routes/auth/login';
import { chooseUsernameRoute } from '@/routes/auth/chooseUsername';
import { createSession } from '@/services/sessions';
import { APP_SESSION_COOKIE } from '@/middleware/auth';
import { CSRF_COOKIE, issueCsrfToken } from '@/lib/csrf';
import { signCookie } from '@/lib/cookies';
import { config } from '@/config';

const app = await buildServer();
await app.register(onAppHost(async (scoped) => {
  await registerAppSecurity(scoped);
  await registerRateLimit(scoped);
  await registerCsrf(scoped);
  await scoped.register(loginRoute);
  await scoped.register(chooseUsernameRoute);
  await scoped.register(cliDiscoveryRoute);
  await scoped.register(cliAuthorizeRoutes);
  await scoped.register(cliApiAuthRoutes);
}));

afterAll(async () => { await app.close(); });

const redirectUri = 'http://127.0.0.1:51234/callback';
const state = 'state_0123456789abcdef';
const verifier = 'v'.repeat(64);
const challenge = createHash('sha256').update(verifier).digest('base64url');

function authorizeUrl(overrides: Record<string, string> = {}) {
  const query = new URLSearchParams({
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...overrides,
  });
  return `/app/cli/authorize?${query}`;
}

let memberId: string;
let sessionId: string;
let browserCookie: string;
let csrf: string;

beforeEach(async () => {
  await db.delete(cliTokens);
  await db.delete(cliAuthorizationCodes);
  await db.delete(sessions);
  await db.delete(users);
  const [member] = await db.insert(users).values({
    email: 'member@example.com', username: 'member', name: 'Member', kind: 'member',
  }).returning();
  memberId = member!.id;
  sessionId = await createSession(memberId);
  csrf = issueCsrfToken(sessionId);
  browserCookie = [
    `${APP_SESSION_COOKIE}=${signCookie(sessionId, config.SESSION_SECRET)}`,
    `${CSRF_COOKIE}=${csrf}`,
  ].join('; ');
});

function browserHeaders(includeCsrf = true) {
  return {
    host: 'drops.localtest.me',
    origin: config.APP_ORIGIN,
    cookie: browserCookie,
    'content-type': 'application/x-www-form-urlencoded',
    ...(includeCsrf ? { 'x-csrf-token': csrf } : {}),
  };
}

function authorizationForm(overrides: Record<string, string> = {}) {
  return new URLSearchParams({
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    _csrf: csrf,
    ...overrides,
  }).toString();
}

async function approve(): Promise<string> {
  const response = await app.inject({
    method: 'POST', url: '/app/cli/authorize/approve',
    headers: browserHeaders(), payload: authorizationForm(),
  });
  expect(response.statusCode).toBe(302);
  const callback = new URL(response.headers.location!);
  expect(callback.origin + callback.pathname).toBe(redirectUri);
  expect(callback.searchParams.get('state')).toBe(state);
  return callback.searchParams.get('code')!;
}

async function exchange(code: string, overrides: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST', url: '/api/v1/auth/token',
    headers: { host: 'drops.localtest.me', 'content-type': 'application/json' },
    payload: { code, verifier, redirectUri, label: 'Drops CLI on test-mac', ...overrides },
  });
}

describe('GET /.well-known/drops', () => {
  it('returns unauthenticated discovery on the app host only', async () => {
    const response = await app.inject({ method: 'GET', url: '/.well-known/drops', headers: { host: 'drops.localtest.me' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ service: 'drops', apiVersion: 1, appOrigin: config.APP_ORIGIN });
    for (const host of ['content.localtest.me', 'member--site.content.localtest.me']) {
      const wrongHost = await app.inject({ method: 'GET', url: '/.well-known/drops', headers: { host } });
      expect(wrongHost.statusCode).toBe(404);
    }
  });
});

describe('browser approval', () => {
  it('preserves the exact safe approval URL through unauthenticated login', async () => {
    const url = authorizeUrl();
    const response = await app.inject({ method: 'GET', url, headers: { host: 'drops.localtest.me' } });
    expect(response.statusCode).toBe(302);
    const login = new URL(response.headers.location!);
    expect(login.origin + login.pathname).toBe(`${config.APP_ORIGIN}/auth/login`);
    expect(login.searchParams.get('next')).toBe(new URL(url, config.APP_ORIGIN).toString());
  });

  it('renders a CSP-safe fixed-capability approval for a completed member', async () => {
    const response = await app.inject({
      method: 'GET', url: authorizeUrl(), headers: { host: 'drops.localtest.me', cookie: browserCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.body).toContain('Authorise Drops CLI');
    expect(response.body).toContain(new URL(config.APP_ORIGIN).host);
    expect(response.body).toContain('read your Drops identity');
    expect(response.body).toContain('create or update your own drops');
    expect(response.body).toContain('action="/app/cli/authorize/approve"');
    expect(response.body).toContain('action="/app/cli/authorize/deny"');
    expect(response.body).toContain(`value="${csrf}"`);
    expect(response.body).not.toContain('fonts.googleapis.com');
  });

  it('preserves the exact approval URL while an existing incomplete member chooses a username', async () => {
    await db.update(users).set({ username: null }).where(eq(users.id, memberId));
    const approvalUrl = authorizeUrl();
    const gated = await app.inject({
      method: 'GET', url: approvalUrl,
      headers: { host: 'drops.localtest.me', cookie: browserCookie },
    });
    expect(gated.statusCode).toBe(302);
    const choose = new URL(gated.headers.location!);
    expect(choose.origin + choose.pathname).toBe(`${config.APP_ORIGIN}/auth/choose-username`);
    expect(choose.searchParams.get('next')).toBe(new URL(approvalUrl, config.APP_ORIGIN).toString());

    const completed = await app.inject({
      method: 'POST', url: '/auth/choose-username',
      headers: browserHeaders(),
      payload: new URLSearchParams({
        username: 'member', next: choose.searchParams.get('next')!, _csrf: csrf,
      }).toString(),
    });
    expect(completed.statusCode).toBe(302);
    expect(completed.headers.location).toBe(new URL(approvalUrl, config.APP_ORIGIN).toString());
  });

  it('rejects approve and deny without global CSRF validation', async () => {
    for (const action of ['approve', 'deny']) {
      const response = await app.inject({
        method: 'POST', url: `/app/cli/authorize/${action}`,
        headers: browserHeaders(false), payload: authorizationForm({ _csrf: '' }),
      });
      expect(response.statusCode).toBe(403);
    }
  });

  it('revalidates hidden inputs before issuing a code', async () => {
    const response = await app.inject({
      method: 'POST', url: '/app/cli/authorize/approve',
      headers: browserHeaders(), payload: authorizationForm({ redirect_uri: 'https://evil.example/callback' }),
    });
    expect(response.statusCode).toBe(400);
    expect(await db.select().from(cliAuthorizationCodes)).toHaveLength(0);
  });

  it('redirects denial to the validated loopback with access_denied and state without a code', async () => {
    const response = await app.inject({
      method: 'POST', url: '/app/cli/authorize/deny',
      headers: browserHeaders(), payload: authorizationForm(),
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${redirectUri}?error=access_denied&state=${state}`);
    expect(await db.select().from(cliAuthorizationCodes)).toHaveLength(0);
  });
});

describe('CLI auth API', () => {
  it('exchanges without browser CSRF and returns exactly the token and user while persisting its label', async () => {
    const code = await approve();
    const response = await exchange(code);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json();
    expect(body).toEqual({
      token: expect.stringMatching(/^drops_cli_/),
      user: { id: memberId, email: 'member@example.com', username: 'member' },
    });
    const [stored] = await db.select().from(cliTokens);
    expect(stored!.label).toBe('Drops CLI on test-mac');
  });

  it.each([
    ['wrong verifier', { verifier: 'x'.repeat(64) }, 'invalid_grant'],
    ['wrong redirect', { redirectUri: 'http://127.0.0.1:51235/callback' }, 'invalid_grant'],
    ['invalid verifier', { verifier: 'short' }, 'invalid_request'],
    ['invalid redirect', { redirectUri: 'https://evil.example/callback' }, 'invalid_request'],
    ['invalid label', { label: 'bad\nlabel' }, 'invalid_label'],
  ])('returns a stable JSON error for %s', async (_name, overrides, errorCode) => {
    const code = await approve();
    const response = await exchange(code, overrides);
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({
      error: { code: errorCode, message: expect.any(String), details: null },
    });
    expect(response.body).not.toContain(code);
    expect(response.body).not.toContain(verifier);
  });

  it('rejects expired and replayed codes as invalid_grant', async () => {
    const expiredCode = await approve();
    await db.update(cliAuthorizationCodes).set({ expiresAt: new Date(Date.now() - 1) });
    expect((await exchange(expiredCode)).json().error.code).toBe('invalid_grant');

    await db.delete(cliAuthorizationCodes);
    const replayedCode = await approve();
    expect((await exchange(replayedCode)).statusCode).toBe(200);
    const replay = await exchange(replayedCode);
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error.code).toBe('invalid_grant');
  });

  it('requires JSON with valid code, verifier, redirectUri, and label fields', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/auth/token', headers: { host: 'drops.localtest.me', 'content-type': 'application/json' },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().error.code).toBe('invalid_request');
  });

  it('caps token exchange request bodies at 8 KiB with a secret-safe JSON 413', async () => {
    const secret = `SECRET_${'x'.repeat(9_000)}`;
    const response = await app.inject({
      method: 'POST', url: '/api/v1/auth/token',
      headers: { host: 'drops.localtest.me', 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.10' },
      payload: JSON.stringify({ code: secret }),
    });
    expect(response.statusCode).toBe(413);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      error: { code: 'payload_too_large', message: expect.any(String), details: null },
    });
    expect(response.body).not.toContain(secret);
  });

  it('returns secret-safe JSON for malformed JSON parser errors', async () => {
    const secret = 'SECRET_MALFORMED_SENTINEL';
    const response = await app.inject({
      method: 'POST', url: '/api/v1/auth/token',
      headers: { host: 'drops.localtest.me', 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.11' },
      payload: `{"code":"${secret}"`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().error.code).toBe('invalid_request');
    expect(response.body).not.toContain(secret);
  });

  it('maps unsupported media types to a secret-safe invalid_request response', async () => {
    const secret = 'SECRET_XML_SENTINEL';
    const response = await app.inject({
      method: 'POST', url: '/api/v1/auth/token',
      headers: { host: 'drops.localtest.me', 'content-type': 'application/xml', 'x-forwarded-for': '198.51.100.13' },
      payload: `<code>${secret}</code>`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      error: { code: 'invalid_request', message: 'The token request is invalid', details: null },
    });
    expect(response.body).not.toContain(secret);
  });

  it('logs unexpected errors with only error and request-id context', async () => {
    const logLines: Record<string, unknown>[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          logLines.push(JSON.parse(line) as Record<string, unknown>);
        }
        callback();
      },
    });
    const unexpectedApp = await buildServer({ loggerStream: sink });
    await unexpectedApp.register(onAppHost(async (scoped) => {
      scoped.setErrorHandler(cliApiAuthErrorHandler);
      scoped.post('/api/v1/test-cli-error', async () => { throw new Error('forced CLI auth failure'); });
    }));

    const bodySecret = 'SECRET_BODY_SENTINEL';
    const headerSecret = 'SECRET_HEADER_SENTINEL';
    try {
      const response = await unexpectedApp.inject({
        method: 'POST', url: '/api/v1/test-cli-error',
        headers: {
          host: 'drops.localtest.me',
          'content-type': 'application/json',
          'x-secret-test-header': headerSecret,
        },
        payload: {
          code: 'c'.repeat(43), verifier: 'v'.repeat(64), redirectUri, label: bodySecret,
        },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: { code: 'internal_error', message: 'An unexpected error occurred', details: null },
      });

      const errorLog = logLines.find((line) => line.msg === 'CLI auth API request failed');
      expect(errorLog).toMatchObject({
        level: 50,
        request_id: expect.any(String),
        err: { type: 'Error', message: 'forced CLI auth failure' },
      });
      expect(errorLog).not.toHaveProperty('req');
      expect(errorLog).not.toHaveProperty('headers');
      expect(errorLog).not.toHaveProperty('body');
      expect(JSON.stringify(errorLog)).not.toContain(bodySecret);
      expect(JSON.stringify(errorLog)).not.toContain(headerSecret);
    } finally {
      await unexpectedApp.close();
    }
  });

  it('rate-limits token exchange to 20 requests per minute', async () => {
    let response;
    for (let attempt = 0; attempt < 21; attempt += 1) {
      response = await app.inject({
        method: 'POST', url: '/api/v1/auth/token',
        headers: { host: 'drops.localtest.me', 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.12' },
        payload: {},
      });
    }
    expect(response!.statusCode).toBe(429);
    expect(response!.headers['content-type']).toContain('application/json');
    expect(response!.headers['cache-control']).toBe('no-store');
    expect(response!.json()).toEqual({
      error: { code: 'rate_limited', message: 'Too many token requests', details: null },
    });
  });

  it('rejects a form-encoded token exchange even when every field is otherwise valid', async () => {
    const code = await approve();
    const response = await app.inject({
      method: 'POST', url: '/api/v1/auth/token',
      headers: { host: 'drops.localtest.me', 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ code, verifier, redirectUri, label: 'Drops CLI on test-mac' }).toString(),
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json().error.code).toBe('invalid_request');
  });

  it('supports whoami and revokes the exact current token, after which it returns 401', async () => {
    const token = (await exchange(await approve())).json().token as string;
    const auth = { host: 'drops.localtest.me', authorization: `Bearer ${token}` };
    const identity = await app.inject({ method: 'GET', url: '/api/v1/whoami', headers: auth });
    expect(identity.statusCode).toBe(200);
    expect(identity.json()).toEqual({ id: memberId, email: 'member@example.com', username: 'member' });

    const revoked = await app.inject({ method: 'DELETE', url: '/api/v1/auth/token', headers: auth });
    expect(revoked.statusCode).toBe(204);
    expect(revoked.body).toBe('');
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/auth/token', headers: auth })).statusCode).toBe(401);
  });

  it('does not accept a browser session cookie on bearer API routes', async () => {
    const response = await app.inject({
      method: 'GET', url: '/api/v1/whoami', headers: { host: 'drops.localtest.me', cookie: browserCookie },
    });
    expect(response.statusCode).toBe(401);
  });

  it('keeps all API routes off content and drop hosts', async () => {
    for (const host of ['content.localtest.me', 'member--site.content.localtest.me']) {
      expect((await app.inject({ method: 'POST', url: '/api/v1/auth/token', headers: { host } })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/v1/whoami', headers: { host } })).statusCode).toBe(404);
      expect((await app.inject({ method: 'DELETE', url: '/api/v1/auth/token', headers: { host } })).statusCode).toBe(404);
    }
  });
});
