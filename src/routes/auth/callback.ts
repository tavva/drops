// ABOUTME: GET /auth/callback — completes OAuth, admits members or viewers, creates session or pending login.
// ABOUTME: On success, redirects to content-host /auth/bootstrap with a short-lived handoff token.
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { exchangeCode } from '@/lib/oauth';
import { verifyCookie, signCookie, appCookieOptions } from '@/lib/cookies';
import { signHandoff } from '@/lib/handoff';
import { isMemberEmail, canSignInAsViewer } from '@/services/allowlist';
import { createSession, deleteSession } from '@/services/sessions';
import { createPendingLogin } from '@/services/pendingLogins';
import { findByEmail, createViewerUser, setUserKind } from '@/services/users';
import { OAUTH_STATE_COOKIE, allowedNext } from './login';
import { APP_SESSION_COOKIE } from '@/middleware/auth';
import { config } from '@/config';

export const PENDING_LOGIN_COOKIE = 'pending_login';

type Kind = 'member' | 'viewer';

function isAppOriginUrl(url: string): boolean {
  try { return new URL(url).host === new URL(config.APP_ORIGIN).host; }
  catch { return true; }
}

function viewerSafeNext(kind: Kind, nextUrl: string): string {
  return kind === 'viewer' && isAppOriginUrl(nextUrl)
    ? new URL('/', config.CONTENT_ORIGIN).toString()
    : nextUrl;
}

async function issueSessionAndHandoff(
  reply: FastifyReply,
  userId: string,
  kind: Kind,
  nextUrl: string,
): Promise<FastifyReply> {
  const sid = await createSession(userId);
  if (kind === 'member') {
    reply.setCookie(APP_SESSION_COOKIE, signCookie(sid, config.SESSION_SECRET), appCookieOptions({
      maxAge: 30 * 24 * 3600,
    }));
  }
  const token = signHandoff(sid, config.SESSION_SECRET, 60);
  const bootstrap = new URL('/auth/bootstrap', config.CONTENT_ORIGIN);
  bootstrap.searchParams.set('token', token);
  bootstrap.searchParams.set('next', viewerSafeNext(kind, nextUrl));
  return reply.redirect(bootstrap.toString(), 302);
}

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

    const isMember = await isMemberEmail(identity.email);
    const isViewer = !isMember && await canSignInAsViewer(identity.email);
    if (!isMember && !isViewer) return reply.code(403).send('not_allowed');

    const nextUrl = allowedNext(parsed.next);
    const existing = await findByEmail(identity.email);

    if (existing) {
      const currentKind = (existing.kind as Kind);
      const targetKind: Kind = isMember ? 'member' : 'viewer';
      if (currentKind !== targetKind) {
        await setUserKind(existing.id, targetKind);
        if (targetKind === 'viewer') {
          reply.clearCookie(APP_SESSION_COOKIE, appCookieOptions());
          const priorRaw = req.cookies[APP_SESSION_COOKIE];
          const priorSid = priorRaw ? verifyCookie(priorRaw, config.SESSION_SECRET) : null;
          if (priorSid) await deleteSession(priorSid);
        }
      }

      if (targetKind === 'member' && existing.username === null) {
        const sid = await createSession(existing.id);
        reply.setCookie(APP_SESSION_COOKIE, signCookie(sid, config.SESSION_SECRET), appCookieOptions({
          maxAge: 30 * 24 * 3600,
        }));
        const target = new URL('/auth/choose-username', config.APP_ORIGIN);
        target.searchParams.set('next', nextUrl);
        return reply.redirect(target.toString(), 302);
      }

      return issueSessionAndHandoff(reply, existing.id, targetKind, nextUrl);
    }

    if (isMember) {
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
    }

    const viewer = await createViewerUser({
      email: identity.email,
      name: identity.name,
      avatarUrl: identity.avatarUrl,
    });
    return issueSessionAndHandoff(reply, viewer.id, 'viewer', nextUrl);
  });
};
