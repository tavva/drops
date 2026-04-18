// ABOUTME: GET /auth/login — starts the Google OAuth flow by redirecting to the authorize endpoint.
// ABOUTME: `state` and `nonce` are stashed in a signed `oauth_state` cookie scoped to /auth.
import { FastifyPluginAsync } from 'fastify';
import { randomBytes } from 'node:crypto';
import { buildAuthUrl } from '@/lib/oauth';
import { signCookie, appCookieOptions } from '@/lib/cookies';
import { config } from '@/config';

export const OAUTH_STATE_COOKIE = 'oauth_state';

export function allowedNext(next: string | undefined): string {
  const fallback = new URL('/app', config.APP_ORIGIN).toString();
  if (!next) return fallback;
  try {
    const u = new URL(next);
    const app = new URL(config.APP_ORIGIN);
    const content = new URL(config.CONTENT_ORIGIN);
    const ok = (u.protocol === app.protocol && u.host === app.host)
      || (u.protocol === content.protocol && u.host === content.host);
    return ok ? u.toString() : fallback;
  } catch { return fallback; }
}

export const loginRoute: FastifyPluginAsync = async (app) => {
  app.get('/auth/login', async (req, reply) => {
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const q = req.query as Record<string, string | undefined>;
    const next = allowedNext(q.next);
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
