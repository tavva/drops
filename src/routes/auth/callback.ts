// ABOUTME: GET /auth/callback — completes OAuth, enforces allowlist, creates session or pending login.
// ABOUTME: On success, redirects to content-host /auth/bootstrap with a short-lived handoff token.
import type { FastifyPluginAsync } from 'fastify';
import { exchangeCode } from '@/lib/oauth';
import { verifyCookie, signCookie, appCookieOptions } from '@/lib/cookies';
import { signHandoff } from '@/lib/handoff';
import { isEmailAllowed } from '@/services/allowlist';
import { createSession } from '@/services/sessions';
import { createPendingLogin } from '@/services/pendingLogins';
import { findByEmail } from '@/services/users';
import { OAUTH_STATE_COOKIE, allowedNext } from './login';
import { APP_SESSION_COOKIE } from '@/middleware/auth';
import { config } from '@/config';

export const PENDING_LOGIN_COOKIE = 'pending_login';

export const callbackRoute: FastifyPluginAsync = async (app) => {
  app.get('/auth/callback', { config: { skipCsrf: true } }, async (req, reply) => {
    const raw = req.cookies[OAUTH_STATE_COOKIE];
    if (!raw) return reply.code(400).send('missing_state');
    const payload = verifyCookie(raw, config.SESSION_SECRET);
    if (!payload) return reply.code(400).send('invalid_state');
    let parsed: { state: string; nonce: string; next: string };
    try { parsed = JSON.parse(payload); }
    catch { return reply.code(400).send('invalid_state'); }

    reply.clearCookie(OAUTH_STATE_COOKIE, appCookieOptions({ path: '/auth' }));

    let identity;
    try {
      identity = await exchangeCode({
        currentUrl: new URL(req.raw.url ?? '/', config.APP_ORIGIN).toString(),
        expectedNonce: parsed.nonce,
        expectedState: parsed.state,
      });
    } catch (e) {
      req.log.warn({ err: e }, 'oauth exchange failed');
      return reply.code(400).send('oauth_failed');
    }

    if (!identity.emailVerified) return reply.code(403).send('email_unverified');
    if (!(await isEmailAllowed(identity.email))) return reply.code(403).send('not_allowed');

    const existing = await findByEmail(identity.email);
    const nextUrl = allowedNext(parsed.next);

    if (existing) {
      const sid = await createSession(existing.id);
      reply.setCookie(APP_SESSION_COOKIE, signCookie(sid, config.SESSION_SECRET), appCookieOptions({
        maxAge: 30 * 24 * 3600,
      }));
      const token = signHandoff(sid, config.SESSION_SECRET, 60);
      const bootstrap = new URL('/auth/bootstrap', config.CONTENT_ORIGIN);
      bootstrap.searchParams.set('token', token);
      bootstrap.searchParams.set('next', nextUrl);
      return reply.redirect(bootstrap.toString(), 302);
    }

    const pendingId = await createPendingLogin({
      email: identity.email,
      name: identity.name,
      avatarUrl: identity.avatarUrl,
    });
    reply.setCookie(PENDING_LOGIN_COOKIE, signCookie(pendingId, config.SESSION_SECRET), appCookieOptions({
      maxAge: 600,
      path: '/auth',
    }));
    const target = new URL('/auth/choose-username', config.APP_ORIGIN);
    target.searchParams.set('next', nextUrl);
    return reply.redirect(target.toString(), 302);
  });
};
