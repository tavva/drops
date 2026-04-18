// ABOUTME: Content-host GET /auth/logout — clears the content session cookie and bounces back to app host.
import { FastifyPluginAsync } from 'fastify';
import { CONTENT_SESSION_COOKIE } from '@/middleware/auth';
import { contentCookieOptions } from '@/lib/cookies';
import { allowedNext } from './login';

export const contentLogoutRoute: FastifyPluginAsync = async (app) => {
  app.get('/auth/logout', { config: { skipCsrf: true } }, async (req, reply) => {
    reply.clearCookie(CONTENT_SESSION_COOKIE, contentCookieOptions());
    const q = req.query as Record<string, string | undefined>;
    return reply.redirect(allowedNext(q.next), 302);
  });
};
