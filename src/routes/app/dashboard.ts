// ABOUTME: GET /app dashboard page — shows the current user's drops and the global feed.
import { FastifyPluginAsync } from 'fastify';
import { requireAppSession } from '@/middleware/auth';
import { listByOwner, listAll } from '@/services/drops';
import { config } from '@/config';

export const dashboardRoute: FastifyPluginAsync = async (app) => {
  app.get('/app', { preHandler: requireAppSession }, async (req, reply) => {
    const user = req.user!;
    const [yourDrops, allDrops] = await Promise.all([
      listByOwner(user.id),
      listAll(25, 0),
    ]);
    return reply.view('dashboard.ejs', {
      user,
      yourDrops,
      allDrops,
      contentOrigin: config.CONTENT_ORIGIN,
      csrfToken: req.csrfToken ?? '',
    });
  });
};
