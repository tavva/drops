// ABOUTME: Integration coverage for listing and revoking CLI authorisations from the dashboard.
// ABOUTME: Exercises owner isolation, CSRF enforcement, escaped labels, and secret-free HTML.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { cliTokens, sessions, users } from '@/db/schema';
import { createSession } from '@/services/sessions';
import { signCookie } from '@/lib/cookies';
import { issueCsrfToken } from '@/lib/csrf';
import { config } from '@/config';
import { listActiveCliTokens } from '@/services/cliAuth';

let app: Awaited<ReturnType<typeof import('@/server').buildServer>>;
let aliceId: string;
let bobId: string;
let aliceSession: string;

beforeAll(async () => {
  const { buildServer } = await import('@/server');
  const { onAppHost } = await import('@/middleware/host');
  const { registerCsrf } = await import('@/middleware/csrf');
  const { dashboardRoute } = await import('@/routes/app/dashboard');
  const { cliTokenRoutes } = await import('@/routes/app/cliTokens');
  app = await buildServer();
  await app.register(onAppHost(async (server) => {
    await registerCsrf(server);
    await server.register(dashboardRoute);
    await server.register(cliTokenRoutes);
  }));
});

afterAll(async () => app.close());

beforeEach(async () => {
  await db.delete(cliTokens);
  await db.delete(sessions);
  await db.delete(users);
  const [alice, bob] = await db.insert(users).values([
    { email: 'alice@example.com', username: 'alice' },
    { email: 'bob@example.com', username: 'bob' },
  ]).returning();
  aliceId = alice!.id;
  bobId = bob!.id;
  aliceSession = await createSession(aliceId);
});

function authCookies(sessionId = aliceSession): { cookie: string; csrf: string } {
  const csrf = issueCsrfToken(sessionId);
  return {
    csrf,
    cookie: `drops_session=${signCookie(sessionId, config.SESSION_SECRET)}; drops_csrf=${csrf}`,
  };
}

describe('CLI access on the dashboard', () => {
  it('shows only the owner active authorisations with escaped bounded labels and usage times', async () => {
    const longLabel = `<script>alert(1)</script>${'x'.repeat(100)}`;
    await db.insert(cliTokens).values([
      {
        userId: aliceId,
        tokenHash: 'alice-secret-hash',
        label: longLabel,
        createdAt: new Date('2026-07-10T10:15:00Z'),
        lastUsedAt: new Date('2026-07-11T11:30:00Z'),
      },
      { userId: aliceId, tokenHash: 'alice-never-secret', label: 'Never used' },
      { userId: aliceId, tokenHash: 'alice-revoked-secret', label: 'Revoked', revokedAt: new Date() },
      { userId: bobId, tokenHash: 'bob-secret-hash', label: 'Bob laptop' },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: '/app',
      headers: { host: 'drops.localtest.me', cookie: authCookies().cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<h2 id="cli-access-heading">CLI access</h2>');
    expect(response.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(response.body).not.toContain('<script>alert(1)</script>');
    expect(response.body).not.toContain('x'.repeat(101));
    expect(response.body).toContain('10 Jul 2026');
    expect(response.body).toContain('10 Jul 2026, 10:15 UTC');
    expect(response.body).toContain('11 Jul 2026, 11:30 UTC');
    expect(response.body).toContain('All times UTC');
    expect(response.body).toContain('Never used');
    expect(response.body).toContain('Never');
    expect(response.body).not.toContain('Revoked');
    expect(response.body).not.toContain('Bob laptop');
    expect(response.body).not.toContain('alice-secret-hash');
    expect(response.body).not.toContain('alice-never-secret');
    expect(response.body).not.toContain('bob-secret-hash');
  });

  it('selects only active authorisations in the dashboard query', async () => {
    await db.insert(cliTokens).values([
      { userId: aliceId, tokenHash: 'active-query-hash', label: 'Active' },
      { userId: aliceId, tokenHash: 'revoked-query-hash', label: 'Revoked', revokedAt: new Date() },
      { userId: bobId, tokenHash: 'other-query-hash', label: 'Other owner' },
    ]);

    await expect(listActiveCliTokens(aliceId)).resolves.toMatchObject([{ label: 'Active' }]);
  });

  it('requires a valid session-bound CSRF token to revoke an owner authorisation', async () => {
    const [token] = await db.insert(cliTokens).values({
      userId: aliceId,
      tokenHash: 'owner-token-hash',
      label: 'CI laptop',
    }).returning();

    const missing = await app.inject({
      method: 'POST',
      url: `/app/cli/tokens/${token!.id}/revoke`,
      headers: {
        host: 'drops.localtest.me',
        origin: config.APP_ORIGIN,
        cookie: `drops_session=${signCookie(aliceSession, config.SESSION_SECRET)}`,
      },
    });
    expect(missing.statusCode).toBe(403);

    const auth = authCookies();
    const response = await app.inject({
      method: 'POST',
      url: `/app/cli/tokens/${token!.id}/revoke`,
      headers: { host: 'drops.localtest.me', origin: config.APP_ORIGIN, cookie: auth.cookie },
      payload: { _csrf: auth.csrf },
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe('/app?cli_revoked=1');
    const [stored] = await db.select().from(cliTokens).where(eq(cliTokens.id, token!.id));
    expect(stored!.revokedAt).toBeInstanceOf(Date);
  });

  it('does not reveal or revoke another owner, missing, invalid, or already-revoked authorisations', async () => {
    const [other, revoked] = await db.insert(cliTokens).values([
      { userId: bobId, tokenHash: 'other-owner-hash', label: 'Other' },
      { userId: aliceId, tokenHash: 'already-revoked-hash', label: 'Old', revokedAt: new Date() },
    ]).returning();
    const auth = authCookies();

    for (const id of [other!.id, revoked!.id, '00000000-0000-0000-0000-000000000000', 'not-a-uuid']) {
      const response = await app.inject({
        method: 'POST',
        url: `/app/cli/tokens/${id}/revoke`,
        headers: { host: 'drops.localtest.me', origin: config.APP_ORIGIN, cookie: auth.cookie },
        payload: { _csrf: auth.csrf },
      });
      expect(response.statusCode).toBe(404);
      expect(response.body).toBe('not_found');
    }

    const [stored] = await db.select().from(cliTokens).where(eq(cliTokens.id, other!.id));
    expect(stored!.revokedAt).toBeNull();
  });

  it('shows a revocation confirmation without reflecting arbitrary query text', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/app?cli_revoked=<script>alert(1)</script>',
      headers: { host: 'drops.localtest.me', cookie: authCookies().cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('<script>alert(1)</script>');

    const confirmed = await app.inject({
      method: 'GET',
      url: '/app?cli_revoked=1',
      headers: { host: 'drops.localtest.me', cookie: authCookies().cookie },
    });
    expect(confirmed.body).toContain('CLI access revoked.');
  });
});
