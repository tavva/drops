// ABOUTME: GET / on the app host — redirects to /app. Registered only under onAppHost.
import type { FastifyPluginAsync } from 'fastify';

export const rootRoute: FastifyPluginAsync = async (app) => {
  app.get('/', { config: { skipCsrf: true } }, async (_req, reply) => {
    return reply.redirect('/app', 302);
  });
};
