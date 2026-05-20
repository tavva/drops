// ABOUTME: Magic-link viewer auth — POST /auth/magic/request emails a one-time sign-in link
// ABOUTME: to an eligible address; GET/POST /auth/magic/verify (Task 11) complete the login.
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { parseDropHost, dropTargetFromNext } from '@/lib/dropHost';
import { findByUsername, findByEmail, createViewerUser } from '@/services/users';
import { findByOwnerAndName } from '@/services/drops';
import { canViewByEmail } from '@/services/permissions';
import { issueMagicToken, consumeMagicToken } from '@/services/magicLinkTokens';
import { isLikelyEmail, normaliseEmail } from '@/lib/email';
import { issueCsrfToken, CSRF_COOKIE, CSRF_ANON_COOKIE, newAnonCsrfId, requestOriginOk } from '@/lib/csrf';
import { signCookie, appCookieOptions } from '@/lib/cookies';
import { getMailer } from '@/lib/mail';
import { completeViewerLogin } from './complete';
import { tightAuthLimit } from '@/middleware/rateLimit';
import { config } from '@/config';

// Tokens are randomBytes(32).toString('base64url') → exactly 43 base64url chars.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

const NOTICE = 'If that address can view this drop, a sign-in link is on its way.';

interface InterstitialParams { host: string; next: string; notice: string | null; }

function renderInterstitial(reply: FastifyReply, { host, next, notice }: InterstitialParams): FastifyReply {
  const anonId = newAnonCsrfId();
  reply.setCookie(CSRF_ANON_COOKIE, signCookie(anonId, config.SESSION_SECRET), appCookieOptions());
  const csrfToken = issueCsrfToken(anonId);
  reply.setCookie(CSRF_COOKIE, csrfToken, appCookieOptions({ httpOnly: false }));
  const selfUrl = new URL('/auth/drop-bootstrap', config.APP_ORIGIN);
  selfUrl.searchParams.set('host', host); selfUrl.searchParams.set('next', next);
  const googleHref = new URL('/auth/login', config.APP_ORIGIN);
  googleHref.searchParams.set('next', selfUrl.toString());
  return reply.view('dropSignin.ejs', { host, next, googleHref: googleHref.toString(), csrfToken, notice });
}

// A clean same-host path: starts with a single '/'. Anything else (absolute URL, '//',
// protocol-relative) is rejected rather than silently coerced.
function sameHostPath(raw: string | undefined): string | null {
  if (!raw) return '/';
  return raw.startsWith('/') && !raw.startsWith('//') ? raw : null;
}

// Build the wrapped /auth/drop-bootstrap resume URL and validate it points at a real drop target.
// Returns null when host/next don't resolve — the route then no-ops (no token, neutral notice).
function wrappedNext(host: string, next: string): string | null {
  const wrapped = new URL('/auth/drop-bootstrap', config.APP_ORIGIN);
  wrapped.searchParams.set('host', host);
  wrapped.searchParams.set('next', next);
  return dropTargetFromNext(wrapped.toString()) ? wrapped.toString() : null;
}

export const magicRoutes: FastifyPluginAsync = async (app) => {
  app.post('/auth/magic/request', { config: tightAuthLimit }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const host = (body.host ?? '').toLowerCase();
    const parsed = parseDropHost(host);
    if (!parsed) return reply.code(404).send('not_found');
    const next = sameHostPath(body.next);   // null when the supplied next is not a clean path
    const email = (body.email ?? '').trim();

    const issueAndSend = async () => {
      if (!isLikelyEmail(email)) return;
      if (next === null) return;                            // invalid next → no token, no send
      const resume = wrappedNext(host, next);
      if (!resume) return;                                  // next/host not a valid drop target
      const owner = await findByUsername(parsed.username);
      const drop = owner ? await findByOwnerAndName(owner.id, parsed.dropname) : null;
      if (!drop) return;
      if (!(await canViewByEmail(email, { id: drop.id, ownerId: drop.ownerId, viewMode: drop.viewMode }))) return;
      const { token, created } = await issueMagicToken(email, drop.id, resume);
      if (!created) return;
      const link = new URL('/auth/magic/verify', config.APP_ORIGIN);
      link.searchParams.set('token', token);
      try {
        await getMailer().send({
          to: normaliseEmail(email),
          subject: 'Your sign-in link',
          text: `Sign in to view this drop:\n${link.toString()}\nThis link expires in 15 minutes.`,
          html: `<p><a href="${link.toString()}">Sign in to view this drop</a></p><p>Expires in 15 minutes.</p>`,
        });
        req.log.info({ drop_id: drop.id }, 'magic link sent');
      } catch (e) { req.log.warn({ err: e }, 'magic link send failed'); }
    };
    await issueAndSend();
    return renderInterstitial(reply, { host, next: next ?? '/', notice: NOTICE });
  });

  app.get('/auth/magic/verify', { config: { skipCsrf: true, ...tightAuthLimit } }, async (req, reply) => {
    const token = (req.query as Record<string, string | undefined>).token ?? '';
    if (!TOKEN_SHAPE.test(token)) return reply.code(400).view('magicExpired.ejs', {});
    return reply.view('magicConfirm.ejs', { token });   // does NOT consume
  });

  app.post('/auth/magic/verify', { config: { skipCsrf: true, ...tightAuthLimit } }, async (req, reply) => {
    const origin = req.headers.origin as string | undefined;
    const referer = req.headers.referer as string | undefined;
    if (!requestOriginOk(origin, referer)) return reply.code(403).send('bad_origin');
    const token = ((req.body ?? {}) as Record<string, string | undefined>).token ?? '';
    const claimed = await consumeMagicToken(token);
    if (!claimed) return reply.code(400).view('magicExpired.ejs', {});
    const existing = await findByEmail(claimed.email);
    const user = existing ?? await createViewerUser({ email: claimed.email, name: null, avatarUrl: null });
    return completeViewerLogin(reply, user.id, claimed.next);
  });
};
