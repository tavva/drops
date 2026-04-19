// ABOUTME: GET / on content origin — minimal "signed in" landing for viewers whose post-login
// ABOUTME: next would otherwise point into the app origin and trigger a redirect loop.
import type { FastifyPluginAsync } from 'fastify';
import { requireContentSession } from '@/middleware/auth';

export const contentRootRoute: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: requireContentSession, config: { skipCsrf: true } }, async (req, reply) => {
    return reply.view('contentRoot.ejs', { email: req.user!.email });
  });
};
