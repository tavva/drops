// ABOUTME: GET /app dashboard page — shows the current user's drops and the global feed.
import type { FastifyPluginAsync } from 'fastify';
import { requireCompletedMember } from '@/middleware/auth';
import { listByOwner, listAll } from '@/services/drops';
import { config } from '@/config';
import { formatBytes } from '@/lib/format';

export const dashboardRoute: FastifyPluginAsync = async (app) => {
  app.get('/app', { preHandler: requireCompletedMember }, async (req, reply) => {
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
      formatBytes,
    });
  });
};
