// ABOUTME: Magic-link viewer auth — POST /auth/magic/request emails a one-time sign-in link
// ABOUTME: to an eligible address; GET/POST /auth/magic/verify (Task 11) complete the login.
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { parseDropHost, dropTargetFromNext } from '@/lib/dropHost';
import { findByUsername } from '@/services/users';
import { findByOwnerAndName } from '@/services/drops';
import { canViewByEmail } from '@/services/permissions';
import { issueMagicToken } from '@/services/magicLinkTokens';
import { isLikelyEmail, normaliseEmail } from '@/lib/email';
import { issueCsrfToken, CSRF_COOKIE, CSRF_ANON_COOKIE, newAnonCsrfId } from '@/lib/csrf';
import { signCookie, appCookieOptions } from '@/lib/cookies';
import { getMailer } from '@/lib/mail';
import { tightAuthLimit } from '@/middleware/rateLimit';
import { config } from '@/config';

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
};
