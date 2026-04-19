// ABOUTME: GET / — dispatches by host. App host redirects to /app; content host requires a session
// ABOUTME: and renders contentRoot.ejs for signed-in viewers (avoiding a redirect loop into the app).
import type { FastifyPluginAsync } from 'fastify';
import { requireContentSession } from '@/middleware/auth';

export const rootRoute: FastifyPluginAsync = async (app) => {
  app.get('/', { config: { skipCsrf: true } }, async (req, reply) => {
    if (req.hostKind === 'content') {
      const blocked = await requireContentSession(req, reply);
      if (reply.sent) return blocked;
      return reply.view('contentRoot.ejs', { email: req.user!.email });
    }
    return reply.redirect('/app', 302);
  });
};
