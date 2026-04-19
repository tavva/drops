// ABOUTME: GET / redirects visitors to /app so the bare origin lands on the dashboard flow.
import type { FastifyPluginAsync } from 'fastify';

export const rootRoute: FastifyPluginAsync = async (app) => {
  app.get('/', async (_req, reply) => reply.redirect('/app', 302));
};
