// ABOUTME: GET /app dashboard page — shows the folder tree with per-viewer visibility.
import type { FastifyPluginAsync } from 'fastify';
import { requireCompletedMember } from '@/middleware/auth';
import { renderDashboard } from '@/routes/app/dashboardView';

export const dashboardRoute: FastifyPluginAsync = async (app) => {
  app.get('/app', { preHandler: requireCompletedMember }, async (req, reply) => {
    const query = req.query as { cli_revoked?: string };
    return renderDashboard(req, reply, {
      banner: query.cli_revoked === '1'
        ? { kind: 'info', message: 'CLI access revoked.' }
        : null,
    });
  });
};
