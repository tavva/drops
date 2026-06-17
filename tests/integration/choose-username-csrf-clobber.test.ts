// ABOUTME: Reproduces a new member's choose-username submit failing with bad_csrf when a stale
// ABOUTME: csrf_anon cookie (left by the drop sign-in interstitial) rebinds drops_csrf on a static GET.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('openid-client', () => ({
  Configuration: class {},
  discovery: vi.fn(async () => ({})),
  buildAuthorizationUrl: vi.fn(() => new URL('https://accounts.google.com/auth')),
  authorizationCodeGrant: vi.fn(),
}));

let appInstance: Awaited<ReturnType<typeof import('@/server').buildServer>>;

beforeAll(async () => {
  const { buildServer } = await import('@/server');
  const { onAppHost } = await import('@/middleware/host');
  const { registerCsrf } = await import('@/middleware/csrf');
  const { chooseUsernameRoute } = await import('@/routes/auth/chooseUsername');
  const { appStaticRoute } = await import('@/routes/app/static');
  appInstance = await buildServer();
  await appInstance.register(onAppHost(async (s) => {
    await registerCsrf(s);
    await s.register(chooseUsernameRoute);
    await s.register(appStaticRoute);
  }));
});

afterAll(async () => { await appInstance.close(); });

const HOST = 'drops.localtest.me';

function cookieHeader(pairs: Record<string, string>) {
  return Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join('; ');
}

function readSetCookie(res: { headers: Record<string, unknown> }, name: string): string | null {
  const all = [res.headers['set-cookie']].flat().filter(Boolean) as string[];
  const hit = all.find((c) => c.startsWith(`${name}=`));
  return hit ? hit.split(';')[0]!.split('=').slice(1).join('=') : null;
}

describe('choose-username CSRF with a leftover interstitial anon context', () => {
  it('lets a new member submit after the page loads its stylesheet', async () => {
    const { signCookie } = await import('@/lib/cookies');
    const { config } = await import('@/config');
    const { CSRF_COOKIE, CSRF_ANON_COOKIE, newAnonCsrfId } = await import('@/lib/csrf');
    const { createPendingLogin } = await import('@/services/pendingLogins');
    const { db } = await import('@/db');
    const { users, pendingLogins, sessions } = await import('@/db/schema');
    const { PENDING_LOGIN_COOKIE } = await import('@/routes/auth/callback');

    await db.delete(sessions);
    await db.delete(users);
    await db.delete(pendingLogins);

    // The drop sign-in interstitial set this anon CSRF context earlier in the visit; it lingers
    // at path=/ for the whole browser session.
    const anonId = newAnonCsrfId();
    const signedAnon = signCookie(anonId, config.SESSION_SECRET);

    const pendingId = await createPendingLogin({ email: 'tom@example.com', name: 'Tom', avatarUrl: null });
    const pendingCookie = signCookie(pendingId, config.SESSION_SECRET);

    // 1. The browser lands on the choose-username page (pending_login path=/auth is sent here).
    const getForm = await appInstance.inject({
      method: 'GET', url: '/auth/choose-username',
      headers: { host: HOST, cookie: cookieHeader({
        [PENDING_LOGIN_COOKIE]: pendingCookie,
        [CSRF_ANON_COOKIE]: signedAnon,
      }) },
    });
    expect(getForm.statusCode).toBe(200);
    const formToken = getForm.body.match(/name="_csrf" value="([^"]+)"/)![1]!;
    let csrfCookie = readSetCookie(getForm, CSRF_COOKIE)!;
    expect(csrfCookie).toBe(formToken);

    // 2. The page pulls its stylesheet. pending_login (path=/auth) is NOT sent to /app/static/*,
    //    so the only resolvable CSRF context on this request is the stale csrf_anon.
    const getCss = await appInstance.inject({
      method: 'GET', url: '/app/static/style.css',
      headers: { host: HOST, cookie: cookieHeader({
        [CSRF_ANON_COOKIE]: signedAnon,
        [CSRF_COOKIE]: csrfCookie,
      }) },
    });
    expect(getCss.statusCode).toBe(200);
    const rebound = readSetCookie(getCss, CSRF_COOKIE);
    if (rebound) csrfCookie = rebound;   // a browser would adopt the overwritten cookie

    // 3. Tom submits the username. The cookie the browser now holds must still match the form token.
    const post = await appInstance.inject({
      method: 'POST', url: '/auth/choose-username',
      headers: {
        host: HOST,
        origin: config.APP_ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader({
          [PENDING_LOGIN_COOKIE]: pendingCookie,
          [CSRF_ANON_COOKIE]: signedAnon,
          [CSRF_COOKIE]: csrfCookie,
        }),
      },
      payload: `username=tom&_csrf=${encodeURIComponent(formToken)}`,
    });

    expect(post.statusCode).toBe(302);
  });
});
