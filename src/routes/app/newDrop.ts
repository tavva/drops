// ABOUTME: GET /app/drops/new — renders the form for creating a new drop.
import type { FastifyPluginAsync } from 'fastify';
import { requireAppSession } from '@/middleware/auth';

export const newDropRoute: FastifyPluginAsync = async (app) => {
  app.get('/app/drops/new', { preHandler: requireAppSession }, async (req, reply) => {
    return reply.view('newDrop.ejs', { csrfToken: req.csrfToken ?? '' });
  });
};
