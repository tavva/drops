// ABOUTME: App-host POST /auth/logout — deletes session, clears cookie, hops to content host for its cookie.
// ABOUTME: Plus a GET /auth/goodbye that renders a simple goodbye page.
import { FastifyPluginAsync } from 'fastify';
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
    const contentLogout = new URL('/auth/logout', config.CONTENT_ORIGIN);
    contentLogout.searchParams.set('next', new URL('/auth/goodbye', config.APP_ORIGIN).toString());
    return reply.redirect(contentLogout.toString(), 302);
  });

  app.get('/auth/goodbye', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return '<!doctype html><html><body><h1>Signed out</h1><p>You have been signed out.</p></body></html>';
  });
};
