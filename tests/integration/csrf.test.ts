import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildServer } from '@/server';
import { onAppHost } from '@/middleware/host';
import { registerCsrf } from '@/middleware/csrf';
import { requireAppSession, APP_SESSION_COOKIE } from '@/middleware/auth';
import { signCookie } from '@/lib/cookies';
import { issueCsrfToken, CSRF_COOKIE } from '@/lib/csrf';
import { db } from '@/db';
import { users, sessions } from '@/db/schema';
import { createSession } from '@/services/sessions';
import { config } from '@/config';

let appInstance: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  appInstance = await buildServer();
  await appInstance.register(onAppHost(async (s) => {
    await registerCsrf(s);
    s.get('/app/form', { preHandler: requireAppSession }, async (req) => ({ token: req.csrfToken }));
    s.post('/app/submit', { preHandler: requireAppSession }, async () => ({ ok: true }));
    s.post('/app/skip', { config: { skipCsrf: true } }, async () => ({ ok: true }));
  }));
});

afterAll(async () => { await appInstance.close(); });

let sid: string;
let signedSid: string;
beforeEach(async () => {
  await db.delete(sessions);
  await db.delete(users);
  const [u] = await db.insert(users).values({ email: 'a@b.com', username: 'alice' }).returning();
  sid = await createSession(u!.id);
  signedSid = signCookie(sid, config.SESSION_SECRET);
});

function cookieHeader(pairs: Record<string, string>) {
  return Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join('; ');
}

describe('CSRF middleware', () => {
  it('GET issues a rotating token cookie', async () => {
    const res = await appInstance.inject({
      method: 'GET', url: '/app/form',
      headers: { host: 'drops.localtest.me', cookie: cookieHeader({ [APP_SESSION_COOKIE]: signedSid }) },
    });
    expect(res.statusCode).toBe(200);
    const setCookie = [res.headers['set-cookie']].flat().filter(Boolean) as string[];
    const csrfCookie = setCookie.find((c) => c.startsWith(`${CSRF_COOKIE}=`));
    expect(csrfCookie).toBeDefined();
    expect(csrfCookie).not.toMatch(/HttpOnly/i);
  });

  it('POST with matching session-bound token succeeds', async () => {
    const token = issueCsrfToken(sid);
    const res = await appInstance.inject({
      method: 'POST', url: '/app/submit',
      headers: {
        host: 'drops.localtest.me',
        origin: config.APP_ORIGIN,
        'x-csrf-token': token,
        cookie: cookieHeader({ [APP_SESSION_COOKIE]: signedSid, [CSRF_COOKIE]: token }),
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('POST rejects token bound to a different session', async () => {
    const otherToken = issueCsrfToken('someone-else');
    const res = await appInstance.inject({
      method: 'POST', url: '/app/submit',
      headers: {
        host: 'drops.localtest.me',
        origin: config.APP_ORIGIN,
        'x-csrf-token': otherToken,
        cookie: cookieHeader({ [APP_SESSION_COOKIE]: signedSid, [CSRF_COOKIE]: otherToken }),
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toBe('bad_csrf');
  });

  it('POST rejects bad origin', async () => {
    const token = issueCsrfToken(sid);
    const res = await appInstance.inject({
      method: 'POST', url: '/app/submit',
      headers: {
        host: 'drops.localtest.me',
        origin: 'https://evil.example',
        'x-csrf-token': token,
        cookie: cookieHeader({ [APP_SESSION_COOKIE]: signedSid, [CSRF_COOKIE]: token }),
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toBe('bad_origin');
  });

  it('POST rejects missing origin and referer', async () => {
    const token = issueCsrfToken(sid);
    const res = await appInstance.inject({
      method: 'POST', url: '/app/submit',
      headers: {
        host: 'drops.localtest.me',
        'x-csrf-token': token,
        cookie: cookieHeader({ [APP_SESSION_COOKIE]: signedSid, [CSRF_COOKIE]: token }),
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('skipCsrf route lets POST through without a token', async () => {
    const res = await appInstance.inject({
      method: 'POST', url: '/app/skip',
      headers: { host: 'drops.localtest.me' },
    });
    expect(res.statusCode).toBe(200);
  });
});
