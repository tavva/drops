// ABOUTME: GET /auth/login — starts the Google OAuth flow by redirecting to the authorize endpoint.
// ABOUTME: `state` and `nonce` are stashed in a signed `oauth_state` cookie scoped to /auth.
import type { FastifyPluginAsync } from 'fastify';
import { randomBytes } from 'node:crypto';
import { buildAuthUrl } from '@/lib/oauth';
import { signCookie, verifyCookie, appCookieOptions } from '@/lib/cookies';
import { parseDropHost } from '@/lib/dropHost';
import { signHandoff } from '@/lib/handoff';
import { getSessionUser } from '@/services/sessions';
import { findByUsername } from '@/services/users';
import { findByOwnerAndName } from '@/services/drops';
import { canView } from '@/services/permissions';
import { APP_SESSION_COOKIE } from '@/middleware/auth';
import { tightAuthLimit } from '@/middleware/rateLimit';
import { config } from '@/config';

export const OAUTH_STATE_COOKIE = 'oauth_state';

export function allowedNext(next: string | undefined): string {
  const fallback = new URL('/app', config.APP_ORIGIN).toString();
  if (!next) return fallback;
  try {
    const u = new URL(next);
    const app = new URL(config.APP_ORIGIN);
    const content = new URL(config.CONTENT_ORIGIN);
    const sameScheme = u.protocol === content.protocol;
    const matchesApp = u.protocol === app.protocol && u.host === app.host;
    const matchesContent = sameScheme && u.host === content.host;
    const matchesDrop = sameScheme && parseDropHost(u.hostname) !== null;
    return (matchesApp || matchesContent || matchesDrop) ? u.toString() : fallback;
  } catch { return fallback; }
}

interface DropTarget { hostname: string; origin: string; path: string; parsed: { username: string; dropname: string }; }

function dropTargetFromNext(nextUrl: string): DropTarget | null {
  try {
    const u = new URL(nextUrl);
    const parsed = parseDropHost(u.hostname);
    if (!parsed) return null;
    return { hostname: u.hostname.toLowerCase(), origin: u.origin, path: (u.pathname + u.search) || '/', parsed };
  } catch { return null; }
}

export const loginRoute: FastifyPluginAsync = async (app) => {
  app.get('/auth/login', { config: tightAuthLimit }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const next = allowedNext(q.next);

    // Short-circuit: if the caller already has a valid app session and next is a drop URL,
    // skip OAuth entirely and hand off straight to the drop host's bootstrap.
    const raw = req.cookies[APP_SESSION_COOKIE];
    const sid = raw ? verifyCookie(raw, config.SESSION_SECRET) : null;
    if (sid) {
      const found = await getSessionUser(sid);
      const target = dropTargetFromNext(next);
      if (found && target) {
        const owner = await findByUsername(target.parsed.username);
        const drop = owner ? await findByOwnerAndName(owner.id, target.parsed.dropname) : null;
        const allowed = drop ? await canView(
          { id: found.user.id, email: found.user.email },
          { id: drop.id, ownerId: drop.ownerId, viewMode: drop.viewMode },
        ) : false;
        if (allowed) {
          const token = signHandoff(sid, target.hostname, config.SESSION_SECRET, 60);
          const bootstrap = new URL('/auth/bootstrap', target.origin);
          bootstrap.searchParams.set('token', token);
          bootstrap.searchParams.set('next', target.path);
          return reply.redirect(bootstrap.toString(), 302);
        }
      }
    }

    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const payload = JSON.stringify({ state, nonce, next });
    const signed = signCookie(payload, config.SESSION_SECRET);
    reply.setCookie(OAUTH_STATE_COOKIE, signed, appCookieOptions({
      maxAge: 600,
      path: '/auth',
    }));
    const redirectUri = new URL('/auth/callback', config.APP_ORIGIN).toString();
    const url = await buildAuthUrl({ state, nonce, redirectUri });
    return reply.redirect(url, 302);
  });
};
