// ABOUTME: GET /auth/callback — completes OAuth, admits members or viewers, creates session or pending login.
// ABOUTME: On success, redirects to content-host /auth/bootstrap with a short-lived handoff token.
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { exchangeCode } from '@/lib/oauth';
import { verifyCookie, signCookie, appCookieOptions } from '@/lib/cookies';
import { signHandoff } from '@/lib/handoff';
import { dropTargetFromNext } from '@/lib/dropHost';
import { isMemberEmail, canSignInAsViewer } from '@/services/allowlist';
import { createSession, deleteSession } from '@/services/sessions';
import { createPendingLogin } from '@/services/pendingLogins';
import { findByEmail, createViewerUser, setUserKind } from '@/services/users';
import { OAUTH_STATE_COOKIE, allowedNext } from './login';
import { APP_SESSION_COOKIE } from '@/middleware/auth';
import { tightAuthLimit } from '@/middleware/rateLimit';
import { config } from '@/config';

export const PENDING_LOGIN_COOKIE = 'pending_login';

type Kind = 'member' | 'viewer';

async function completeLogin(
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
  // dropTargetFromNext recognises both direct drop-host URLs and app-host /auth/drop-bootstrap
  // wrappers. The wrapper case is what lets a logged-out viewer who followed a shared drop link
  // complete the drop-cookie bootstrap without ever holding an app-session cookie.
  const dropTarget = dropTargetFromNext(nextUrl);
  if (dropTarget) {
    const token = signHandoff(sid, dropTarget.hostname, config.SESSION_SECRET, 60);
    const bootstrap = new URL('/auth/bootstrap', dropTarget.origin);
    bootstrap.searchParams.set('token', token);
    bootstrap.searchParams.set('next', dropTarget.path);
    return reply.redirect(bootstrap.toString(), 302);
  }
  if (kind === 'viewer') {
    return reply.redirect(new URL('/auth/goodbye', config.APP_ORIGIN).toString(), 302);
  }
  return reply.redirect(nextUrl, 302);
}

function restartLogin(reply: FastifyReply, stateParam: string | undefined): FastifyReply {
  // When the oauth_state cookie is gone (callback URL re-opened after a prior hit, or expiry),
  // the signed `state` param Google echoes back still carries `next`. Recover it so viewers
  // with drop-only access aren't stranded on the dashboard.
  const login = new URL('/auth/login', config.APP_ORIGIN);
  if (stateParam) {
    const payload = verifyCookie(stateParam, config.SESSION_SECRET);
    if (payload) {
      try {
        const { next } = JSON.parse(payload) as { next?: unknown };
        if (typeof next === 'string') login.searchParams.set('next', next);
      } catch { /* fall through to bare restart */ }
    }
  }
  return reply.redirect(login.toString(), 302);
}

export const callbackRoute: FastifyPluginAsync = async (app) => {
  app.get('/auth/callback', { config: { skipCsrf: true, ...tightAuthLimit } }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const raw = req.cookies[OAUTH_STATE_COOKIE];
    if (!raw) return restartLogin(reply, q.state);
    const payload = verifyCookie(raw, config.SESSION_SECRET);
    if (!payload) return restartLogin(reply, q.state);
    let parsed: { state: string; nonce: string; next: string };
    try { parsed = JSON.parse(payload); }
    catch { return restartLogin(reply, q.state); }

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
    const nextUrl = allowedNext(parsed.next);
    if (!isMember && !isViewer) {
      return reply.code(403).view('notAllowed.ejs', { email: identity.email, next: nextUrl });
    }
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

      return completeLogin(reply, existing.id, targetKind, nextUrl);
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
    return completeLogin(reply, viewer.id, 'viewer', nextUrl);
  });
};
