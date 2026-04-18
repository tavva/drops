// ABOUTME: Content-host GET /auth/bootstrap — consumes a handoff token, sets the content session cookie,
// ABOUTME: and redirects to a validated `next` URL on either the app or content origin.
import { FastifyPluginAsync } from 'fastify';
import { verifyHandoff } from '@/lib/handoff';
import { getSessionUser } from '@/services/sessions';
import { signCookie, contentCookieOptions } from '@/lib/cookies';
import { CONTENT_SESSION_COOKIE } from '@/middleware/auth';
import { allowedNext } from './login';
import { config } from '@/config';

export const bootstrapRoute: FastifyPluginAsync = async (app) => {
  app.get('/auth/bootstrap', { config: { skipCsrf: true } }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const token = q.token ?? '';
    const result = verifyHandoff(token, config.SESSION_SECRET);
    if (!result.ok) return reply.code(400).send(`bad_token:${result.reason}`);
    const found = await getSessionUser(result.sessionId);
    if (!found) return reply.code(400).send('session_missing');
    reply.setCookie(CONTENT_SESSION_COOKIE, signCookie(result.sessionId, config.SESSION_SECRET), contentCookieOptions({
      maxAge: 30 * 24 * 3600,
    }));
    const next = allowedNext(q.next);
    return reply.redirect(next, 302);
  });
};
