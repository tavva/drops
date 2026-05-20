// ABOUTME: A signed csrf_anon cookie gives logged-out forms a CSRF context, so the interstitial
// ABOUTME: email form can submit without an app session (no more no_csrf_context).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '@/server';
import { onAppHost } from '@/middleware/host';
import { registerCsrf } from '@/middleware/csrf';
import { signCookie } from '@/lib/cookies';
import { issueCsrfToken, CSRF_COOKIE, CSRF_ANON_COOKIE, newAnonCsrfId } from '@/lib/csrf';
import { config } from '@/config';

let appInstance: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  appInstance = await buildServer();
  await appInstance.register(onAppHost(async (s) => {
    await registerCsrf(s);
    s.post('/anon/submit', async () => ({ ok: true }));
  }));
});

afterAll(async () => { await appInstance.close(); });

function cookieHeader(pairs: Record<string, string>) {
  return Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join('; ');
}

describe('anonymous CSRF context', () => {
  it('accepts a token bound to the signed csrf_anon cookie', async () => {
    const anonId = newAnonCsrfId();
    const signedAnon = signCookie(anonId, config.SESSION_SECRET);
    const token = issueCsrfToken(anonId);
    const res = await appInstance.inject({
      method: 'POST', url: '/anon/submit',
      headers: {
        host: 'drops.localtest.me',
        origin: config.APP_ORIGIN,
        'x-csrf-token': token,
        cookie: cookieHeader({ [CSRF_ANON_COOKIE]: signedAnon, [CSRF_COOKIE]: token }),
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects when there is no context at all', async () => {
    const token = issueCsrfToken('whatever');
    const res = await appInstance.inject({
      method: 'POST', url: '/anon/submit',
      headers: {
        host: 'drops.localtest.me',
        origin: config.APP_ORIGIN,
        'x-csrf-token': token,
        cookie: cookieHeader({ [CSRF_COOKIE]: token }),
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toBe('no_csrf_context');
  });
});
