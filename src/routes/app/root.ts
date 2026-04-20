// ABOUTME: GET / — on app host redirects to /app; on content apex returns 404 (no content here post-cutover).
import type { FastifyPluginAsync } from 'fastify';

export const rootRoute: FastifyPluginAsync = async (app) => {
  app.get('/', { config: { skipCsrf: true } }, async (req, reply) => {
    if (req.hostKind === 'app') return reply.redirect('/app', 302);
    return reply.code(404).send('not_found');
  });
};
