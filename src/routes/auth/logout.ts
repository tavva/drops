// ABOUTME: POST /auth/logout on the app host — deletes the session row and clears the app cookie.
// ABOUTME: Any drop-host cookies the user has are invalidated server-side (their sessionId no longer resolves).
import type { FastifyPluginAsync } from 'fastify';
import { deleteSession } from '@/services/sessions';
import { APP_SESSION_COOKIE } from '@/middleware/auth';
import { appCookieOptions, verifyCookie } from '@/lib/cookies';
import { config } from '@/config';

export const logoutRoute: FastifyPluginAsync = async (app) => {
  app.post('/auth/logout', async (req, reply) => {
    const raw = req.cookies[APP_SESSION_COOKIE];
    if (raw) {
      const sid = verifyCookie(raw, config.SESSION_SECRET);
      if (sid) await deleteSession(sid);
    }
    reply.clearCookie(APP_SESSION_COOKIE, appCookieOptions());
    return reply.redirect(new URL('/auth/goodbye', config.APP_ORIGIN).toString(), 302);
  });

  app.get('/auth/goodbye', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return '<!doctype html><html><body><h1>Signed out</h1><p>You have been signed out.</p></body></html>';
  });
};
